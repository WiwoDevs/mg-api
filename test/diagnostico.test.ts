import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const CLAVE = 'clave-de-prueba-suficientemente-larga-0123456789';
const carpetaTemporal = mkdtempSync(join(tmpdir(), 'mgapi-diag-'));

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = CLAVE;
process.env.COLA_ARCHIVO = join(carpetaTemporal, 'cola.sqlite');
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 11).toString('base64');
process.env.COLA_INTERVALO_MS = '3600000';
process.env.LIMITE_POR_MINUTO = '10000';
process.env.UPSTREAM_ACTIVO = 'false';
process.env.DIAGNOSTICO_ENTRADA = 'true';
process.env.DIAGNOSTICO_ARCHIVO = join(carpetaTemporal, 'diagnostico.sqlite');
process.env.DIAGNOSTICO_MAXIMO = '3';

const { construirServidor } = await import('../src/app.ts');
const { formaDelCuerpo } = await import('../src/schemas/ingesta-ghl.ts');
const payload = JSON.parse(readFileSync('test/fixtures/webhook-ghl.json', 'utf8'));

let app: FastifyInstance;

function enviar(cuerpo: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/reclamos',
    headers: { 'content-type': 'application/json', 'x-mgapi-key': CLAVE },
    payload: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
}

function leerDiagnostico(cabeceras: Record<string, string> = { 'x-mgapi-key': CLAVE }) {
  return app.inject({ method: 'GET', url: '/v1/diagnostico', headers: cabeceras });
}

before(async () => {
  app = await construirServidor();
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(carpetaTemporal, { recursive: true, force: true });
});

describe('forma del cuerpo', () => {
  test('describe la forma sin exponer un solo valor', () => {
    assert.equal(formaDelCuerpo({ body: 'x' }), 'objeto con claves: body');
    assert.equal(formaDelCuerpo({}), 'objeto vacio');
    assert.equal(formaDelCuerpo(undefined), 'ausente');
    assert.equal(formaDelCuerpo([1, 2]), 'arreglo de 2');
  });

  test('no incluye los valores, solo los nombres', () => {
    const descripcion = formaDelCuerpo({ rut: '12345678-5', email: 'juan@ejemplo.cl' });

    assert.ok(!descripcion.includes('12345678'));
    assert.ok(!descripcion.includes('juan@ejemplo.cl'));
  });
});

describe('registro de rechazos', () => {
  test('el rechazo dice que forma llego', async () => {
    const respuesta = await enviar({ body: 'no-es-json' });

    assert.equal(respuesta.statusCode, 400);
    assert.equal(respuesta.json().forma, 'objeto con claves: body');
  });

  test('lo rechazado queda guardado y se puede leer con la clave', async () => {
    await enviar({ contacto: { first_name: 'Juan' } });

    const respuesta = await leerDiagnostico();
    const cuerpo = respuesta.json();

    assert.equal(respuesta.statusCode, 200);
    assert.ok(cuerpo.total >= 1);

    const ultimo = cuerpo.rechazos[0];

    assert.ok(ultimo.cuerpoRecibido.includes('first_name'), 'guarda el cuerpo tal como llego');
    assert.ok(Array.isArray(ultimo.campos));
    assert.ok(ultimo.recibidoEn);
  });

  test('la lectura exige la clave', async () => {
    assert.equal((await leerDiagnostico({})).statusCode, 401);
  });

  test('un reclamo valido no queda registrado', async () => {
    const antes = leerDiagnostico().then((r) => r.json().total);
    const respuesta = await enviar(payload);

    assert.equal(respuesta.statusCode, 200);
    assert.equal((await leerDiagnostico()).json().total, await antes);
  });

  test('lo guardado esta cifrado en disco', async () => {
    await enviar({ contacto: { rut: 'RUT-DE-PRUEBA-UNICO-99' } });

    const enDisco = readdirSync(carpetaTemporal)
      .filter((archivo) => archivo.startsWith('diagnostico'))
      .map((archivo) => readFileSync(join(carpetaTemporal, archivo)).toString('latin1'))
      .join('');

    assert.ok(!enDisco.includes('RUT-DE-PRUEBA-UNICO-99'), 'el cuerpo no queda en claro');
  });

  test('un JSON roto tambien queda registrado', async () => {
    // Fastify lo rechaza antes de la ruta, asi que el parser es el unico lugar
    // donde se puede dejar constancia. Pasa cuando el texto del usuario trae
    // comillas y rompe el JSON que arma el origen.
    const respuesta = await enviar('{"body":"{\"roto\": \"con "comillas" adentro\"}"}');

    assert.equal(respuesta.statusCode, 400);
    assert.equal(respuesta.json().error, 'json_invalido');

    const ultimo = (await leerDiagnostico()).json().rechazos[0];

    assert.ok(ultimo.forma.startsWith('JSON invalido'));
    assert.ok(ultimo.cuerpoRecibido.includes('comillas'));
  });

  test('no se acumula mas alla del maximo', async () => {
    for (let i = 0; i < 5; i += 1) await enviar({ intento: i });

    assert.equal((await leerDiagnostico()).json().total, 3);
  });
});
