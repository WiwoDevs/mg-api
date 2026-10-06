import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const CLAVE = 'clave-de-prueba-suficientemente-larga-0123456789';
const carpetaTemporal = mkdtempSync(join(tmpdir(), 'mgapi-ejec-'));

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = CLAVE;
process.env.COLA_ARCHIVO = join(carpetaTemporal, 'cola.sqlite');
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 12).toString('base64');
process.env.COLA_INTERVALO_MS = '3600000';
process.env.LIMITE_POR_MINUTO = '10000';
process.env.UPSTREAM_ACTIVO = 'false';

const { construirServidor } = await import('../src/app.ts');
const payload = JSON.parse(readFileSync('test/fixtures/webhook-ghl.json', 'utf8'));

let app: FastifyInstance;

function enviar(cuerpo: unknown, cabeceras: Record<string, string> = { 'x-mgapi-key': CLAVE }) {
  return app.inject({
    method: 'POST',
    url: '/v1/reclamos',
    headers: { 'content-type': 'application/json', ...cabeceras },
    payload: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
}

function leer(consulta = '', cabeceras: Record<string, string> = { 'x-mgapi-key': CLAVE }) {
  return app.inject({ method: 'GET', url: `/v1/ejecuciones${consulta}`, headers: cabeceras });
}

before(async () => {
  app = await construirServidor();
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(carpetaTemporal, { recursive: true, force: true });
});

describe('bitacora de ejecuciones', () => {
  test('un reclamo valido queda anotado como exito', async () => {
    assert.equal((await enviar(payload)).statusCode, 200);

    const ultima = (await leer()).json().ejecuciones[0];

    assert.equal(ultima.resultado, 'simulado');
    assert.equal(ultima.http, 200);
    assert.ok(ultima.idCorrelacion);
    assert.ok(ultima.recibidoEn);
  });

  test('una entrada invalida queda anotada con los campos que fallaron', async () => {
    await enviar({ contacto: { first_name: 'Juan' } });

    const ultima = (await leer()).json().ejecuciones[0];

    assert.equal(ultima.resultado, 'entrada_invalida');
    assert.equal(ultima.http, 400);
    assert.ok(Array.isArray(ultima.detalle.campos));
  });

  test('un JSON roto y una clave mala tambien quedan anotados', async () => {
    await enviar('{"roto": ');
    await enviar(payload, { 'x-mgapi-key': 'incorrecta' });

    const [clave, json] = (await leer()).json().ejecuciones;

    assert.equal(clave.resultado, 'no_autorizado');
    assert.equal(json.http, 400);
  });

  test('?fallas=true deja solo lo que no salio bien', async () => {
    const cuerpo = (await leer('?fallas=true')).json();

    assert.ok(cuerpo.ejecuciones.length >= 3);
    assert.ok(cuerpo.ejecuciones.every((e: { resultado: string }) => e.resultado !== 'simulado'));
    assert.ok(cuerpo.resumen.simulado >= 1);
  });

  test('?resultado= filtra por un resultado concreto', async () => {
    const cuerpo = (await leer('?resultado=entrada_invalida')).json();

    assert.ok(cuerpo.ejecuciones.length >= 1);
    assert.ok(cuerpo.ejecuciones.every((e: { resultado: string }) => e.resultado === 'entrada_invalida'));
  });

  test('la lectura exige la clave', async () => {
    assert.equal((await leer('', {})).statusCode, 401);
  });

  test('no guarda datos del reclamante en disco', async () => {
    await enviar({ ...payload, rut_unico: 'RUT-UNICO-PRUEBA-77' });
    await enviar('{"x":"RUT-UNICO-PRUEBA-77"');

    const enDisco = readdirSync(carpetaTemporal)
      .filter((archivo) => archivo.startsWith('ejecuciones'))
      .map((archivo) => readFileSync(join(carpetaTemporal, archivo)).toString('latin1'))
      .join('');

    assert.ok(enDisco.length > 0);
    assert.ok(!enDisco.includes('RUT-UNICO-PRUEBA-77'));
  });
});
