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
    // El RUT se normaliza pero no se rechaza por digito verificador: un error de
    // tipeo no debe costar el reclamo. Queda como advertencia.
    rut: z.string().trim().min(1, 'falta el RUT').transform(normalizarRut),
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
        // Se normaliza sin exigir formato chileno: hay patentes antiguas, de
        // remolque y extranjeras que no calzan, y perder el reclamo es peor.
        patente: z
          .string()
          .trim()
          .min(1, 'falta la patente')
          .toUpperCase()
          .transform((valor) => valor.replace(/[\s-]/g, '')),
        serie: z.string().trim().min(2).max(60),
        variante: z.string().trim().min(1).max(80),
        anio: z.coerce.number().int().min(1900).max(anioActual + 1),
        vin: z.string().trim().toUpperCase().optional(),
        kilometraje: enteroTolerante.optional(),
      })
      .strict(),
    concesionario: z
      .object({
        nombre: z.string().trim().min(2).max(80),
        sucursal: z.string().trim().min(2).max(80),
      })
      .strict(),
    motivo: z.string().trim().min(1, 'falta la descripcion del problema').max(2000),
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

export type ResultadoCatalogo = { reclamo: Reclamo; avisos: string[] };

/**
 * Reemplaza serie, variante, concesionario y sucursal por su valor canonico
 * del catalogo, cuando existe.
 *
 * Lo que no esta en el catalogo NO se rechaza: viaja tal como lo mando el
 * formulario y queda una advertencia. El formulario es la fuente: si ofrece una
 * opcion, es legitima, y el catalogo es el que esta desactualizado. Perder el
 * reclamo por esa diferencia es peor que aceptar un valor sin canonizar.
 *
 * @param reclamo reclamo que ya paso el esquema de formato
 */
export function resolverCatalogo(reclamo: Reclamo): ResultadoCatalogo {
  const avisos: string[] = [];

  const modelo = buscarSerie(reclamo.vehiculo.serie);
  const variante = modelo ? buscarVariante(modelo, reclamo.vehiculo.variante) : undefined;

  if (!modelo) {
    avisos.push(`el modelo "${reclamo.vehiculo.serie}" no esta en el catalogo MG`);
  } else if (!variante) {
    avisos.push(
      `la variante "${reclamo.vehiculo.variante}" no calza con las de ${modelo.serie}`,
    );
  }

  const concesionario = buscarConcesionario(reclamo.concesionario.nombre);
  const sucursal = concesionario
    ? buscarSucursal(concesionario, reclamo.concesionario.sucursal)
    : undefined;

  if (!concesionario) {
    avisos.push(`"${reclamo.concesionario.nombre}" no figura entre los concesionarios de posventa`);
  } else if (!sucursal) {
    avisos.push(
      `la sucursal "${reclamo.concesionario.sucursal}" no calza con las de ${concesionario.nombre}`,
    );
  }

  return {
    avisos,
    reclamo: {
      ...reclamo,
      vehiculo: {
        ...reclamo.vehiculo,
        serie: modelo?.serie ?? reclamo.vehiculo.serie,
        variante: variante ?? reclamo.vehiculo.variante,
      },
      concesionario: {
        nombre: concesionario?.nombre ?? reclamo.concesionario.nombre,
        sucursal: sucursal ?? reclamo.concesionario.sucursal,
      },
    },
  };
}

/**
 * Revisa lo que se acepto pero conviene mirar.
 *
 * Son controles que antes rechazaban el reclamo. Rechazar significaba perderlo,
 * asi que ahora solo avisan: el reclamo sigue a Zoho y el aviso viaja en la
 * respuesta, para que quien corresponda pueda corregir el dato despues.
 *
 * @param reclamo reclamo ya validado y resuelto contra el catalogo
 */
export function advertencias(reclamo: Reclamo): string[] {
  const avisos: string[] = [];

  if (!rutValido(reclamo.rut)) {
    avisos.push('el RUT no pasa la verificacion por modulo 11');
  }
  if (!PATENTE_CHILENA.test(reclamo.vehiculo.patente)) {
    avisos.push('la patente no calza con los formatos chilenos habituales');
  }
  if (reclamo.motivo.length < 10) {
    avisos.push('la descripcion del problema es muy breve');
  }
  if (reclamo.vehiculo.vin !== undefined && !VIN.test(reclamo.vehiculo.vin)) {
    avisos.push('el VIN no tiene 17 caracteres validos');
  }

  return avisos;
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
