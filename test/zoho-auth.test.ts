import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = 'clave-de-prueba-suficientemente-larga-0123456789';
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 1).toString('base64');
process.env.UPSTREAM_ACTIVO = 'true';
process.env.UPSTREAM_URL = 'https://www.zohoapis.com/crm/v2/functions/reclamo/actions/execute';
process.env.ZOHO_CUENTAS_URL = 'https://accounts.zoho.com';
process.env.ZOHO_CLIENT_ID = 'client-id-de-prueba';
process.env.ZOHO_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.ZOHO_REFRESH_TOKEN = 'refresh-token-de-prueba';
process.env.ZOHO_MARGEN_SEGUNDOS = '1';

const { invalidarCredencial, obtenerCredencial } = await import('../src/upstream/zoho-auth.ts');

const fetchOriginal = globalThis.fetch;

/** Peticiones que se hicieron, para contarlas y revisar la URL. */
let llamadas: string[] = [];
/** Respuesta que devuelve el doble de fetch en la proxima llamada. */
let responder: () => Promise<Response>;

function respuestaJson(cuerpo: unknown, estado = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(cuerpo), {
      status: estado,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function tokenValido(expiresIn = 3600) {
  return {
    access_token: 'token-secreto-de-zoho',
    api_domain: 'https://www.zohoapis.com',
    expires_in: expiresIn,
    token_type: 'Bearer',
  };
}

beforeEach(() => {
  llamadas = [];
  invalidarCredencial();
  responder = () => respuestaJson(tokenValido());
  globalThis.fetch = ((entrada: string | URL | Request) => {
    llamadas.push(String(entrada));

    return responder();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe('peticion del token', () => {
  test('manda los cuatro parametros que Zoho exige', async () => {
    const resultado = await obtenerCredencial();

    assert.ok(resultado.ok);
    assert.equal(llamadas.length, 1);

    const url = new URL(llamadas[0] as string);

    assert.equal(url.origin + url.pathname, 'https://accounts.zoho.com/oauth/v2/token');
    assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
    assert.equal(url.searchParams.get('refresh_token'), 'refresh-token-de-prueba');
    assert.equal(url.searchParams.get('client_id'), 'client-id-de-prueba');
    assert.equal(url.searchParams.get('client_secret'), 'client-secret-de-prueba');
  });

  test('devuelve el token y el dominio de la API', async () => {
    const resultado = await obtenerCredencial();

    assert.ok(resultado.ok);
    assert.equal(resultado.credencial.token, 'token-secreto-de-zoho');
    assert.equal(resultado.credencial.apiDomain, 'https://www.zohoapis.com');
  });
});

describe('cache del token', () => {
  test('un token vigente no se vuelve a pedir', async () => {
    await obtenerCredencial();
    await obtenerCredencial();
    await obtenerCredencial();

    assert.equal(llamadas.length, 1, 'tres reclamos, una sola peticion a Zoho');
  });

  test('un token por vencer se renueva antes de usarse', async () => {
    // Dura un segundo y el margen es de un segundo: nace vencido a proposito.
    responder = () => respuestaJson(tokenValido(1));

    await obtenerCredencial();
    await obtenerCredencial();

    assert.equal(llamadas.length, 2, 'no se reutiliza un token que caduca en vuelo');
  });

  test('forzar descarta el token guardado', async () => {
    await obtenerCredencial();
    await obtenerCredencial(true);

    assert.equal(llamadas.length, 2);
  });

  test('varios reclamos a la vez piden un solo token', async () => {
    let resolver: (respuesta: Response) => void = () => {};

    responder = () =>
      new Promise<Response>((cumplir) => {
        resolver = cumplir;
      });

    const pendientes = Promise.all(
      Array.from({ length: 5 }, () => obtenerCredencial()),
    );

    resolver(new Response(JSON.stringify(tokenValido()), { status: 200 }));

    const resultados = await pendientes;

    assert.equal(llamadas.length, 1, 'cinco a la vez, una peticion');
    assert.ok(resultados.every((r) => r.ok));
  });
});

describe('errores de Zoho', () => {
  test('un error de credenciales no se reintenta', async () => {
    // Zoho responde 200 aunque falle: el error viene en el cuerpo.
    responder = () => respuestaJson({ error: 'invalid_client' });

    const resultado = await obtenerCredencial();

    assert.equal(resultado.ok, false);
    assert.equal(resultado.reintentable, false, 'reintentar no arregla una credencial mala');
    assert.match(resultado.detalle, /invalid_client/);
  });

  test('un error desconocido si se reintenta', async () => {
    responder = () => respuestaJson({ error: 'internal_error' });

    const resultado = await obtenerCredencial();

    assert.equal(resultado.ok, false);
    assert.equal(resultado.reintentable, true);
  });

  test('una caida de red se reintenta', async () => {
    responder = () => Promise.reject(new DOMException('timeout', 'TimeoutError'));

    const resultado = await obtenerCredencial();

    assert.equal(resultado.ok, false);
    assert.equal(resultado.reintentable, true);
    assert.match(resultado.detalle, /TimeoutError/);
  });

  test('un fallo no deja guardado un token invalido', async () => {
    responder = () => respuestaJson({ error: 'invalid_client' });
    await obtenerCredencial();

    responder = () => respuestaJson(tokenValido());
    const resultado = await obtenerCredencial();

    assert.ok(resultado.ok, 'el siguiente intento vuelve a pedir');
    assert.equal(llamadas.length, 2);
  });

  test('el detalle del error nunca incluye secretos', async () => {
    responder = () => respuestaJson({ error: 'invalid_client' });

    const resultado = await obtenerCredencial();

    assert.equal(resultado.ok, false);
    for (const secreto of ['refresh-token-de-prueba', 'client-secret-de-prueba']) {
      assert.ok(!resultado.detalle.includes(secreto), `filtro ${secreto}`);
    }
  });
});
