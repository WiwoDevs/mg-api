import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const CLAVE = 'clave-de-prueba-suficientemente-larga-0123456789';
const carpetaTemporal = mkdtempSync(join(tmpdir(), 'mgapi-captura-'));

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = CLAVE;
process.env.UPSTREAM_URL = 'https://api-externa.invalido/reclamos';
process.env.UPSTREAM_TOKEN = 'token-de-prueba';
process.env.COLA_ARCHIVO = join(carpetaTemporal, 'cola.sqlite');
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 5).toString('base64');
process.env.COLA_INTERVALO_MS = '3600000';
process.env.LIMITE_POR_MINUTO = '10000';
process.env.MODO_CAPTURA = 'true';
process.env.CAPTURA_MAXIMA = '3';

const { construirServidor } = await import('../src/app.ts');
const { reiniciarCapturas } = await import('../src/routes/captura.ts');

async function enviarSimulado(): Promise<{ ok: true; datos: unknown }> {
  return { ok: true, datos: {} };
}

let app: FastifyInstance;

before(async () => {
  app = await construirServidor({ enviar: enviarSimulado });
  await app.ready();
  reiniciarCapturas();
});

after(async () => {
  await app.close();
  rmSync(carpetaTemporal, { recursive: true, force: true });
});

describe('modo captura', () => {
  test('sin clave devuelve el cuerpo y el origen tal como llegaron', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/captura',
      remoteAddress: '198.51.100.42',
      headers: { 'content-type': 'application/json', 'x-ghl-evento': 'contacto' },
      payload: JSON.stringify({ contact_id: 'abc', first_name: 'Juan' }),
    });
    assert.equal(respuesta.statusCode, 200);
    // El cuerpo devuelto es exactamente el JSON que llego, sin envoltorio.
    assert.deepEqual(respuesta.json(), { contact_id: 'abc', first_name: 'Juan' });
    // El origen viaja en cabeceras, para no ensuciar el cuerpo.
    assert.equal(respuesta.headers['x-captura-ip'], '198.51.100.42');
    assert.equal(respuesta.headers['x-captura-numero'], '1');
  });

  test('acepta un cuerpo que no es JSON y lo conserva crudo', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/captura',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'first_name=Juan&phone=%2B56912345678',
    });
    assert.equal(respuesta.statusCode, 200);
    // No era JSON: se devuelve el texto crudo tal cual llego.
    assert.equal(respuesta.body, 'first_name=Juan&phone=%2B56912345678');
  });

  test('nunca devuelve la clave propia aunque el llamante la mande', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/captura',
      headers: { 'content-type': 'application/json', 'x-mgapi-key': CLAVE },
      payload: '{"hola":1}',
    });

    assert.ok(!respuesta.body.includes(CLAVE), 'la clave no vuelve en el cuerpo');

    const guardadas = await app.inject({
      method: 'GET',
      url: '/v1/capturas',
      headers: { 'x-mgapi-key': CLAVE },
    });
    const ultima = guardadas.json().capturas.at(-1);

    assert.equal(ultima.cabeceras['x-mgapi-key'], '[oculto]', 'tampoco queda guardada');
  });

  test('se apaga solo al llegar al maximo de capturas', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/captura',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    assert.equal(respuesta.statusCode, 410);
    assert.equal(respuesta.json().error, 'captura_agotada');
  });

  test('releer las capturas si exige la clave', async () => {
    const sinClave = await app.inject({ method: 'GET', url: '/v1/capturas' });

    assert.equal(sinClave.statusCode, 401);

    const conClave = await app.inject({
      method: 'GET',
      url: '/v1/capturas',
      headers: { 'x-mgapi-key': CLAVE },
    });

    assert.equal(conClave.statusCode, 200);
    assert.equal(conClave.json().total, 3);
  });

  test('el endpoint real sigue exigiendo clave con el modo captura encendido', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/reclamos',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    assert.equal(respuesta.statusCode, 401);
  });

  test('el endpoint real sigue rechazando un tipo de contenido que no sea JSON', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/reclamos',
      headers: { 'content-type': 'text/plain', 'x-mgapi-key': CLAVE },
      payload: 'hola',
    });

    assert.equal(respuesta.statusCode, 415, 'el parser abierto no debe escaparse a /v1/reclamos');
  });
});
