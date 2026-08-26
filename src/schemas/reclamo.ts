import { z } from 'zod';
import {
  buscarConcesionario,
  buscarSerie,
  buscarSucursal,
  buscarVariante,
} from '../catalogo/catalogo.ts';

const PATENTE_CHILENA = /^([A-Z]{4}\d{2}|[A-Z]{2}\d{4}|[A-Z]{3}\d{2})$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const TELEFONO = /^\+?[0-9][0-9\s-]{7,19}$/;
// El VIN no usa I, O ni Q para no confundirlas con 1 y 0.
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Quita puntos, guiones y espacios y deja el digito verificador en mayuscula. */
export function normalizarRut(valor: string): string {
  return valor.replace(/[.\-\s]/g, '').toUpperCase();
}

/**
 * Valida un RUT chileno por modulo 11.
 * @param rut RUT ya normalizado (sin puntos ni guion)
 */
export function rutValido(rut: string): boolean {
  if (!/^\d{7,8}[0-9K]$/.test(rut)) return false;

  const cuerpo = rut.slice(0, -1);
  const digitoVerificador = rut.slice(-1);

  let suma = 0;
  let multiplicador = 2;

  for (let i = cuerpo.length - 1; i >= 0; i -= 1) {
    suma += Number(cuerpo[i]) * multiplicador;
    multiplicador = multiplicador === 7 ? 2 : multiplicador + 1;
  }

  const resto = 11 - (suma % 11);
  const esperado = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);

  return digitoVerificador === esperado;
}

const anioActual = new Date().getFullYear();

/** Numero escrito por una persona: puede traer puntos o comas de miles. */
const enteroTolerante = z
  .union([z.number(), z.string()])
  .transform((valor) => (typeof valor === 'number' ? valor : Number(valor.replace(/[.,\s]/g, ''))))
  .refine((valor) => Number.isInteger(valor) && valor >= 0, 'debe ser un numero entero');

/**
 * Forma y formato del reclamo ya limpio.
 * Es estricta a proposito: un campo no declarado es un rechazo, no un campo
 * que se ignora en silencio.
 *
 * La existencia real de la serie, variante, concesionario y sucursal la
 * comprueba resolverCatalogo(), no este esquema.
 */
export const esquemaReclamo = z
  .object({
    nombre: z.string().trim().min(2).max(60),
    apellido: z.string().trim().min(2).max(60),
    rut: z.string().trim().transform(normalizarRut).refine(rutValido, 'RUT invalido'),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(200)
      .refine((valor) => EMAIL.test(valor), 'email invalido'),
    telefono: z
      .string()
      .trim()
      .refine((valor) => TELEFONO.test(valor), 'telefono invalido'),
    vehiculo: z
      .object({
        patente: z
          .string()
          .trim()
          .toUpperCase()
          .transform((valor) => valor.replace(/[\s-]/g, ''))
          .refine((valor) => PATENTE_CHILENA.test(valor), 'patente invalida'),
        serie: z.string().trim().min(2).max(60),
        variante: z.string().trim().min(1).max(80),
        anio: z.coerce.number().int().min(1900).max(anioActual + 1),
        vin: z
          .string()
          .trim()
          .toUpperCase()
          .refine((valor) => VIN.test(valor), 'VIN invalido: son 17 caracteres, sin I, O ni Q')
          .optional(),
        kilometraje: enteroTolerante.optional(),
      })
      .strict(),
    concesionario: z
      .object({
        nombre: z.string().trim().min(2).max(80),
        sucursal: z.string().trim().min(2).max(80),
      })
      .strict(),
    motivo: z.string().trim().min(10).max(2000),
    adjuntoUrl: z
      .string()
      .trim()
      .refine((valor) => URL.canParse(valor), 'debe ser una URL absoluta')
      .optional(),
    ghlContactId: z.string().trim().max(120).optional(),
  })
  .strict();

export type Reclamo = z.infer<typeof esquemaReclamo>;

