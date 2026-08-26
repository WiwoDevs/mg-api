import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = 'clave-de-prueba-suficientemente-larga-0123456789';
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 2).toString('base64');
process.env.UPSTREAM_ACTIVO = 'true';
process.env.UPSTREAM_URL = 'https://www.zohoapis.com/crm/v2/functions/reclamo/actions/execute';
process.env.ZOHO_CLIENT_ID = 'client-id-de-prueba';
process.env.ZOHO_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.ZOHO_REFRESH_TOKEN = 'refresh-token-de-prueba';

const { enviarReclamo, reiniciarPresupuesto } = await import('../src/upstream/cliente.ts');
const { invalidarCredencial } = await import('../src/upstream/zoho-auth.ts');
const { procesarPayloadGhl } = await import('../src/schemas/ingesta-ghl.ts');

const payload = JSON.parse(readFileSync('test/fixtures/webhook-ghl.json', 'utf8'));
const ingesta = procesarPayloadGhl(payload);

if (!ingesta.ok) throw new Error('el fixture deberia ser valido');

const reclamo = ingesta.reclamo;
const fetchOriginal = globalThis.fetch;

type Llamada = { url: string; autorizacion: string | null };

let llamadasToken = 0;
let llamadasCrm: Llamada[] = [];
/** Estados que devuelve el endpoint del CRM, uno por llamada. */
let estadosCrm: number[] = [];

function esUrlDeToken(url: string): boolean {
  return url.includes('/oauth/v2/token');
}

beforeEach(() => {
  llamadasToken = 0;
  llamadasCrm = [];
  estadosCrm = [200];
  invalidarCredencial();
  reiniciarPresupuesto();

  globalThis.fetch = ((entrada: string | URL | Request, opciones?: RequestInit) => {
    const url = String(entrada);

    if (esUrlDeToken(url)) {
      llamadasToken += 1;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: `token-numero-${llamadasToken}`,
            api_domain: 'https://www.zohoapis.com',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }

    const cabeceras = new Headers(opciones?.headers);

    llamadasCrm.push({ url, autorizacion: cabeceras.get('authorization') });

    const estado = estadosCrm[llamadasCrm.length - 1] ?? 200;

    return Promise.resolve(
      new Response(JSON.stringify({ folio: 'F-1' }), {
        status: estado,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe('llamada a Zoho CRM', () => {
  test('autentica con el prefijo propio de Zoho, no con Bearer', async () => {
    const resultado = await enviarReclamo(reclamo, 'correlacion-1');

    assert.ok(resultado.ok);
    assert.equal(llamadasCrm[0]?.autorizacion, 'Zoho-oauthtoken token-numero-1');
  });

  test('pide el token antes de la primera llamada', async () => {
    await enviarReclamo(reclamo, 'correlacion-2');

    assert.equal(llamadasToken, 1);
    assert.equal(llamadasCrm.length, 1);
  });
});

describe('token rechazado', () => {
  test('un 401 pide un token nuevo y reintenta una vez', async () => {
    estadosCrm = [401, 200];

    const resultado = await enviarReclamo(reclamo, 'correlacion-3');

    assert.ok(resultado.ok, 'el reclamo se entrega en el segundo intento');
    assert.equal(llamadasToken, 2, 'se pidio un token nuevo');
    assert.equal(llamadasCrm.length, 2);
    assert.equal(llamadasCrm[1]?.autorizacion, 'Zoho-oauthtoken token-numero-2');
  });

  test('dos 401 seguidos no reintentan para siempre', async () => {
    estadosCrm = [401, 401, 200];

    const resultado = await enviarReclamo(reclamo, 'correlacion-4');

    assert.equal(resultado.ok, false);
    assert.equal(llamadasCrm.length, 2, 'se corta en el segundo intento');
    assert.equal(resultado.reintentable, true, 'queda en cola, no se descarta');
  });
});

describe('fallos de autenticacion', () => {
  test('una credencial mala no se reintenta y no llama al CRM', async () => {
    globalThis.fetch = ((entrada: string | URL | Request) => {
      const url = String(entrada);

      if (esUrlDeToken(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_client' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      llamadasCrm.push({ url, autorizacion: null });

      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;

    const resultado = await enviarReclamo(reclamo, 'correlacion-5');

    assert.equal(resultado.ok, false);
    assert.equal(resultado.reintentable, false);
    assert.equal(llamadasCrm.length, 0, 'sin token no se manda nada al CRM');
    assert.match(resultado.detalle, /autenticacion/);
  });
});
