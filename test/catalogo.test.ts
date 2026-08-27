import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buscarConcesionario,
  buscarSerie,
  buscarSucursal,
  buscarVariante,
  catalogo,
} from '../src/catalogo/catalogo.ts';
import { advertencias, esquemaReclamo, resolverCatalogo } from '../src/schemas/reclamo.ts';
import { mapearAZoho } from '../src/upstream/zoho.ts';

const reclamoValido = JSON.parse(readFileSync('test/fixtures/reclamo-valido.json', 'utf8'));

/**
 * Valida y resuelve un reclamo en un paso, como hace la ruta.
 * Falla la prueba si el formato es invalido, para que el error se lea claro.
 */
function procesar(entrada: unknown) {
  const forma = esquemaReclamo.safeParse(entrada);

  assert.ok(forma.success, `formato invalido: ${forma.error?.issues.map((i) => i.path.join('.'))}`);

  return resolverCatalogo(forma.data);
}

/** Igual que procesar(), pero para los casos donde se espera que el formato falle. */
function erroresDeFormato(entrada: unknown): string[] {
  const forma = esquemaReclamo.safeParse(entrada);

  return forma.success ? [] : forma.error.issues.map((issue) => issue.path.join('.'));
}

describe('catalogo', () => {
  test('el catalogo trae las series y concesionarios esperados', () => {
    assert.equal(catalogo.modelos.length, 17);
    assert.equal(catalogo.concesionarios.length, 14);
  });

  test('Circulo Autos ya no existe: la planilla lo marca para eliminar', () => {
    assert.equal(buscarConcesionario('Circulo Autos'), undefined);
    assert.equal(buscarConcesionario('CIRCULO'), undefined);
  });

  test('Italmotors si existe: la planilla lo marca para agregar', () => {
    const italmotors = buscarConcesionario('Italmotors');

    assert.ok(italmotors);
    assert.deepEqual(italmotors.sucursales, ['LINARES', 'TALCA']);
  });

  test('la busqueda tolera espacios, guiones y mayusculas', () => {
    for (const escrito of ['MG ZS', 'mgzs', 'MG-ZS', 'mg zs']) {
      assert.equal(buscarSerie(escrito)?.serie, 'MGZS', `fallo con ${escrito}`);
    }
  });

  test('las etiquetas del formulario resuelven aunque la planilla las nombre distinto', () => {
    // La planilla usa formato interno y el formulario muestra la etiqueta con
    // espacios. Sin el puente por el campo de GHL, estos dos se rechazaban.
    assert.equal(buscarSerie('MG ZS EV')?.serie, 'ZSEV');
    assert.equal(buscarSerie('MG MARVEL R')?.serie, 'MARVELR');
  });

  test('las doce etiquetas del formulario resuelven', () => {
    const etiquetas = [
      'MG3', 'MG4', 'MG5', 'MG HS', 'MG GT', 'MG ZS',
      'MG ZX', 'MG One', 'MG RX5', 'MG RX9', 'MG MARVEL R', 'MG ZS EV',
    ];

    for (const etiqueta of etiquetas) {
      assert.ok(buscarSerie(etiqueta), `no resuelve ${etiqueta}`);
    }
  });

  test('MG ZS y MG ZS EV siguen siendo series distintas', () => {
    assert.equal(buscarSerie('MG ZS')?.serie, 'MGZS');
    assert.equal(buscarSerie('MG ZS EV')?.serie, 'ZSEV');
  });

  test('una variante se resuelve por coincidencia parcial cuando es unica', () => {
    const mg4 = buscarSerie('MG4');

    assert.ok(mg4);
    assert.equal(buscarVariante(mg4, 'XPOWER'), 'MG 4 XPOWER');
  });

  test('una variante ambigua no se adivina', () => {
    const mgzs = buscarSerie('MGZS');

    assert.ok(mgzs);
    // "MT COM" aparece en mas de una variante de la serie: elegir seria adivinar.
    assert.equal(buscarVariante(mgzs, 'COM'), undefined);
  });

  test('una sucursal de otro concesionario no se acepta', () => {
    const bruno = buscarConcesionario('Bruno Fritsch');

    assert.ok(bruno);
    assert.equal(buscarSucursal(bruno, 'PUNTA ARENAS'), undefined, 'esa es de Sociedad Real');
  });
});

