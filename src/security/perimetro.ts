import { entorno } from '../env.ts';

/**
 * Perimetro de red: quien puede llegar al endpoint y quien queda bloqueado
 * por insistir con claves incorrectas.
 */

const MAXIMO_IPS_VIGILADAS = 10_000;

type Fallos = { conteo: number; expira: number };

const fallosPorIp = new Map<string, Fallos>();

/** Normaliza IPv4 mapeadas en IPv6 (::ffff:1.2.3.4) a su forma IPv4. */
function normalizarIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Convierte una IPv4 a entero sin signo. @returns null si no es IPv4 valida */
function ipv4ANumero(ip: string): number | null {
  const partes = ip.split('.');

  if (partes.length !== 4) return null;

  let numero = 0;

  for (const parte of partes) {
    if (!/^\d{1,3}$/.test(parte)) return null;

    const octeto = Number(parte);

    if (octeto > 255) return null;
    numero = numero * 256 + octeto;
  }

  return numero;
}

/**
 * Compara una IP contra una regla de la allowlist.
 * @param regla IPv4 exacta, bloque CIDR IPv4 (1.2.3.0/24), o texto exacto para IPv6
 */
function coincide(ip: string, regla: string): boolean {
  if (!regla.includes('/')) return ip === regla;

  const [red, bitsTexto] = regla.split('/');
  const bits = Number(bitsTexto);

  if (!red || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const numeroIp = ipv4ANumero(ip);
  const numeroRed = ipv4ANumero(red);

  if (numeroIp === null || numeroRed === null) return false;
  if (bits === 0) return true;

  const mascara = (0xffffffff << (32 - bits)) >>> 0;

  return (numeroIp & mascara) >>> 0 === (numeroRed & mascara) >>> 0;
}

const reglasPermitidas = entorno.IPS_GHL.split(/[\s,]+/).filter(Boolean);

/** true si la allowlist esta configurada y por lo tanto se aplica. */
export function allowlistActiva(): boolean {
  return reglasPermitidas.length > 0;
}

/**
 * Decide si una IP puede llegar al endpoint.
 * Con la allowlist vacia no filtra: la unica defensa queda siendo la clave.
 */
export function ipPermitida(ip: string): boolean {
  if (reglasPermitidas.length === 0) return true;

  const normalizada = normalizarIp(ip);

  return reglasPermitidas.some((regla) => coincide(normalizada, regla));
}

function purgarVencidos(ahora: number): void {
  for (const [ip, fallos] of fallosPorIp) {
    if (fallos.expira <= ahora) fallosPorIp.delete(ip);
  }
}

/** true si esta IP acumulo demasiadas claves incorrectas y sigue en penalizacion. */
export function estaBloqueada(ip: string): boolean {
  const fallos = fallosPorIp.get(normalizarIp(ip));

  if (!fallos) return false;

  return Date.now() < fallos.expira && fallos.conteo >= entorno.AUTH_FALLOS_MAX;
}

/**
 * Anota un intento de autenticacion fallido.
 * Cada fallo reinicia el reloj: insistir alarga el bloqueo en vez de acortarlo.
 */
export function registrarFallo(ip: string): void {
  const ahora = Date.now();
  const clave = normalizarIp(ip);
  const bloqueoMs = entorno.AUTH_BLOQUEO_MINUTOS * 60_000;
  const previo = fallosPorIp.get(clave);
  const conteo = previo && ahora < previo.expira ? previo.conteo + 1 : 1;

  fallosPorIp.set(clave, { conteo, expira: ahora + bloqueoMs });

  // Evita que un ataque desde muchas IP haga crecer el mapa sin limite.
  if (fallosPorIp.size > MAXIMO_IPS_VIGILADAS) purgarVencidos(ahora);
}

/** Borra el historial de una IP tras un intento correcto. */
export function limpiarFallos(ip: string): void {
  fallosPorIp.delete(normalizarIp(ip));
}

/** Solo para pruebas: deja el registro de bloqueos en cero. */
export function reiniciarBloqueos(): void {
  fallosPorIp.clear();
}
