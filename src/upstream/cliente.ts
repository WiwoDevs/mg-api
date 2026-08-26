import { entorno } from '../env.ts';
import type { Reclamo } from '../schemas/reclamo.ts';
import { datosDeContacto, mapearAZoho } from './zoho.ts';
import { invalidarCredencial, obtenerCredencial } from './zoho-auth.ts';

export type ResultadoUpstream =
  | { ok: true; datos: unknown; simulado?: true }
  | { ok: false; reintentable: boolean; detalle: string; codigoZoho?: string };

const presupuesto = { dia: '', usados: 0 };

function diaDeHoy(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Cuantas llamadas quedan hoy contra la API externa. */
export function presupuestoRestante(): number {
  if (presupuesto.dia !== diaDeHoy()) return entorno.UPSTREAM_PRESUPUESTO_DIARIO;

  return Math.max(0, entorno.UPSTREAM_PRESUPUESTO_DIARIO - presupuesto.usados);
}

/**
 * Reserva una llamada del presupuesto diario.
 * @returns false si el presupuesto de hoy ya se agoto
 */
export function consumirPresupuesto(): boolean {
  const hoy = diaDeHoy();

  if (presupuesto.dia !== hoy) {
    presupuesto.dia = hoy;
    presupuesto.usados = 0;
  }
  if (presupuesto.usados >= entorno.UPSTREAM_PRESUPUESTO_DIARIO) return false;

  presupuesto.usados += 1;

  return true;
}

/** Solo para pruebas: deja el contador diario en cero. */
export function reiniciarPresupuesto(): void {
  presupuesto.dia = diaDeHoy();
  presupuesto.usados = 0;
}

/** Marca interna para reconocer un token rechazado sin repetir el numero suelto. */
const TOKEN_RECHAZADO = 'estado 401';

/** Lo que viaja a Zoho: el caso como argumento y los datos de contacto como cuerpo. */
type EnvioAZoho = { caso: string; cuerpo: string };

/** Codigos de Zoho que no mejoran por reintentar: el dato esta mal, no el momento. */
const CODIGOS_DEFINITIVOS = new Set(['INVALID_DATA', 'MANDATORY_NOT_FOUND', 'INVALID_URL_PATTERN']);

/**
 * Detecta un fallo que Zoho informa con codigo de exito.
 *
 * Su endpoint de funciones responde HTTP 200 aunque la funcion falle, con el
 * detalle en el cuerpo. Sin esto, un reclamo rechazado se daria por entregado.
 *
 * @param datos cuerpo ya parseado de la respuesta
 * @returns el fallo, o undefined si la respuesta es buena
 */
function errorLogicoDeZoho(datos: unknown): ResultadoUpstream | undefined {
  if (typeof datos !== 'object' || datos === null) return undefined;

  const codigo = (datos as { code?: unknown }).code;

  if (typeof codigo !== 'string' || codigo === 'success') return undefined;

  // El mensaje de Zoho no se reenvia: describe su logica interna. El codigo si,
  // porque es lo unico que le dice a GHL por que no entro el reclamo.
  return {
    ok: false,
    reintentable: !CODIGOS_DEFINITIVOS.has(codigo),
    detalle: `Zoho respondio codigo "${codigo}"`,
    codigoZoho: codigo,
  };
}

/** Espera antes de llamar a la funcion, si la configuracion lo pide. */
function esperar(ms: number): Promise<void> {
  return new Promise((cumplir) => {
    setTimeout(cumplir, ms);
  });
}

/**
 * Una llamada a Zoho con un token fresco.
 * @param forzarToken pide un token nuevo en vez de usar el guardado
 */
async function intentarEnvio(
  envio: EnvioAZoho,
  idCorrelacion: string,
  forzarToken: boolean,
): Promise<ResultadoUpstream> {
  const credencial = await obtenerCredencial(forzarToken);

  if (!credencial.ok) {
    return {
      ok: false,
      reintentable: credencial.reintentable,
      detalle: `autenticacion: ${credencial.detalle}`,
    };
  }

  // La funcion de Zoho recibe el caso como argumento, no como cuerpo. Mandarlo
  // en el cuerpo es lo que dejaba el argumento vacio y hacia fallar su get().
  const url = new URL(entorno.UPSTREAM_URL as string);

  url.searchParams.set('auth_type', 'oauth');
  url.searchParams.set(entorno.ZOHO_ARGUMENTO_CASO, envio.caso);

  try {
    const respuesta = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(entorno.UPSTREAM_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Zoho no usa "Bearer": exige su propio prefijo.
        authorization: `Zoho-oauthtoken ${credencial.credencial.token}`,
        'x-correlacion': idCorrelacion,
      },
      body: envio.cuerpo,
    });

    if (respuesta.ok) {
      const datos = await respuesta.json().catch(() => ({}));
      const fallo = errorLogicoDeZoho(datos);

      // Zoho responde 200 aunque la funcion falle: el error viene en el cuerpo.
      if (fallo) return fallo;

      return { ok: true, datos };
    }

    // Zoho esta saturado o roto: vale la pena reintentar.
    const reintentable =
      respuesta.status === 401 ||
      respuesta.status === 408 ||
      respuesta.status === 429 ||
      respuesta.status >= 500;
    // Se descarta el cuerpo sin leerlo: puede traer datos o estructura interna ajena.
    await respuesta.body?.cancel();

    return { ok: false, reintentable, detalle: `estado ${respuesta.status}` };
  } catch (error) {
    // Timeout, DNS, TLS o redireccion rechazada: son fallas transitorias de red.
    const nombre = error instanceof Error ? error.name : 'error desconocido';

    return { ok: false, reintentable: true, detalle: `red: ${nombre}` };
  }
}

/**
 * Envia el reclamo a Zoho, resolviendo la autenticacion por su cuenta.
 *
 * No sigue redirecciones (una redireccion maliciosa no puede desviar el token a
 * otro host) y corta por timeout. El cuerpo de la respuesta nunca se registra.
 *
 * @param reclamo reclamo ya validado y resuelto contra el catalogo
 * @param idCorrelacion identificador para rastrear la operacion en los logs
 */
export async function enviarReclamo(
  reclamo: Reclamo,
  idCorrelacion: string,
): Promise<ResultadoUpstream> {
  if (!entorno.UPSTREAM_ACTIVO) {
    // Modo sin Zoho: se valido todo, pero no sale ninguna peticion al exterior.
    return { ok: true, simulado: true, datos: {} };
  }

  const envio: EnvioAZoho = {
    caso: JSON.stringify(mapearAZoho(reclamo)),
    cuerpo: JSON.stringify(datosDeContacto(reclamo)),
  };

  if (entorno.ZOHO_ESPERA_MS > 0) await esperar(entorno.ZOHO_ESPERA_MS);

  const primerIntento = await intentarEnvio(envio, idCorrelacion, false);

  // Un 401 significa que el token guardado ya no sirve, aunque no haya vencido
  // segun nuestro reloj: se pide uno nuevo y se reintenta una sola vez.
  if (primerIntento.ok || primerIntento.detalle !== TOKEN_RECHAZADO) return primerIntento;

  invalidarCredencial();

  return intentarEnvio(envio, idCorrelacion, true);
}
