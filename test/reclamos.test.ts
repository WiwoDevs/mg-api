import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const CLAVE = 'clave-de-prueba-suficientemente-larga-0123456789';
const carpetaTemporal = mkdtempSync(join(tmpdir(), 'mgapi-test-'));

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = CLAVE;
process.env.UPSTREAM_URL = 'https://api-externa.invalido/reclamos';
process.env.ZOHO_CLIENT_ID = 'client-id-de-prueba';
process.env.ZOHO_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.ZOHO_REFRESH_TOKEN = 'refresh-token-de-prueba';
process.env.COLA_ARCHIVO = join(carpetaTemporal, 'cola.sqlite');
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 7).toString('base64');
process.env.COLA_INTERVALO_MS = '3600000';
process.env.LIMITE_POR_MINUTO = '10000';
// Este archivo cubre el modo cerrado: solo la lista blanca vuelve a GHL.
process.env.ZOHO_RESPUESTA_A_GHL = 'filtrada';

const { construirServidor } = await import('../src/app.ts');
const { reiniciarPresupuesto } = await import('../src/upstream/cliente.ts');
const reclamoValido = JSON.parse(readFileSync('test/fixtures/webhook-ghl.json', 'utf8'));

/** Respuesta simulada de la API externa; la sobreescribe cada prueba. */
let respuestaSimulada: Awaited<ReturnType<typeof enviarSimulado>>;
let llamadasAlUpstream = 0;

async function enviarSimulado(): Promise<
  | { ok: true; datos: unknown }
  | { ok: false; reintentable: boolean; detalle: string; codigoZoho?: string }
> {
  llamadasAlUpstream += 1;

  return respuestaSimulada;
}

let app: FastifyInstance;

