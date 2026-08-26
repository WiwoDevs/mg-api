import { entorno } from '../env.ts';
import type { Reclamo } from '../schemas/reclamo.ts';
import { mapearAZoho } from './zoho.ts';
import { invalidarCredencial, obtenerCredencial } from './zoho-auth.ts';

export type ResultadoUpstream =
  | { ok: true; datos: unknown; simulado?: true }
  | { ok: false; reintentable: boolean; detalle: string };

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

/**
 * Una llamada a Zoho con un token fresco.
 * @param forzarToken pide un token nuevo en vez de usar el guardado
 */
async function intentarEnvio(
  cuerpo: string,
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

  try {
    const respuesta = await fetch(entorno.UPSTREAM_URL as string, {
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
      body: cuerpo,
    });

    if (respuesta.ok) {
      const datos = await respuesta.json().catch(() => ({}));

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

  const cuerpo = JSON.stringify(mapearAZoho(reclamo));
  const primerIntento = await intentarEnvio(cuerpo, idCorrelacion, false);

  // Un 401 significa que el token guardado ya no sirve, aunque no haya vencido
  // segun nuestro reloj: se pide uno nuevo y se reintenta una sola vez.
  if (primerIntento.ok || primerIntento.detalle !== TOKEN_RECHAZADO) return primerIntento;

  invalidarCredencial();

  return intentarEnvio(cuerpo, idCorrelacion, true);
}