export type ErrorCampo = { campo: string; mensaje: string };

export type ResultadoCatalogo =
  | { ok: true; reclamo: Reclamo }
  | { ok: false; errores: ErrorCampo[] };

/**
 * Comprueba serie, variante, concesionario y sucursal contra el catalogo
 * oficial, y reemplaza lo recibido por el valor canonico.
 *
 * Que el valor exista en el catalogo es lo que impide que a Zoho llegue un
 * modelo inventado o mal escrito.
 *
 * @param reclamo reclamo que ya paso el esquema de formato
 */
export function resolverCatalogo(reclamo: Reclamo): ResultadoCatalogo {
  const errores: ErrorCampo[] = [];

  const modelo = buscarSerie(reclamo.vehiculo.serie);
  const variante = modelo ? buscarVariante(modelo, reclamo.vehiculo.variante) : undefined;

  if (!modelo) {
    errores.push({ campo: 'vehiculo.serie', mensaje: 'serie desconocida en el catalogo MG' });
  } else if (!variante) {
    errores.push({
      campo: 'vehiculo.variante',
      mensaje: `variante desconocida o ambigua para la serie ${modelo.serie}`,
    });
  }

  const concesionario = buscarConcesionario(reclamo.concesionario.nombre);
  const sucursal = concesionario
    ? buscarSucursal(concesionario, reclamo.concesionario.sucursal)
    : undefined;

  if (!concesionario) {
    errores.push({
      campo: 'concesionario.nombre',
      mensaje: 'concesionario no activo en posventa',
    });
  } else if (!sucursal) {
    errores.push({
      campo: 'concesionario.sucursal',
      mensaje: `sucursal desconocida o ambigua para ${concesionario.nombre}`,
    });
  }

  if (errores.length > 0) return { ok: false, errores };

  return {
    ok: true,
    reclamo: {
      ...reclamo,
      vehiculo: { ...reclamo.vehiculo, serie: modelo!.serie, variante: variante! },
      concesionario: { nombre: concesionario!.nombre, sucursal: sucursal! },
    },
  };
}

/**
 * Lo que mgAPI resolvio por su cuenta, para que GHL pueda confirmarlo.
 *
 * Son los cuatro valores que la seleccion por nombre y el catalogo decidieron,
 * y los unicos que GHL no sabe de antemano. El resto del reclamo no se devuelve:
 * GHL ya lo mando, y repetirlo solo lo escribiria de nuevo en sus registros.
 *
 * @param reclamo reclamo ya validado y resuelto contra el catalogo
 */
export function resumenInterpretado(reclamo: Reclamo): Record<string, string> {
  return {
    serie: reclamo.vehiculo.serie,
    variante: reclamo.vehiculo.variante,
    concesionario: reclamo.concesionario.nombre,
    sucursal: reclamo.concesionario.sucursal,
  };
}

/**
 * Unicos campos de la API externa que pueden llegar a GHL.
 * Lo que no esta aqui no sale: la regla es denegar por defecto.
 */
export const CAMPOS_RESPUESTA_PERMITIDOS = ['folio', 'estado', 'fechaRecepcion'] as const;

/**
 * Filtra la respuesta de la API externa dejando solo campos permitidos y escalares.
 * @param respuestaExterna cuerpo tal como lo devolvio la API externa
 */
export function mapearRespuesta(respuestaExterna: unknown): Record<string, string | number | boolean> {
  const resumen: Record<string, string | number | boolean> = {};

  if (typeof respuestaExterna !== 'object' || respuestaExterna === null) return resumen;

  const fuente = respuestaExterna as Record<string, unknown>;

  for (const campo of CAMPOS_RESPUESTA_PERMITIDOS) {
    const valor = fuente[campo];
    if (typeof valor === 'string' || typeof valor === 'number' || typeof valor === 'boolean') {
      resumen[campo] = valor;
    }
  }

  return resumen;
}
