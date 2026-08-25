import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { procesarPayloadGhl, slugGhl } from '../src/schemas/ingesta-ghl.ts';
import { mapearAZoho } from '../src/upstream/zoho.ts';

const base = JSON.parse(readFileSync('test/fixtures/webhook-ghl.json', 'utf8'));

/** Copia del payload con un grupo o campo cambiado, sin tocar el original. */
function conCambios(cambios: Record<string, unknown>): unknown {
  return structuredClone({ ...base, ...cambios });
}

function procesar(payload: unknown) {
  const resultado = procesarPayloadGhl(payload);

  return resultado.ok
    ? { ok: true as const, zoho: mapearAZoho(resultado.reclamo) }
    : { ok: false as const, campos: resultado.errores.map((e) => e.campo) };
}

describe('slug de GHL', () => {
  test('elimina los caracteres acentuados en vez de transcribirlos', () => {
    // Es lo que hace GHL: "año" no produce "ano", produce "ao".
    assert.equal(slugGhl('año del vehículo'), 'ao_del_vehculo');
    assert.equal(slugGhl('descripción del problema'), 'descripcin_del_problema');
    assert.equal(slugGhl('Círculo Autos'), 'crculo_autos');
    assert.equal(slugGhl('MG4 XPOWER'), 'mg4_xpower');
    assert.equal(slugGhl('Bruno Fritsch'), 'bruno_fritsch');
    assert.equal(slugGhl('MG ZS EV'), 'mg_zs_ev');
  });
});

describe('seleccion por nombre', () => {
  test('ignora los residuos de reclamos anteriores', () => {
    // El contacto trae mg3 y mg_zs cargados de antes, y una sucursal de otro
    // concesionario. Se declara MG4 y Bruno Fritsch: solo eso debe viajar.
    const resultado = procesar(base);

    assert.ok(resultado.ok, `errores: ${'campos' in resultado ? resultado.campos : ''}`);
    assert.equal(resultado.zoho.cf_series, 'MG4');
    assert.equal(resultado.zoho.cf_model, 'MG 4 XPOWER');
    assert.equal(resultado.zoho.cf_website_dealer, 'Bruno Fritsch');
    assert.equal(resultado.zoho.cf_website_dealer_pos, 'LA FLORIDA');
  });

  test('el payload completo se traduce a los campos de Zoho', () => {
    const resultado = procesar(base);

    assert.ok(resultado.ok);
    assert.deepEqual(resultado.zoho, {
      cf_first_name: 'Juan',
      cf_last_name: 'Perez Soto',
      cf_id_number: '123456785',
      cf_mobile: '+56912345678',
      email: 'juan.perez@ejemplo.cl',
      cf_license_plate: 'BCDF12',
      cf_series: 'MG4',
      cf_model: 'MG 4 XPOWER',
      cf_model_year: '2023',
      cf_website_dealer: 'Bruno Fritsch',
      cf_website_dealer_pos: 'LA FLORIDA',
      description: 'El vehiculo presenta una falla recurrente en el sistema de frenos.',
      cf_vin: 'LSJA24U97PN123456',
      cf_mileage: '32500',
      cf_attachment_url: 'https://ejemplo.cl/adjuntos/abc123.jpg',
      cf_website_id: 'ghl-abc123',
    });
  });

  test('el modelo se reconoce aunque venga escrito distinto', () => {
    const resultado = procesar(
      conCambios({
        vehiculo: { ...base.vehiculo, modelo_del_auto: 'mg 4' },
      }),
    );

    assert.ok(resultado.ok);
    assert.equal(resultado.zoho.cf_series, 'MG4');
  });
});

