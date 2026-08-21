import { z } from 'zod';

const PATENTE_CHILENA = /^([A-Z]{4}\d{2}|[A-Z]{2}\d{4}|[A-Z]{3}\d{2})$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const TELEFONO = /^\+?[0-9][0-9\s-]{7,19}$/;

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

/**
 * Entrada del reclamo. Es estricta a proposito: un campo no declarado
 * es un rechazo, no un campo que se ignora en silencio.
 */
export const esquemaReclamo = z
  .object({
    nombre: z.string().trim().min(2).max(120),
    rut: z
      .string()
      .trim()
      .transform(normalizarRut)
      .refine(rutValido, 'RUT invalido'),
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
        marca: z.string().trim().min(1).max(60),
        modelo: z.string().trim().min(1).max(60),
        anio: z.coerce.number().int().min(1900).max(anioActual + 1),
      })
      .strict(),
    motivo: z.string().trim().min(10).max(2000),
    referenciaGhl: z.string().trim().max(120).optional(),
  })
  .strict();

export type Reclamo = z.infer<typeof esquemaReclamo>;

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
