import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { verificarClave, verificarFirma } from '../security/autenticacion.ts';
import { estaBloqueada, ipPermitida, limpiarFallos, registrarFallo } from '../security/perimetro.ts';
import { mapearRespuesta } from '../schemas/reclamo.ts';
import { procesarPayloadGhl } from '../schemas/ingesta-ghl.ts';
import { mapearAZoho } from '../upstream/zoho.ts';
import { consumirPresupuesto } from '../upstream/cliente.ts';
import type { ColaReintentos } from '../cola/cola.ts';
import type { Reclamo } from '../schemas/reclamo.ts';
import type { ResultadoUpstream } from '../upstream/cliente.ts';

export type DependenciasReclamos = {
  cola: ColaReintentos;
  enviar: (reclamo: Reclamo, idCorrelacion: string) => Promise<ResultadoUpstream>;
};

/**
 * Ruta de ingreso de reclamos. Todo lo que entra aqui esta autenticado,
 * validado de forma estricta y nunca se registra en los logs.
 */
export function rutaReclamos({ cola, enviar }: DependenciasReclamos): FastifyPluginAsync {
  return async function registrar(app: FastifyInstance): Promise<void> {
    // Primera barrera, antes de leer el cuerpo: a un desconocido no se le parsea nada.
    app.addHook('onRequest', async (peticion, respuesta) => {
      const ip = peticion.ip;

      if (estaBloqueada(ip)) {
        peticion.log.warn({ idCorrelacion: peticion.id, ip }, 'ip_bloqueada_por_intentos_fallidos');

        return respuesta.code(429).send({ error: 'demasiadas_solicitudes' });
      }

      // La IP denegada recibe la misma respuesta que la clave incorrecta:
      // sondear desde afuera no revela si existe una allowlist.
      if (!ipPermitida(ip)) {
        registrarFallo(ip);
        peticion.log.warn({ idCorrelacion: peticion.id, ip }, 'ip_fuera_de_allowlist');

        return respuesta.code(401).send({ error: 'no_autorizado' });
      }

      const resultado = verificarClave(peticion.headers);

      if (!resultado.ok) {
        registrarFallo(ip);
        // El motivo queda en el log interno; el cliente solo recibe "no_autorizado".
        peticion.log.warn({ idCorrelacion: peticion.id, ip, motivo: resultado.motivo }, 'autenticacion_rechazada');

        return respuesta.code(401).send({ error: 'no_autorizado' });
      }

      limpiarFallos(ip);

      // Se exige JSON aqui y no solo por el parser: los parsers de Fastify se
      // comparten entre plugins hermanos, y el modo captura registra uno abierto.
      const tipo = peticion.headers['content-type'] ?? '';

      if (!tipo.toLowerCase().startsWith('application/json')) {
        return respuesta.code(415).send({ error: 'tipo_no_soportado' });
      }
    });

    // Segunda barrera: la firma necesita el cuerpo, asi que va despues de recibirlo.
    app.addHook('preHandler', async (peticion, respuesta) => {
      const resultado = verificarFirma(peticion.headers, peticion.cuerpoCrudo ?? '');

      if (!resultado.ok) {
        registrarFallo(peticion.ip);
        peticion.log.warn(
          { idCorrelacion: peticion.id, ip: peticion.ip, motivo: resultado.motivo },
          'firma_rechazada',
        );

        return respuesta.code(401).send({ error: 'no_autorizado' });
      }
    });

    app.post('/reclamos', async (peticion, respuesta) => {
      // Del cuerpo crudo de GHL al reclamo limpio: forma, seleccion por nombre,
      // formato de cada campo y existencia en el catalogo oficial de MG.
      const ingesta = procesarPayloadGhl(peticion.body);

      if (!ingesta.ok) {
        // Se devuelven nombres de campo y motivo, nunca el valor recibido.
        return respuesta.code(400).send({ error: 'entrada_invalida', campos: ingesta.errores });
      }

      const reclamo = ingesta.reclamo;
      const idCorrelacion = String(peticion.id);

      if (!consumirPresupuesto()) {
        peticion.log.error({ idCorrelacion }, 'presupuesto_diario_agotado');

        return respuesta.code(429).send({ error: 'presupuesto_agotado' });
      }

      const resultado = await enviar(reclamo, idCorrelacion);

      if (resultado.ok && resultado.simulado) {
        // Modo sin Zoho: se devuelve lo que se le habria enviado, para poder
        // revisar el resultado de la validacion y la limpieza desde GHL.
        return respuesta.code(200).send({
          estado: 'simulado',
          idCorrelacion,
          mensaje: 'UPSTREAM_ACTIVO=false: no se envio nada a Zoho.',
          seHabriaEnviado: mapearAZoho(reclamo),
        });
      }

      if (resultado.ok) {
        // El resumen va anidado para que un campo de la API externa no pueda
        // pisar los campos propios de esta respuesta.
        return respuesta.code(200).send({
          estado: 'recibido',
          idCorrelacion,
          resumen: mapearRespuesta(resultado.datos),
        });
      }

      if (!resultado.reintentable) {
        peticion.log.warn({ idCorrelacion, detalle: resultado.detalle }, 'reclamo_rechazado_por_api_externa');

        return respuesta.code(422).send({ error: 'reclamo_rechazado' });
      }

      cola.encolar(reclamo, idCorrelacion);
      peticion.log.warn({ idCorrelacion, detalle: resultado.detalle }, 'api_externa_no_disponible');

      return respuesta.code(202).send({ estado: 'encolado', idCorrelacion });
    });
  };
}