describe('valores que no cuentan', () => {
  test('un literal sin renderizar se trata como vacio', () => {
    const resultado = procesar(
      conCambios({
        vehiculo: { ...base.vehiculo, modelo_del_auto: 'MG ZS EV' },
      }),
    );

    // mg_zs_ev trae "{{contact.mg_zs_ev}}": no es una variante, es una variable
    // que GHL no reemplazo. Nunca debe llegar a Zoho.
    assert.equal(resultado.ok, false);
    assert.deepEqual(resultado.campos, ['variante_por_modelo.mg_zs_ev']);
  });

  test('los caracteres invisibles se limpian', () => {
    const resultado = procesar(
      conCambios({
        variante_por_modelo: { ...base.variante_por_modelo, mg4: '​MG 4 XPOWER​' },
      }),
    );

    assert.ok(resultado.ok);
    assert.equal(resultado.zoho.cf_model, 'MG 4 XPOWER');
  });

  test('un campo vacio no viaja como cadena vacia', () => {
    const resultado = procesar(
      conCambios({
        vehiculo: { ...base.vehiculo, vin_del_vehculo: '', kilometraje: '' },
      }),
    );

    assert.ok(resultado.ok);
    assert.ok(!('cf_vin' in resultado.zoho));
    assert.ok(!('cf_mileage' in resultado.zoho));
  });
});

describe('campos de transicion', () => {
  test('mg4_xpower sirve de respaldo si mg4 viene vacio', () => {
    const resultado = procesar(
      conCambios({
        variante_por_modelo: {
          ...base.variante_por_modelo,
          mg4: '',
          mg4_xpower: 'MG 4 XPOWER',
        },
      }),
    );

    assert.ok(resultado.ok, 'un reclamo cargado en el campo viejo no se pierde');
    assert.equal(resultado.zoho.cf_model, 'MG 4 XPOWER');
  });

  test('movicenter sirve de respaldo para Pompeyo Carrasco', () => {
    const resultado = procesar(
      conCambios({
        concesionario: { nombre_convesionario: 'Pompeyo Carrasco' },
        sucursal_por_concesionario: {
          ...base.sucursal_por_concesionario,
          pompeyo_carrasco: '',
          movicenter: 'MOVICENTER',
        },
      }),
    );

    assert.ok(resultado.ok);
    assert.equal(resultado.zoho.cf_website_dealer, 'Pompeyo Carrasco');
    assert.equal(resultado.zoho.cf_website_dealer_pos, 'MOVICENTER');
  });
});

describe('rechazos', () => {
  test('sin modelo declarado no se puede elegir variante', () => {
    const resultado = procesar(
      conCambios({ vehiculo: { ...base.vehiculo, modelo_del_auto: '' } }),
    );

    assert.equal(resultado.ok, false);
    assert.deepEqual(resultado.campos, ['vehiculo.modelo_del_auto']);
  });

  test('un modelo sin variante cargada nombra el campo que falta', () => {
    const resultado = procesar(
      conCambios({
        vehiculo: { ...base.vehiculo, modelo_del_auto: 'MG5' },
      }),
    );

    assert.equal(resultado.ok, false);
    assert.deepEqual(resultado.campos, ['variante_por_modelo.mg5']);
  });

  test('un concesionario sin sucursal cargada se rechaza', () => {
    const resultado = procesar(
      conCambios({ concesionario: { nombre_convesionario: 'Servimaq' } }),
    );

    assert.equal(resultado.ok, false);
    assert.deepEqual(resultado.campos, ['sucursal_por_concesionario.servimaq']);
  });

  test('un campo no declarado en un objeto fijo se rechaza', () => {
    const resultado = procesar(
      conCambios({ contacto: { ...base.contacto, campo_inesperado: 'algo' } }),
    );

    assert.equal(resultado.ok, false);
  });

  test('un modelo nuevo en el grupo abierto no rompe el esquema', () => {
    // Si MG suma una serie, GHL puede mandar su campo antes de que exista aqui.
    const resultado = procesar(
      conCambios({
        variante_por_modelo: { ...base.variante_por_modelo, mg6: 'MG 6 1.5T MT COM' },
      }),
    );

    assert.ok(resultado.ok, 'el campo desconocido se ignora, no tumba el reclamo');
    assert.equal(resultado.zoho.cf_series, 'MG4');
  });
});
