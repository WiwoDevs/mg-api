import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const CLAVE = 'clave-de-prueba-suficientemente-larga-0123456789';
const carpetaTemporal = mkdtempSync(join(tmpdir(), 'mgapi-perimetro-'));

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = CLAVE;
process.env.UPSTREAM_URL = 'https://api-externa.invalido/reclamos';
process.env.UPSTREAM_TOKEN = 'token-de-prueba';
process.env.COLA_ARCHIVO = join(carpetaTemporal, 'cola.sqlite');
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 9).toString('base64');
process.env.COLA_INTERVALO_MS = '3600000';
process.env.LIMITE_POR_MINUTO = '10000';
// Solo estas dos reglas pueden entrar.
process.env.IPS_GHL = '203.0.113.0/24, 198.51.100.7';
process.env.AUTH_FALLOS_MAX = '3';
process.env.AUTH_BLOQUEO_MINUTOS = '15';

const { construirServidor } = await import('../src/app.ts');
const { reiniciarPresupuesto } = await import('../src/upstream/cliente.ts');
const reclamoValido = JSON.parse(readFileSync('test/fixtures/webhook-ghl.json', 'utf8'));

async function enviarSimulado(): Promise<{ ok: true; datos: unknown }> {
  return { ok: true, datos: { folio: 'F-1' } };
}

let app: FastifyInstance;

function pedirDesde(ip: string, cabeceras: Record<string, string> = { 'x-mgapi-key': CLAVE }) {
  return app.inject({
    method: 'POST',
    url: '/v1/reclamos',
    remoteAddress: ip,
    headers: { 'content-type': 'application/json', ...cabeceras },
    payload: JSON.stringify(reclamoValido),
  });
}

before(async () => {
  app = await construirServidor({ enviar: enviarSimulado });
  await app.ready();
  reiniciarPresupuesto();
});

after(async () => {
  await app.close();
  rmSync(carpetaTemporal, { recursive: true, force: true });
});

describe('allowlist de IP', () => {
  test('una IP dentro del bloque CIDR entra', async () => {
    const respuesta = await pedirDesde('203.0.113.55');

    assert.equal(respuesta.statusCode, 200);
  });

  test('una IP declarada de forma exacta entra', async () => {
    const respuesta = await pedirDesde('198.51.100.7');

    assert.equal(respuesta.statusCode, 200);
  });

  test('una IP fuera de la lista se rechaza aunque traiga la clave correcta', async () => {
    const respuesta = await pedirDesde('192.0.2.10');

    assert.equal(respuesta.statusCode, 401);
    assert.deepEqual(respuesta.json(), { error: 'no_autorizado' });
  });

  test('el vecino del bloque permitido queda afuera', async () => {
    const respuesta = await pedirDesde('203.0.114.55');

    assert.equal(respuesta.statusCode, 401);
  });

  test('un X-Forwarded-For falso no permite hacerse pasar por una IP autorizada', async () => {
    const respuesta = await pedirDesde('192.0.2.20', {
      'x-mgapi-key': CLAVE,
      'x-forwarded-for': '203.0.113.55',
    });

    assert.equal(respuesta.statusCode, 401, 'la cabecera solo se cree si viene del proxy interno');
  });
});

describe('bloqueo por fuerza bruta', () => {
  test('tras AUTH_FALLOS_MAX claves incorrectas la IP queda bloqueada', async () => {
    const ip = '203.0.113.200';
    const claveMala = { 'x-mgapi-key': 'x'.repeat(CLAVE.length) };

    for (let intento = 0; intento < 3; intento += 1) {
      const respuesta = await pedirDesde(ip, claveMala);

      assert.equal(respuesta.statusCode, 401);
    }

    // Ya bloqueada: ni siquiera con la clave correcta pasa.
    const bloqueada = await pedirDesde(ip);

    assert.equal(bloqueada.statusCode, 429);
    assert.deepEqual(bloqueada.json(), { error: 'demasiadas_solicitudes' });
  });

  test('un intento correcto limpia el historial de fallos de esa IP', async () => {
    const ip = '203.0.113.201';
    const claveMala = { 'x-mgapi-key': 'x'.repeat(CLAVE.length) };

    await pedirDesde(ip, claveMala);
    await pedirDesde(ip, claveMala);

    assert.equal((await pedirDesde(ip)).statusCode, 200);

    // El contador volvio a cero: dos fallos mas no alcanzan a bloquear.
    await pedirDesde(ip, claveMala);
    await pedirDesde(ip, claveMala);

    assert.equal((await pedirDesde(ip)).statusCode, 200);
  });

  test('el bloqueo de una IP no afecta a las demas', async () => {
    const respuesta = await pedirDesde('203.0.113.77');

    assert.equal(respuesta.statusCode, 200);
  });
});
