import { z } from 'zod';
import { buscarSerie } from '../catalogo/catalogo.ts';
import { esquemaReclamo, resolverCatalogo } from './reclamo.ts';
import type { ErrorCampo, Reclamo } from './reclamo.ts';

/**
 * Ingesta del cuerpo que envia GoHighLevel.
 *
 * GHL manda un campo por cada variable del contacto, sin concatenar. De los
 * trece campos de variante y los quince de sucursal, este modulo elige el que
 * corresponde al modelo y al concesionario declarados, y descarta el resto.
 *
 * Ver docs/06-payload-ghl.md para el contrato completo.
 */

/** Una variable que GHL no logro reemplazar llega como el literal {{contact.algo}}. */
const SIN_RENDERIZAR = /^\{\{.*\}\}$/;

/** Caracteres invisibles que arrastraba el payload anterior por concatenar variables. */
const INVISIBLES = /[\u200B-\u200D\uFEFF]/g;

/**
 * Campos de GHL que pueden traer el mismo dato que otro campo.
 *
 * Existen porque el formulario creo campos de mas: XPOWER es una variante del
 * MG4 y Movicenter es una sucursal de Pompeyo Carrasco, pero ambos tienen campo
 * propio. Se consultan como respaldo para no perder reclamos ya cargados ahi.
 * Se retiran cuando GHL quede limpio.
 */
const CAMPOS_ALTERNATIVOS: Record<string, string[]> = {
  mg4: ['mg4_xpower'],
  pompeyo_carrasco: ['movicenter'],
};

const textoOpcional = z.string().optional();

/** Grupo de campos abierto: si MG suma un modelo, GHL puede mandarlo sin romper nada. */
const grupoAbierto = z.record(z.string(), z.string()).default({});

/**
 * Forma del cuerpo que envia GHL.
 *
 * Los objetos de campos fijos son estrictos, para que un campo no declarado no
 * pase inadvertido. Los dos grupos son abiertos a proposito: su contenido crece
 * cuando MG agrega modelos o concesionarios.
 */
export const esquemaPayloadGhl = z
  .object({
    ghl_contact_id: textoOpcional,
    contacto: z
      .object({
        first_name: textoOpcional,
        last_name: textoOpcional,
        rut: textoOpcional,
        phone: textoOpcional,
        email: textoOpcional,
      })
      .strict(),
    vehiculo: z
      .object({
        patente_del_vehculo: textoOpcional,
        ao_del_vehculo: textoOpcional,
        vin_del_vehculo: textoOpcional,
        kilometraje: textoOpcional,
        modelo_del_auto: textoOpcional,
      })
      .strict(),
    variante_por_modelo: grupoAbierto,
    concesionario: z.object({ nombre_convesionario: textoOpcional }).strict(),
    sucursal_por_concesionario: grupoAbierto,
    reclamo: z
      .object({
        'descripcin_del_problema': textoOpcional,
        'imgenes_o_respaldo': textoOpcional,
      })
      .strict(),
  })
  .strict();

export type PayloadGhl = z.infer<typeof esquemaPayloadGhl>;

/**
 * Reproduce como GHL arma el nombre de un campo personalizado: elimina los
 * caracteres acentuados en vez de transcribirlos.
 *
 * "año del vehiculo" produce "ao_del_vehculo", y "Circulo Autos" produce
 * "crculo_autos". Por eso no sirve la normalizacion habitual, que dejaria
 * "ano" y "circulo".
 */
