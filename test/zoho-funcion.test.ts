import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.MGAPI_KEY = 'clave-de-prueba-suficientemente-larga-0123456789';
process.env.COLA_CLAVE_CIFRADO = Buffer.alloc(32, 4).toString('base64');
process.env.UPSTREAM_ACTIVO = 'true';
process.env.UPSTREAM_URL =
  'https://www.zohoapis.com/crm/v7/functions/zohodeskcasewebsiteapi/actions/execute';
process.env.ZOHO_CLIENT_ID = 'client-id-de-prueba';
process.env.ZOHO_CLIENT_SECRET = 'client-secret-de-prueba';
process.env.ZOHO_REFRESH_TOKEN = 'refresh-token-de-prueba';

const { enviarReclamo, reiniciarPresupuesto } = await import('../src/upstream/cliente.ts');
const { invalidarCredencial } = await import('../src/upstream/zoho-auth.ts');
const { procesarPayloadGhl } = await import('../src/schemas/ingesta-ghl.ts');
const { buscarConcesionario } = await import('../src/catalogo/catalogo.ts');

const payload = JSON.parse(readFileSync('test/fixtures/webhook-ghl.json', 'utf8'));
const ingesta = procesarPayloadGhl(payload);

if (!ingesta.ok) throw new Error('el fixture deberia ser valido');

const reclamo = ingesta.reclamo;
const fetchOriginal = globalThis.fetch;

let urlLlamada = '';
let cuerpoLlamada = '';
/** Cuerpo con el que responde el doble de la funcion de Zoho. */
let respuestaFuncion: unknown = { code: 'success', details: { output: '{"folio":"F-1"}' } };

beforeEach(() => {
  urlLlamada = '';
  cuerpoLlamada = '';
  respuestaFuncion = { code: 'success', details: { output: '{"folio":"F-1"}' } };
  invalidarCredencial();
  reiniciarPresupuesto();

  globalThis.fetch = ((entrada: string | URL | Request, opciones?: RequestInit) => {
    const url = String(entrada);

    if (url.includes('/oauth/v2/token')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'token-falso',
            api_domain: 'https://www.zohoapis.com',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }

    urlLlamada = url;
    cuerpoLlamada = String(opciones?.body ?? '');

    return Promise.resolve(
      new Response(JSON.stringify(respuestaFuncion), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe('llamada a la funcion de Zoho', () => {
  test('el caso viaja como argumento, no como cuerpo', async () => {
    await enviarReclamo(reclamo, 'correlacion-1');

    const url = new URL(urlLlamada);
    const caso = url.searchParams.get('case');

    assert.ok(caso, 'el argumento case tiene que ir en la URL');

    // Es lo que fallaba antes: el argumento llegaba vacio y la funcion hacia
    // get() sobre nada.
    const contenido = JSON.parse(caso);

    assert.equal(contenido.cf_series, 'MG4');
    assert.equal(contenido.cf_model, 'MG 4 XPOWER');
    assert.equal(contenido.cf_id_number, '123456785');
  });

  test('manda auth_type=oauth', async () => {
    await enviarReclamo(reclamo, 'correlacion-2');

    assert.equal(new URL(urlLlamada).searchParams.get('auth_type'), 'oauth');
  });

  test('el cuerpo lleva los datos de contacto', async () => {
    await enviarReclamo(reclamo, 'correlacion-3');

    assert.deepEqual(JSON.parse(cuerpoLlamada), {
      id: 'ghl-abc123',
      name: 'Juan Perez Soto',
      email: 'juan.perez@ejemplo.cl',
      phone: '+56912345678',
    });
  });
});

describe('errores que Zoho informa con codigo de exito', () => {
  test('INVALID_DATA se detecta aunque el estado HTTP sea 200', async () => {
    respuestaFuncion = {
      code: 'INVALID_DATA',
      details: {},
      message: "Value is empty and 'get' function cannot be applied",
    };

    const resultado = await enviarReclamo(reclamo, 'correlacion-4');

    assert.equal(resultado.ok, false, 'un 200 con error no es una entrega');
    assert.equal(resultado.reintentable, false, 'el dato esta mal, reintentar no lo arregla');
  });

  test('el mensaje interno de Zoho no se reenvia', async () => {
    respuestaFuncion = {
      code: 'INVALID_DATA',
      message: "Value is empty and 'get' function cannot be applied",
    };

    const resultado = await enviarReclamo(reclamo, 'correlacion-5');

    assert.equal(resultado.ok, false);
    assert.ok(!resultado.detalle.includes('get'), 'describe su logica interna');
  });

  test('un fallo transitorio si se reintenta', async () => {
    respuestaFuncion = { code: 'INTERNAL_ERROR' };

    const resultado = await enviarReclamo(reclamo, 'correlacion-6');

    assert.equal(resultado.ok, false);
    assert.equal(resultado.reintentable, true, 'queda en cola');
  });

  test('una respuesta sin codigo se acepta', async () => {
    respuestaFuncion = { folio: 'F-2' };

    const resultado = await enviarReclamo(reclamo, 'correlacion-7');

    assert.ok(resultado.ok);
  });
});

describe('opciones del formulario que no estan en el catalogo', () => {
  test('MOVICENTER se resuelve a Pompeyo Carrasco', () => {
    // El desplegable la ofrece como concesionario, pero es una sucursal suya.
    // Sin el alias, quien la elige recibe un rechazo y pierde su reclamo.
    assert.equal(buscarConcesionario('MOVICENTER')?.nombre, 'Pompeyo Carrasco');
  });

  test('CIRCULO AUTOS sigue rechazado: ya no atiende posventa', () => {
    assert.equal(buscarConcesionario('CIRCULO AUTOS'), undefined);
  });

  test('las demas opciones del formulario resuelven', () => {
    const opciones = [
      'ANTIVERO', 'AUTOSUMMIT', 'BRUNO FRITSCH', 'CARMONA', 'CARTONI', 'DIFOR',
      'FORCENTER', 'FRONZA', 'POMPEYO CARRASCO', 'PORTILLO', 'SALAZAR ISRAEL',
      'SERVIMAQ', 'SOCIEDAD REAL',
    ];

    for (const opcion of opciones) {
      assert.ok(buscarConcesionario(opcion), `no resuelve ${opcion}`);
    }
  });
});
