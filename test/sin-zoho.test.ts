import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const CLAVE = 'clave-de-prueba-suficientemente-larga-0123456789';
const carpetaTemporal = mkdtempSync(join(tmpdir(), 'mgapi-sin-zoho-'));

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = CLAVE;
process.env.COLA_ARCHIVO = join(carpetaTemporal, 'cola.sqlite');
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 3).toString('base64');
process.env.COLA_INTERVALO_MS = '3600000';
process.env.LIMITE_POR_MINUTO = '10000';
// Sin Zoho: a proposito NO se definen UPSTREAM_URL ni UPSTREAM_TOKEN.
process.env.UPSTREAM_ACTIVO = 'false';
delete process.env.UPSTREAM_URL;
delete process.env.UPSTREAM_TOKEN;

const { construirServidor } = await import('../src/app.ts');
const reclamoValido = JSON.parse(readFileSync('test/fixtures/reclamo-valido.json', 'utf8'));

let app: FastifyInstance;
let huboLlamadaReal = false;

// Si algo intentara salir a internet, este espia lo delataria.
const fetchOriginal = globalThis.fetch;

globalThis.fetch = (async (...argumentos: Parameters<typeof fetch>) => {
  huboLlamadaReal = true;

  return fetchOriginal(...argumentos);
}) as typeof fetch;

before(async () => {
  app = await construirServidor();
  await app.ready();
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  await app.close();
  rmSync(carpetaTemporal, { recursive: true, force: true });
});

describe('modo sin Zoho', () => {
  test('arranca sin credenciales de Zoho', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/salud' });

    assert.equal(respuesta.statusCode, 200);
  });

  test('un reclamo valido se acepta y no sale ninguna peticion al exterior', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/reclamos',
      headers: { 'content-type': 'application/json', 'x-mgapi-key': CLAVE },
      payload: JSON.stringify(reclamoValido),
    });
    const cuerpo = respuesta.json();

    assert.equal(respuesta.statusCode, 200);
    assert.equal(cuerpo.estado, 'simulado');
    assert.equal(huboLlamadaReal, false, 'no debe llamar a Zoho con UPSTREAM_ACTIVO=false');
  });

  test('devuelve el cuerpo de Zoho ya limpio y traducido', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/reclamos',
      headers: { 'content-type': 'application/json', 'x-mgapi-key': CLAVE },
      payload: JSON.stringify({ ...reclamoValido, rut: '12.345.678-5', email: 'JUAN@Ejemplo.CL' }),
    });
    const enviado = respuesta.json().seHabriaEnviado;

    assert.equal(enviado.cf_id_number, '123456785', 'el RUT se normaliza');
    assert.equal(enviado.email, 'juan@ejemplo.cl', 'el email se pasa a minusculas');
    assert.equal(enviado.cf_license_plate, 'BCDF12');
    assert.equal(enviado.cf_mileage, '32500', 'el kilometraje pierde el separador de miles');
    // La serie es el modelo y cf_model es la variante: se estaban confundiendo.
    assert.equal(enviado.cf_series, 'MG4');
    assert.equal(enviado.cf_model, 'MG 4 XPOWER');
    assert.equal(enviado.cf_website_dealer, 'Bruno Fritsch');
    assert.equal(enviado.cf_website_dealer_pos, 'LA FLORIDA');
  });

  test('la validacion sigue rechazando lo invalido', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/reclamos',
      headers: { 'content-type': 'application/json', 'x-mgapi-key': CLAVE },
      payload: JSON.stringify({ ...reclamoValido, rut: '12.345.678-9' }),
    });

    assert.equal(respuesta.statusCode, 400);
  });

  test('la clave sigue siendo obligatoria', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/reclamos',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(reclamoValido),
    });

    assert.equal(respuesta.statusCode, 401);
  });
});