export function slugGhl(texto: string): string {
  return texto
    .replace(INVISIBLES, '')
    .replace(/[^\x20-\x7E]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Quita invisibles y espacios sobrantes. */
function limpiar(valor: string): string {
  return valor.replace(INVISIBLES, '').trim();
}

/**
 * Devuelve el valor util de un campo, o undefined si no lo tiene.
 * Un literal sin renderizar cuenta como vacio: nunca debe llegar a Zoho.
 */
function valorUtil(valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined;

  const limpio = limpiar(valor);

  if (limpio === '' || SIN_RENDERIZAR.test(limpio)) return undefined;

  return limpio;
}

/**
 * Elige el valor de un grupo por el nombre del campo, no por su contenido.
 *
 * Es lo que hace que el historico acumulado del contacto deje de importar: si
 * el modelo declarado es MG4 solo se mira el campo mg4, aunque mg3 venga lleno
 * de un reclamo anterior.
 *
 * @param grupo campos del grupo tal como llegaron
 * @param campo nombre del campo que corresponde al modelo o concesionario
 */
function elegirDelGrupo(grupo: Record<string, string>, campo: string): string | undefined {
  for (const candidato of [campo, ...(CAMPOS_ALTERNATIVOS[campo] ?? [])]) {
    const valor = valorUtil(grupo[candidato]);

    if (valor !== undefined) return valor;
  }

  return undefined;
}

type ResultadoIngesta = { ok: true; reclamo: Reclamo } | { ok: false; errores: ErrorCampo[] };

/**
 * Saca el reclamo de la envoltura {"body": "<json>"}.
 *
 * GHL envuelve asi el cuerpo cuando el JSON se carga en su seccion de pares
 * clave/valor en vez de en el cuerpo crudo, y en ese caso ignora el cuerpo
 * crudo por completo. Se acepta para que una diferencia de configuracion en
 * el formulario no cueste un reclamo.
 *
 * @param cuerpo cuerpo de la peticion, sin confiar en su forma
 */
function desenvolver(cuerpo: unknown): unknown {
  if (typeof cuerpo !== 'object' || cuerpo === null) return cuerpo;

  const envoltura = (cuerpo as { body?: unknown }).body;

  if (typeof envoltura !== 'string') return cuerpo;

  try {
    return JSON.parse(envoltura);
  } catch {
    // No era JSON: se devuelve tal cual para que el esquema explique el error.
    return cuerpo;
  }
}

/**
 * Convierte el cuerpo de GHL en el reclamo limpio, aplicando la regla de
 * seleccion por nombre. No valida formatos: de eso se encarga esquemaReclamo.
 *
 * @param payload cuerpo de GHL que ya paso por esquemaPayloadGhl
 */
export function transformarDesdeGhl(payload: PayloadGhl): { valor: unknown; errores: ErrorCampo[] } {
  const errores: ErrorCampo[] = [];

  const serie = valorUtil(payload.vehiculo.modelo_del_auto);
  let variante: string | undefined;

  if (!serie) {
    errores.push({ campo: 'vehiculo.modelo_del_auto', mensaje: 'falta el modelo del vehiculo' });
  } else {
    const modelo = buscarSerie(serie);

    // Un modelo desconocido se nombra como tal. Si no, el error hablaria de una
    // variante ausente y mandaria a buscar el problema donde no esta.
    if (!modelo) {
      errores.push({
        campo: 'vehiculo.modelo_del_auto',
        mensaje: `modelo desconocido en el catalogo MG: ${serie}`,
      });
    } else {
      const campo = modelo.campoGhl ?? slugGhl(serie);

      variante = elegirDelGrupo(payload.variante_por_modelo, campo);

      if (!variante) {
        errores.push({
          campo: `variante_por_modelo.${campo}`,
          mensaje: `no hay variante cargada para el modelo ${serie}`,
        });
      }
    }
  }

  const concesionario = valorUtil(payload.concesionario.nombre_convesionario);
  let sucursal: string | undefined;

  if (!concesionario) {
    errores.push({
      campo: 'concesionario.nombre_convesionario',
      mensaje: 'falta el concesionario',
    });
  } else {
    const campo = slugGhl(concesionario);

    sucursal = elegirDelGrupo(payload.sucursal_por_concesionario, campo);

    if (!sucursal) {
      errores.push({
        campo: `sucursal_por_concesionario.${campo}`,
        mensaje: `no hay sucursal cargada para ${concesionario}`,
      });
    }
  }

  const vehiculo: Record<string, unknown> = {
    patente: valorUtil(payload.vehiculo.patente_del_vehculo),
    serie,
    variante,
    anio: valorUtil(payload.vehiculo.ao_del_vehculo),
  };
  const vin = valorUtil(payload.vehiculo.vin_del_vehculo);
  const kilometraje = valorUtil(payload.vehiculo.kilometraje);

  // Los opcionales ausentes se omiten en vez de viajar vacios: el esquema los
  // rechazaria como cadena vacia y no son obligatorios.
  if (vin !== undefined) vehiculo.vin = vin;
  if (kilometraje !== undefined) vehiculo.kilometraje = kilometraje;

  const reclamo: Record<string, unknown> = {
    nombre: valorUtil(payload.contacto.first_name),
    apellido: valorUtil(payload.contacto.last_name),
    rut: valorUtil(payload.contacto.rut),
    email: valorUtil(payload.contacto.email),
    telefono: valorUtil(payload.contacto.phone),
    vehiculo,
    concesionario: { nombre: concesionario, sucursal },
    motivo: valorUtil(payload.reclamo['descripcin_del_problema']),
  };
  const adjunto = valorUtil(payload.reclamo['imgenes_o_respaldo']);
  const contactId = valorUtil(payload.ghl_contact_id);

  if (adjunto !== undefined) reclamo.adjuntoUrl = adjunto;
  if (contactId !== undefined) reclamo.ghlContactId = contactId;

  return { valor: reclamo, errores };
}

/**
 * Punto de entrada de la ingesta: del cuerpo crudo de GHL al reclamo listo
 * para traducir a Zoho.
 *
 * Encadena las cuatro etapas: forma del payload, seleccion por nombre, formato
 * de cada campo, y existencia real en el catalogo oficial de MG.
 *
 * @param cuerpo cuerpo de la peticion, sin confiar en su forma
 */
export function procesarPayloadGhl(cuerpo: unknown): ResultadoIngesta {
  const payload = esquemaPayloadGhl.safeParse(desenvolver(cuerpo));

  if (!payload.success) {
    return {
      ok: false,
      errores: payload.error.issues.map((issue) => ({
        campo: issue.path.join('.'),
        mensaje: issue.message,
      })),
    };
  }

  const { valor, errores } = transformarDesdeGhl(payload.data);

  if (errores.length > 0) return { ok: false, errores };

  const formato = esquemaReclamo.safeParse(valor);

  if (!formato.success) {
    return {
      ok: false,
      errores: formato.error.issues.map((issue) => ({
        campo: issue.path.join('.'),
        mensaje: issue.message,
      })),
    };
  }

  return resolverCatalogo(formato.data);
}
