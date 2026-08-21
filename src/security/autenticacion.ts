import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { entorno } from '../env.ts';

const CABECERA_CLAVE = 'x-mgapi-key';
const CABECERA_FIRMA = 'x-mgapi-firma';
const CABECERA_TIMESTAMP = 'x-mgapi-timestamp';

/** Firmas ya usadas, para que una llamada capturada no pueda repetirse. */
const firmasVistas = new Map<string, number>();

/**
 * Compara dos textos en tiempo constante.
 * Compara los digest SHA-256 y no los textos: asi el largo del valor recibido
 * tampoco filtra informacion, y timingSafeEqual nunca recibe largos distintos.
 */
function igualesEnTiempoConstante(recibido: string, esperado: string): boolean {
  const digestRecibido = createHash('sha256').update(recibido, 'utf8').digest();
  const digestEsperado = createHash('sha256').update(esperado, 'utf8').digest();

  return timingSafeEqual(digestRecibido, digestEsperado);
}

function purgarFirmasVencidas(ahora: number): void {
  for (const [firma, vence] of firmasVistas) {
    if (vence <= ahora) firmasVistas.delete(firma);
  }
}

export type ResultadoAutenticacion = { ok: true } | { ok: false; motivo: string };

type Cabeceras = Record<string, string | string[] | undefined>;

/**
 * Valida la clave compartida con GHL.
 * Se ejecuta antes de leer el cuerpo: a un desconocido no se le parsea nada.
 *
 * @param cabeceras cabeceras de la peticion
 * @returns ok, o el motivo del rechazo para el log interno (nunca para el cliente)
 */
export function verificarClave(cabeceras: Cabeceras): ResultadoAutenticacion {
  const clave = cabeceras[CABECERA_CLAVE];

  if (typeof clave !== 'string' || clave.length === 0) {
    return { ok: false, motivo: 'clave ausente' };
  }
  if (!igualesEnTiempoConstante(clave, entorno.MGAPI_KEY)) {
    return { ok: false, motivo: 'clave incorrecta' };
  }

  return { ok: true };
}

/**
 * Valida la firma HMAC del cuerpo, si esta activada.
 * Necesita el cuerpo crudo, asi que corre despues de recibirlo.
 *
 * @param cabeceras cabeceras de la peticion
 * @param cuerpoCrudo cuerpo tal cual llego, sin parsear
 */
export function verificarFirma(cabeceras: Cabeceras, cuerpoCrudo: string): ResultadoAutenticacion {
  if (!entorno.HMAC_ACTIVO) return { ok: true };

  const firma = cabeceras[CABECERA_FIRMA];
  const timestamp = cabeceras[CABECERA_TIMESTAMP];

  if (typeof firma !== 'string' || typeof timestamp !== 'string') {
    return { ok: false, motivo: 'firma o timestamp ausente' };
  }

  const momento = Number(timestamp);
  const ahora = Math.floor(Date.now() / 1000);

  if (!Number.isFinite(momento)) return { ok: false, motivo: 'timestamp invalido' };
  if (Math.abs(ahora - momento) > entorno.HMAC_VENTANA_SEGUNDOS) {
    return { ok: false, motivo: 'timestamp fuera de ventana' };
  }

  const esperada = createHmac('sha256', entorno.HMAC_SECRETO as string)
    .update(`${timestamp}.${cuerpoCrudo}`, 'utf8')
    .digest('hex');

  if (!igualesEnTiempoConstante(firma, esperada)) {
    return { ok: false, motivo: 'firma incorrecta' };
  }

  purgarFirmasVencidas(ahora);
  if (firmasVistas.has(firma)) return { ok: false, motivo: 'firma repetida' };
  firmasVistas.set(firma, ahora + entorno.HMAC_VENTANA_SEGUNDOS);

  return { ok: true };
}
