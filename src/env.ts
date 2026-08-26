import { z } from 'zod';

/** Variables que, si faltan o vienen mal, hacen que el proceso no arranque. */

const booleano = z
  .enum(['true', 'false'])
  .default('false')
  .transform((valor) => valor === 'true');

const urlAbsoluta = z
  .string()
  .refine((valor) => URL.canParse(valor), 'debe ser una URL absoluta valida');

const claveBase64De32Bytes = z.string().refine((valor) => {
  try {
    return Buffer.from(valor, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'debe ser 32 bytes codificados en base64');

const esquemaEntorno = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PUERTO: z.coerce.number().int().min(1).max(65535).default(3000),

  // Perimetro: quien puede llegar al endpoint. La misma lista que usa el Caddyfile,
  // asi no hay dos variables que decir lo mismo y se desincronicen.
  // Separada por comas o espacios. Acepta IPv4 y bloques CIDR (1.2.3.0/24).
  // Vacia significa sin filtro de IP en la aplicacion.
  IPS_GHL: z.string().default(''),
  // Desde donde se acepta la cabecera X-Forwarded-For. Nunca poner 'true':
  // eso deja que el propio cliente declare su IP y burle el limite de tasa.
  PROXY_CONFIABLE: z.string().default('uniquelocal'),
  AUTH_FALLOS_MAX: z.coerce.number().int().positive().default(10),
  AUTH_BLOQUEO_MINUTOS: z.coerce.number().int().positive().default(15),

  // Identidad del llamante (GHL)
  MGAPI_KEY: z.string().min(32, 'usa al menos 32 caracteres aleatorios'),
  HMAC_ACTIVO: booleano,
  HMAC_SECRETO: z.string().min(32).optional(),
  HMAC_VENTANA_SEGUNDOS: z.coerce.number().int().positive().default(300),

  // API externa (Zoho)
  // Con UPSTREAM_ACTIVO=false no se llama a Zoho: el reclamo se valida y se
  // responde lo que se le habria enviado. Sirve para probar la ingesta desde
  // GHL antes de tener credenciales. Ver docs/05-modos-de-prueba.md
  UPSTREAM_ACTIVO: z.enum(['true', 'false']).default('true').transform((valor) => valor === 'true'),
  UPSTREAM_URL: urlAbsoluta.optional(),

  // Credenciales OAuth de Zoho. Viven solo aqui: GHL no debe volver a verlas.
  // El dominio cambia segun el centro de datos: .com, .eu, .in, .com.au
  ZOHO_CUENTAS_URL: urlAbsoluta.default('https://accounts.zoho.com'),
  ZOHO_CLIENT_ID: z.string().min(1).optional(),
  ZOHO_CLIENT_SECRET: z.string().min(1).optional(),
  ZOHO_REFRESH_TOKEN: z.string().min(1).optional(),
  // Cuanto antes de que venza se renueva el token, para que ninguno caduque en vuelo.
  ZOHO_MARGEN_SEGUNDOS: z.coerce.number().int().positive().default(60),
  // Nombre del argumento con el que la funcion de Zoho recibe el caso.
  ZOHO_ARGUMENTO_CASO: z.string().min(1).default('case'),
  // Espera antes de llamar a la funcion. El flujo anterior en GHL la necesitaba;
  // aqui probablemente no, porque el token se espera de verdad. Ver docs/07.
  ZOHO_ESPERA_MS: z.coerce.number().int().min(0).max(30_000).default(0),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  UPSTREAM_PRESUPUESTO_DIARIO: z.coerce.number().int().positive().default(1000),

  // Cola de reintentos
  COLA_ARCHIVO: z.string().default('./datos/cola.sqlite'),
  COLA_CLAVE_CIFRADO: claveBase64De32Bytes,
  COLA_INTENTOS_MAX: z.coerce.number().int().positive().default(6),
  COLA_INTERVALO_MS: z.coerce.number().int().positive().default(15_000),
  COLA_RETENCION_MUERTOS_DIAS: z.coerce.number().int().positive().default(7),

  // Abuso
  LIMITE_POR_MINUTO: z.coerce.number().int().positive().default(60),

  // Modo captura: endpoint abierto y temporal para descubrir que manda GHL.
  // Se apaga solo tras CAPTURA_MAXIMA peticiones. Ver docs/05-modos-de-prueba.md
  MODO_CAPTURA: booleano,
  CAPTURA_MAXIMA: z.coerce.number().int().positive().max(500).default(50),
});

/**
 * Lee y valida el entorno. Ante cualquier problema corta el arranque.
 * Solo imprime nombres de variables y el motivo: nunca el valor recibido,
 * porque estos valores son secretos.
 */
function cargarEntorno(): z.infer<typeof esquemaEntorno> {
  const resultado = esquemaEntorno.safeParse(process.env);

  if (!resultado.success) {
    const problemas = resultado.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join('\n');
    console.error(`Configuracion invalida. Revisa el archivo .env:\n${problemas}`);
    process.exit(1);
  }

  if (resultado.data.HMAC_ACTIVO && !resultado.data.HMAC_SECRETO) {
    console.error('Configuracion invalida: HMAC_ACTIVO=true requiere HMAC_SECRETO.');
    process.exit(1);
  }

  // Las credenciales de Zoho solo son obligatorias si de verdad se va a llamar.
  if (resultado.data.UPSTREAM_ACTIVO) {
    const faltantes = (
      ['UPSTREAM_URL', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN'] as const
    ).filter((nombre) => !resultado.data[nombre]);

    if (faltantes.length > 0) {
      console.error(
        `Configuracion invalida: UPSTREAM_ACTIVO=true requiere ${faltantes.join(', ')}. ` +
          'Para probar sin Zoho, usa UPSTREAM_ACTIVO=false.',
      );
      process.exit(1);
    }
  }

  return resultado.data;
}

export const entorno = cargarEntorno();

export const claveCifradoCola = Buffer.from(entorno.COLA_CLAVE_CIFRADO, 'base64');