function pedir(cuerpo: unknown, cabeceras: Record<string, string> = { 'x-mgapi-key': CLAVE }) {
  return app.inject({
    method: 'POST',
    url: '/v1/reclamos',
    headers: { 'content-type': 'application/json', ...cabeceras },
    payload: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
}

before(async () => {
  app = await construirServidor({ enviar: enviarSimulado });
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(carpetaTemporal, { recursive: true, force: true });
});

describe('autenticacion', () => {
  test('sin clave responde 401 y no llama a la API externa', async () => {
    llamadasAlUpstream = 0;
    const respuesta = await pedir(reclamoValido, {});

    assert.equal(respuesta.statusCode, 401);
    assert.deepEqual(respuesta.json(), { error: 'no_autorizado' });
    assert.equal(llamadasAlUpstream, 0);
  });

  test('clave incorrecta responde 401', async () => {
    const respuesta = await pedir(reclamoValido, { 'x-mgapi-key': 'x'.repeat(CLAVE.length) });

    assert.equal(respuesta.statusCode, 401);
  });
});

describe('validacion de entrada', () => {
  test('un campo no declarado se rechaza, no se ignora', async () => {
    const respuesta = await pedir({ ...reclamoValido, campoInesperado: 'algo' });

    assert.equal(respuesta.statusCode, 400);
    assert.equal(respuesta.json().error, 'entrada_invalida');
  });

  test('RUT con digito verificador invalido se rechaza', async () => {
    const respuesta = await pedir({
      ...reclamoValido,
      contacto: { ...reclamoValido.contacto, rut: '12.345.678-9' },
    });

    assert.equal(respuesta.statusCode, 400);
    assert.ok(respuesta.json().campos.some((campo: { campo: string }) => campo.campo === 'rut'));
  });

  test('patente con formato invalido se rechaza', async () => {
    const respuesta = await pedir({
      ...reclamoValido,
      vehiculo: { ...reclamoValido.vehiculo, patente_del_vehculo: '123456' },
    });

    assert.equal(respuesta.statusCode, 400);
  });

  test('un cuerpo sobre 32 KB se rechaza con 413', async () => {
    const respuesta = await pedir({
      ...reclamoValido,
      reclamo: { ...reclamoValido.reclamo, 'descripcin_del_problema': 'a'.repeat(40_000) },
    });

    assert.equal(respuesta.statusCode, 413);
  });

  test('el error de JSON invalido no devuelve el cuerpo recibido', async () => {
    const respuesta = await pedir('{"rut": "12.345.678-5", roto');

    assert.equal(respuesta.statusCode, 400);
    assert.ok(!respuesta.body.includes('12.345.678'));
  });
});

describe('reenvio a la API externa', () => {
  test('con ZOHO_RESPUESTA_A_GHL=filtrada solo vuelve la lista blanca', async () => {
    reiniciarPresupuesto();
    respuestaSimulada = {
      ok: true,
      datos: {
        folio: 'F-123',
        estado: 'ingresado',
        rutTitular: '12.345.678-5',
        tokenInterno: 'secreto-de-la-api-externa',
      },
    };

    const respuesta = await pedir(reclamoValido);
    const cuerpo = respuesta.json();

    assert.equal(respuesta.statusCode, 200);
    assert.equal(cuerpo.estado, 'recibido');
    // Lo que resolvio mgAPI va aparte de lo que contesto Zoho.
    assert.equal(cuerpo.mgapi.estado, 'procesado');
    assert.equal(cuerpo.mgapi.interpretado.serie, 'MG4');
    assert.equal(cuerpo.zoho.estado, 'aceptado');
    assert.equal(cuerpo.zoho.detalle.folio, 'F-123');
    assert.equal(cuerpo.zoho.detalle.estado, 'ingresado');
    assert.ok(!('rutTitular' in cuerpo.zoho.detalle), 'no debe filtrar campos ajenos a la lista blanca');
    assert.ok(!respuesta.body.includes('secreto-de-la-api-externa'));
    assert.ok(!('respuesta' in cuerpo.zoho), 'en modo filtrada no se reenvia la respuesta');
  });

  test('un error 500 de la API externa no aparece textual en la respuesta', async () => {
    respuestaSimulada = {
      ok: false,
      reintentable: false,
      detalle: 'estado 500 detalle interno ajeno',
      codigoZoho: 'INVALID_DATA',
    };

    const respuesta = await pedir(reclamoValido);
    const cuerpo = respuesta.json();

    assert.equal(respuesta.statusCode, 422);
    assert.equal(cuerpo.error, 'reclamo_rechazado');
    // GHL sabe que el problema fue de Zoho, no nuestro.
    assert.equal(cuerpo.mgapi.estado, 'procesado');
    assert.equal(cuerpo.zoho.estado, 'rechazado');
    assert.equal(cuerpo.zoho.codigo, 'INVALID_DATA');
    assert.ok(!respuesta.body.includes('detalle interno ajeno'));
  });
});

describe('cola cifrada', () => {
  test('con la API externa caida responde 202 y encola el reclamo cifrado', async () => {
    const pendientesAntes = app.cola.pendientes();

    respuestaSimulada = { ok: false, reintentable: true, detalle: 'red: TimeoutError' };

    const respuesta = await pedir(reclamoValido);

    assert.equal(respuesta.statusCode, 202);
    assert.equal(respuesta.json().estado, 'encolado');
    assert.equal(app.cola.pendientes(), pendientesAntes + 1);

    const enDisco = readdirSync(carpetaTemporal)
      .map((archivo) => readFileSync(join(carpetaTemporal, archivo)).toString('latin1'))
      .join('');

    assert.ok(!enDisco.includes('Juan Perez Soto'), 'el nombre no puede quedar en claro en disco');
    assert.ok(!enDisco.includes('BCDF12'), 'la patente no puede quedar en claro en disco');
  });

  test('cuando la API externa vuelve, el reclamo se entrega y se borra de la cola', async () => {
    respuestaSimulada = { ok: true, datos: { folio: 'F-456' } };

    await app.cola.procesarPendientes(enviarSimulado);

    assert.equal(app.cola.pendientes(), 0);
  });

  test('un rechazo definitivo manda el reclamo a la cola muerta', async () => {
    const { entorno } = await import('../src/env.ts');
    const idPrueba = 'prueba-cola-muerta';

    app.cola.encolar(reclamoValido, idPrueba);
    respuestaSimulada = { ok: false, reintentable: false, detalle: 'estado 400' };

    await app.cola.procesarPendientes(enviarSimulado);

    assert.equal(app.cola.pendientes(), 0);
    assert.equal(app.cola.muertos(), 1);
    assert.ok(entorno.COLA_RETENCION_MUERTOS_DIAS > 0);
  });
});

describe('salud', () => {
  test('responde sin necesitar autenticacion', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/salud' });

    assert.equal(respuesta.statusCode, 200);
    assert.equal(respuesta.json().estado, 'ok');
  });
});