describe('validacion contra el catalogo', () => {
  test('el reclamo de ejemplo pasa y queda con los valores canonicos', () => {
    const resultado = procesar(reclamoValido);

    assert.equal(resultado.reclamo.vehiculo.serie, 'MG4');
    assert.equal(resultado.reclamo.vehiculo.variante, 'MG 4 XPOWER');
    assert.equal(resultado.reclamo.concesionario.nombre, 'Bruno Fritsch');
  });

  test('una serie fuera del catalogo pasa tal cual, con aviso', () => {
    // El formulario manda: si ofrece la opcion, es legitima y el catalogo es
    // el que esta viejo. Perder el reclamo por esa diferencia es peor.
    const resultado = procesar({ ...reclamoValido, vehiculo: { ...reclamoValido.vehiculo, serie: 'MG 99' } });

    assert.equal(resultado.reclamo.vehiculo.serie, 'MG 99', 'viaja sin canonizar');
    assert.ok(resultado.avisos.some((a) => a.includes('MG 99')));
  });

  test('una variante de otra serie pasa tal cual, con aviso', () => {
    const resultado = procesar({
      ...reclamoValido,
      vehiculo: { ...reclamoValido.vehiculo, serie: 'MG3', variante: 'MG 4 XPOWER' },
    });

    assert.equal(resultado.reclamo.vehiculo.variante, 'MG 4 XPOWER');
    assert.ok(resultado.avisos.some((a) => a.includes('MG3')));
  });

  test('una sucursal de otro concesionario pasa tal cual, con aviso', () => {
    const resultado = procesar({
      ...reclamoValido,
      concesionario: { nombre: 'Bruno Fritsch', sucursal: 'PUNTA ARENAS' },
    });

    assert.equal(resultado.reclamo.concesionario.sucursal, 'PUNTA ARENAS');
    assert.ok(resultado.avisos.some((a) => a.includes('PUNTA ARENAS')));
  });

  test('lo que si esta en el catalogo se sigue canonizando', () => {
    const resultado = procesar({
      ...reclamoValido,
      concesionario: { nombre: 'BRUNO FRITSCH', sucursal: 'La Florida - Vicuña Mackenna 9085' },
    });

    assert.equal(resultado.reclamo.concesionario.nombre, 'Bruno Fritsch');
    assert.equal(resultado.reclamo.concesionario.sucursal, 'LA FLORIDA');
    assert.deepEqual(resultado.avisos, [], 'sin avisos cuando todo calza');
  });

  test('un VIN con letras prohibidas entra igual, con aviso', () => {
    const resultado = procesar({
      ...reclamoValido,
      vehiculo: { ...reclamoValido.vehiculo, vin: 'LSJA24U97PN12345O' },
    });

    assert.ok(advertencias(resultado.reclamo).some((a) => a.includes('VIN')));
  });

  test('un campo obligatorio vacio si detiene el reclamo', () => {
    assert.deepEqual(erroresDeFormato({ ...reclamoValido, motivo: '' }), ['motivo']);
  });
});

describe('traduccion a Zoho', () => {
  test('los campos opcionales ausentes no viajan vacios', () => {
    const sinOpcionales = { ...reclamoValido, vehiculo: { ...reclamoValido.vehiculo } };

    delete sinOpcionales.vehiculo.vin;
    delete sinOpcionales.vehiculo.kilometraje;
    delete sinOpcionales.ghlContactId;

    const zoho = mapearAZoho(procesar(sinOpcionales).reclamo);

    assert.ok(!('cf_vin' in zoho));
    assert.ok(!('cf_mileage' in zoho));
    assert.ok(!('cf_website_id' in zoho));
    assert.equal(zoho.cf_series, 'MG4');
  });
});
