import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { claveCifradoCola, entorno } from './env.ts';
import { ColaReintentos } from './cola/cola.ts';
import { allowlistActiva } from './security/perimetro.ts';
import { rutaCaptura } from './routes/captura.ts';
import { rutaReclamos } from './routes/reclamos.ts';
import { enviarReclamo } from './upstream/cliente.ts';
import type { DependenciasReclamos } from './routes/reclamos.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Cuerpo tal como llego, necesario para verificar la firma HMAC. */
    cuerpoCrudo?: string;
  }
  interface FastifyInstance {
    cola: ColaReintentos;
  }
}

const LIMITE_CUERPO_BYTES = 32 * 1024;

/** Campos que jamas deben aparecer en un log, por si alguien registra de mas. */
const CAMPOS_A_OCULTAR = [
  'req.headers["x-mgapi-key"]',
  'req.headers["x-mgapi-firma"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body',
  'body',
  'reclamo',
  '*.rut',
  '*.email',
  '*.telefono',
  '*.nombre',
  '*.patente',
];

const MENSAJE_POR_ESTADO: Record<number, string> = {
  400: 'solicitud_invalida',
  401: 'no_autorizado',
  404: 'no_encontrado',
  413: 'cuerpo_demasiado_grande',
  415: 'tipo_no_soportado',
  429: 'demasiadas_solicitudes',
};

export type OpcionesServidor = Partial<DependenciasReclamos>;

/**
 * Construye el servidor con todas sus capas de seguridad.
 * @param opciones permite inyectar cola y cliente externo en las pruebas
 */
export async function construirServidor(opciones: OpcionesServidor = {}): Promise<FastifyInstance> {
  const cola =
    opciones.cola ??
    new ColaReintentos({
      archivo: entorno.COLA_ARCHIVO,
      clave: claveCifradoCola,
      intentosMax: entorno.COLA_INTENTOS_MAX,
      intervaloMs: entorno.COLA_INTERVALO_MS,
      retencionMuertosDias: entorno.COLA_RETENCION_MUERTOS_DIAS,
    });
  const enviar = opciones.enviar ?? enviarReclamo;

  const app = Fastify({
    // Solo se cree la cabecera X-Forwarded-For si viene de Caddy. Con 'true'
    // cualquier cliente podria declarar su propia IP y burlar el limite de tasa.
    trustProxy: entorno.PROXY_CONFIABLE,
    bodyLimit: LIMITE_CUERPO_BYTES,
    // Se apaga el log automatico de Fastify porque incluye datos de la peticion.
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    logger: {
      level: entorno.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: { paths: CAMPOS_A_OCULTAR, remove: true },
    },
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: entorno.LIMITE_POR_MINUTO,
    timeWindow: '1 minute',
    // Se limita por IP; detras de Caddy trustProxy entrega la IP real.
    keyGenerator: (peticion) => peticion.ip,
  });

  // Guarda el cuerpo crudo para la firma HMAC antes de parsear el JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (peticion, cuerpo, listo) => {
    const texto = typeof cuerpo === 'string' ? cuerpo : cuerpo.toString('utf8');

    peticion.cuerpoCrudo = texto;

    try {
      listo(null, texto.length > 0 ? JSON.parse(texto) : {});
    } catch {
      // El mensaje del parser puede incluir un fragmento del cuerpo: se descarta.
      const error = Object.assign(new Error('json_invalido'), { statusCode: 400 });

      listo(error, undefined);
    }
  });

  app.addHook('onResponse', async (peticion, respuesta) => {
    app.log.info(
      {
        idCorrelacion: peticion.id,
        metodo: peticion.method,
        // Se registra el patron de la ruta, nunca la URL cruda.
        ruta: peticion.routeOptions.url ?? 'desconocida',
        estado: respuesta.statusCode,
        ms: Math.round(respuesta.elapsedTime),
      },
      'peticion',
    );
  });

  app.setErrorHandler((error: FastifyError, peticion, respuesta) => {
    const estado = typeof error.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500;

    // Se registra el codigo, nunca el mensaje: puede traer fragmentos del cuerpo.
    peticion.log.error({ idCorrelacion: peticion.id, estado, codigo: error.code ?? error.name }, 'error_manejado');

    return respuesta.code(estado).send({ error: MENSAJE_POR_ESTADO[estado] ?? 'error_interno' });
  });

  app.setNotFoundHandler((_peticion, respuesta) => respuesta.code(404).send({ error: 'no_encontrado' }));

  app.get('/salud', async () => ({ estado: 'ok', pendientes: cola.pendientes() }));

  await app.register(rutaReclamos({ cola, enviar }), { prefix: '/v1' });

  if (entorno.MODO_CAPTURA) {
    await app.register(rutaCaptura(), { prefix: '/v1' });
    app.log.warn(
      { capturaMaxima: entorno.CAPTURA_MAXIMA },
      'MODO_CAPTURA activo: /v1/captura esta abierto, sin clave, y devuelve todo lo que recibe. ' +
        'Se apaga solo al llegar al maximo. Apagarlo antes si ya se obtuvo el formato.',
    );
  }

  if (entorno.NODE_ENV === 'production' && !allowlistActiva()) {
    app.log.warn('IPS_GHL esta vacia: la unica defensa del endpoint es la clave compartida.');
  }

  app.decorate('cola', cola);
  cola.iniciar(enviar);
  app.addHook('onClose', async () => cola.cerrar());

  return app;
}
