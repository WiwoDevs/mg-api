import { z } from 'zod';
import { entorno } from '../env.ts';

/**
 * Obtencion y cache del access token de Zoho.
 *
 * El refresh token vive solo aqui, en variables de entorno del servidor. Antes
 * lo guardaba GoHighLevel dentro de la configuracion del webhook, donde lo veia
 * cualquiera con acceso a esa cuenta y no se podia rotar sin editar el flujo.
 *
 * El token dura una hora, asi que se guarda en memoria y se renueva solo cuando
 * esta por vencer: un reclamo no cuesta dos peticiones a Zoho.
 */

export type Credencial = { token: string; apiDomain: string };

export type ResultadoCredencial =
  | { ok: true; credencial: Credencial }
  | { ok: false; reintentable: boolean; detalle: string };

/**
 * Zoho responde HTTP 200 tambien cuando falla, con un campo "error" en el
 * cuerpo. Por eso no basta con mirar el codigo de estado.
 */
const esquemaRespuesta = z.union([
  z.object({
    access_token: z.string().min(1),
    api_domain: z.string().min(1),
    expires_in: z.number().positive(),
  }),
  z.object({ error: z.string() }),
]);

/** Errores de configuracion: reintentar no los arregla. */
const ERRORES_DEFINITIVOS = new Set([
  'invalid_client',
  'invalid_client_secret',
  'invalid_code',
  'unauthorized_client',
  'access_denied',
]);

let cache: { credencial: Credencial; venceEn: number } | undefined;
/** Peticion en curso, para que diez reclamos simultaneos pidan un solo token. */
let enVuelo: Promise<ResultadoCredencial> | undefined;

/** Descarta el token guardado. Se usa cuando Zoho lo rechaza antes de tiempo. */
export function invalidarCredencial(): void {
  cache = undefined;
}

async function pedirTokenAZoho(): Promise<ResultadoCredencial> {
  // Zoho espera estos cuatro valores como parametros de consulta: es el unico
  // formato que acepta su endpoint de token.
  const url = new URL('/oauth/v2/token', entorno.ZOHO_CUENTAS_URL);

  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('refresh_token', entorno.ZOHO_REFRESH_TOKEN as string);
  url.searchParams.set('client_id', entorno.ZOHO_CLIENT_ID as string);
  url.searchParams.set('client_secret', entorno.ZOHO_CLIENT_SECRET as string);

  let respuesta: Response;

  try {
    respuesta = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(entorno.UPSTREAM_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    const nombre = error instanceof Error ? error.name : 'error desconocido';

    return { ok: false, reintentable: true, detalle: `red: ${nombre}` };
  }

  if (!respuesta.ok) {
    await respuesta.body?.cancel();

    return {
      ok: false,
      reintentable: respuesta.status >= 500 || respuesta.status === 429,
      detalle: `estado ${respuesta.status}`,
    };
  }

  const cuerpo = await respuesta.json().catch(() => null);
  const leido = esquemaRespuesta.safeParse(cuerpo);

  if (!leido.success) {
    // El cuerpo puede traer el token: no se registra ni se devuelve.
    return { ok: false, reintentable: true, detalle: 'respuesta de Zoho ilegible' };
  }

  if ('error' in leido.data) {
    const codigo = leido.data.error;

    return {
      ok: false,
      reintentable: !ERRORES_DEFINITIVOS.has(codigo),
      detalle: `Zoho respondio "${codigo}"`,
    };
  }

  const credencial: Credencial = {
    token: leido.data.access_token,
    apiDomain: leido.data.api_domain,
  };
  const margenMs = entorno.ZOHO_MARGEN_SEGUNDOS * 1000;

  cache = {
    credencial,
    // Se renueva antes de vencer para que ningun reclamo salga con un token
    // que caduca mientras viaja.
    venceEn: Date.now() + leido.data.expires_in * 1000 - margenMs,
  };

  return { ok: true, credencial };
}

/**
 * Devuelve un access token valido, del cache o pidiendo uno nuevo.
 *
 * @param forzar descarta el cache y pide uno nuevo aunque el guardado siga vigente
 */
export async function obtenerCredencial(forzar = false): Promise<ResultadoCredencial> {
  if (forzar) invalidarCredencial();

  if (cache && Date.now() < cache.venceEn) {
    return { ok: true, credencial: cache.credencial };
  }

  // Si ya hay una peticion en curso, se espera esa en vez de abrir otra.
  enVuelo ??= pedirTokenAZoho().finally(() => {
    enVuelo = undefined;
  });

  return enVuelo;
}
