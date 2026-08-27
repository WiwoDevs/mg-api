import { mapearRespuesta } from '../schemas/reclamo.ts';
import type { Reclamo } from '../schemas/reclamo.ts';

/**
 * Traduccion del reclamo limpio a los nombres de campo que espera Zoho, y
 * lectura de lo que Zoho contesta.
 *
 * Es el unico lugar donde aparecen los nombres cf_*. Si Zoho renombra un campo,
 * se cambia aqui y nada mas.
 */

/** Lo que Zoho contesto, ya interpretado y filtrado. */
export type RespuestaZoho = {
  codigo: string;
  detalle: Record<string, string | number | boolean>;
};

/**
 * Saca el resultado util de la respuesta de una funcion de Zoho.
 *
 * Zoho envuelve lo que devuelve la funcion en details.output, casi siempre como
 * texto JSON. Ahi adentro esta el folio; el resto de la envoltura no aporta.
 *
 * @param datos cuerpo ya parseado de la respuesta de Zoho
 */
export function interpretarRespuestaZoho(datos: unknown): RespuestaZoho {
  if (typeof datos !== 'object' || datos === null) {
    return { codigo: 'sin_codigo', detalle: {} };
  }

  const cuerpo = datos as { code?: unknown; details?: unknown };
  const codigo = typeof cuerpo.code === 'string' ? cuerpo.code : 'sin_codigo';
  const detalles = cuerpo.details as { output?: unknown } | undefined;
  const salida = detalles?.output;

  let contenido: unknown = salida;

  if (typeof salida === 'string') {
    try {
      contenido = JSON.parse(salida);
    } catch {
      // La funcion devolvio texto plano, no JSON: no hay campos que extraer.
      contenido = undefined;
    }
  }

  // Si la funcion no usa details.output, se busca en la raiz de la respuesta.
  return { codigo, detalle: mapearRespuesta(contenido ?? datos) };
}

export type ReclamoZoho = {
  cf_first_name: string;
  cf_last_name: string;
  cf_id_number: string;
  cf_mobile: string;
  email: string;
  cf_license_plate: string;
  cf_series: string;
  cf_model: string;
  cf_model_year: string;
  cf_website_dealer: string;
  cf_website_dealer_pos: string;
  description: string;
  cf_vin?: string;
  cf_mileage?: string;
  cf_attachment_url?: string;
  cf_website_id?: string;
};

/**
 * Arma el cuerpo para Zoho a partir de un reclamo ya validado y resuelto
 * contra el catalogo.
 *
 * Los campos opcionales se omiten en vez de enviarse vacios: un campo ausente
 * es mas facil de interpretar en Zoho que uno presente con cadena vacia.
 *
 * @param reclamo reclamo que ya paso por esquemaReclamo y resolverCatalogo
 */
export function mapearAZoho(reclamo: Reclamo): ReclamoZoho {
  const zoho: ReclamoZoho = {
    cf_first_name: reclamo.nombre,
    cf_last_name: reclamo.apellido,
    cf_id_number: reclamo.rut,
    cf_mobile: reclamo.telefono,
    email: reclamo.email,
    cf_license_plate: reclamo.vehiculo.patente,
    // La serie es el modelo (MG4) y cf_model es la variante (MG 4 XPOWER).
    cf_series: reclamo.vehiculo.serie,
    cf_model: reclamo.vehiculo.variante,
    cf_model_year: String(reclamo.vehiculo.anio),
    cf_website_dealer: reclamo.concesionario.nombre,
    cf_website_dealer_pos: reclamo.concesionario.sucursal,
    description: reclamo.motivo,
  };

  if (reclamo.vehiculo.vin) zoho.cf_vin = reclamo.vehiculo.vin;
  if (reclamo.vehiculo.kilometraje !== undefined) {
    zoho.cf_mileage = String(reclamo.vehiculo.kilometraje);
  }
  if (reclamo.adjuntoUrl) zoho.cf_attachment_url = reclamo.adjuntoUrl;
  if (reclamo.ghlContactId) zoho.cf_website_id = reclamo.ghlContactId;

  return zoho;
}
