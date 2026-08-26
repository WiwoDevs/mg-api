import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const CLAVE = 'clave-de-prueba-suficientemente-larga-0123456789';
const carpetaTemporal = mkdtempSync(join(tmpdir(), 'mgapi-respuesta-'));

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = CLAVE;
process.env.UPSTREAM_URL = 'https://www.zohoapis.com/crm/v7/functions/x/actions/execute';
process.env.ZOHO_CLIENT_ID = 'client-id-de-prueba';
process.env.ZOHO_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.ZOHO_REFRESH_TOKEN = 'refresh-token-de-prueba';
process.env.COLA_ARCHIVO = join(carpetaTemporal, 'cola.sqlite');
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 6).toString('base64');
process.env.COLA_INTERVALO_MS = '3600000';
process.env.LIMITE_POR_MINUTO = '10000';

const { construirServidor } = await import('../src/app.ts');
const { reiniciarPresupuesto } = await import('../src/upstream/cliente.ts');
const { interpretarRespuestaZoho } = await import('../src/upstream/zoho.ts');
const payload = JSON.parse(readFileSync('test/fixtures/webhook-ghl.json', 'utf8'));

type Resultado =
  | { ok: true; datos: unknown }
  | {
      ok: false;
      reintentable: boolean;
      detalle: string;
      codigoZoho?: string;
      datosZoho?: unknown;
    };

let respuestaSimulada: Resultado;

async function enviarSimulado(): Promise<Resultado> {
  return respuestaSimulada;
}

let app: FastifyInstance;

function pedir() {
  return app.inject({
    method: 'POST',
    url: '/v1/reclamos',
    headers: { 'content-type': 'application/json', 'x-mgapi-key': CLAVE },
    payload: JSON.stringify(payload),
  });
}

before(async () => {
  app = await construirServidor({ enviar: enviarSimulado });
  await app.ready();
});

beforeEach(() => {
  reiniciarPresupuesto();
});

after(async () => {
  await app.close();
  rmSync(carpetaTemporal, { recursive: true, force: true });
});

describe('lectura de la respuesta de Zoho', () => {
  test('saca el resultado de details.output cuando viene como texto JSON', () => {
    const leida = interpretarRespuestaZoho({
      code: 'success',
      details: { output: '{"folio":"F-777","estado":"abierto","interno":"no-sale"}' },
    });

    assert.equal(leida.codigo, 'success');
    assert.equal(leida.detalle.folio, 'F-777');
    assert.equal(leida.detalle.estado, 'abierto');
    assert.ok(!('interno' in leida.detalle), 'la lista blanca sigue mandando');
  });

  test('tambien lo lee si viene ya como objeto', () => {
    const leida = interpretarRespuestaZoho({
      code: 'success',
      details: { output: { folio: 'F-888' } },
    });

    assert.equal(leida.detalle.folio, 'F-888');
  });

  test('una salida en texto plano no rompe nada', () => {
    const leida = interpretarRespuestaZoho({ code: 'success', details: { output: 'listo' } });

    assert.equal(leida.codigo, 'success');
    assert.deepEqual(leida.detalle, {});
  });

  test('si la funcion no usa details.output se busca en la raiz', () => {
    const leida = interpretarRespuestaZoho({ folio: 'F-999' });

    assert.equal(leida.codigo, 'sin_codigo');
    assert.equal(leida.detalle.folio, 'F-999');
  });
});

describe('quien hizo que', () => {
  test('Zoho acepta: mgAPI procesado y Zoho aceptado', async () => {
    respuestaSimulada = {
      ok: true,
      datos: { code: 'success', details: { output: '{"folio":"F-1"}' } },
    };

    const cuerpo = (await pedir()).json();

    assert.equal(cuerpo.mgapi.estado, 'procesado');
    assert.deepEqual(cuerpo.mgapi.interpretado, {
      serie: 'MG4',
      variante: 'MG 4 XPOWER',
      concesionario: 'Bruno Fritsch',
      sucursal: 'LA FLORIDA',
    });
    assert.equal(cuerpo.zoho.estado, 'aceptado');
    assert.equal(cuerpo.zoho.codigo, 'success');
    assert.equal(cuerpo.zoho.detalle.folio, 'F-1');
  });

  test('Zoho caido: mgAPI procesado igual, y se avisa que se reintenta', async () => {
    respuestaSimulada = { ok: false, reintentable: true, detalle: 'red: TimeoutError' };

    const respuesta = await pedir();
    const cuerpo = respuesta.json();

    assert.equal(respuesta.statusCode, 202);
    // Lo importante: GHL sabe que el reclamo estaba bien, el problema fue Zoho.
    assert.equal(cuerpo.mgapi.estado, 'procesado');
    assert.equal(cuerpo.mgapi.interpretado.serie, 'MG4');
    assert.equal(cuerpo.zoho.estado, 'no_disponible');
  });

  test('Zoho rechaza: se devuelve su codigo, no su mensaje', async () => {
    respuestaSimulada = {
      ok: false,
      reintentable: false,
      detalle: "Zoho respondio codigo \"INVALID_DATA\"",
      codigoZoho: 'INVALID_DATA',
    };

    const respuesta = await pedir();
    const cuerpo = respuesta.json();

    assert.equal(respuesta.statusCode, 422);
    assert.equal(cuerpo.mgapi.estado, 'procesado');
    assert.equal(cuerpo.zoho.estado, 'rechazado');
    assert.equal(cuerpo.zoho.codigo, 'INVALID_DATA');
  });

  test('el reclamo no se entiende: no hay bloque de Zoho porque nunca se llamo', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/v1/reclamos',
      headers: { 'content-type': 'application/json', 'x-mgapi-key': CLAVE },
      payload: JSON.stringify({
        ...payload,
        vehiculo: { ...payload.vehiculo, modelo_del_auto: 'MG 99' },
      }),
    });
    const cuerpo = respuesta.json();

    assert.equal(respuesta.statusCode, 400);
    assert.equal(cuerpo.error, 'entrada_invalida');
    assert.ok(!('zoho' in cuerpo), 'no se llamo a Zoho, no se habla por el');
  });

  test('la respuesta de Zoho se reenvia tal cual a GHL', async () => {
    const deZoho = { code: 'success', details: { output: '{"folio":"F-1"}' }, idCaso: '99' };

    respuestaSimulada = { ok: true, datos: deZoho };

    const cuerpo = (await pedir()).json();

    // Ademas del detalle filtrado, GHL recibe lo que contesto Zoho sin recortar.
    assert.deepEqual(cuerpo.zoho.respuesta, deZoho);
    assert.equal(cuerpo.zoho.detalle.folio, 'F-1');
  });

  test('un rechazo tambien reenvia lo que dijo Zoho', async () => {
    const deZoho = {
      code: 'INVALID_DATA',
      details: {},
      message: "Value is empty and 'get' function cannot be applied",
    };

    respuestaSimulada = {
      ok: false,
      reintentable: false,
      detalle: 'Zoho respondio codigo "INVALID_DATA"',
      codigoZoho: 'INVALID_DATA',
      datosZoho: deZoho,
    };

    const respuesta = await pedir();
    const cuerpo = respuesta.json();

    assert.equal(respuesta.statusCode, 422);
    // Es el caso donde mas sirve: explica por que Zoho no acepto el reclamo.
    assert.deepEqual(cuerpo.zoho.respuesta, deZoho);
  });
});
