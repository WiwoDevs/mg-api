import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { entorno } from '../env.ts';
import { verificarClave } from '../security/autenticacion.ts';

/**
 * Modo captura: endpoint abierto y temporal para descubrir el formato exacto
 * en que un origen externo (GHL) envia sus datos.
 *
 * Es deliberadamente inseguro: no pide clave y devuelve todo lo que recibe.
 * Por eso se apaga solo tras CAPTURA_MAXIMA peticiones, en vez de depender de
 * que alguien se acuerde de bajar la bandera.
 */

/** Cabeceras que nunca se devuelven ni se registran, aunque el llamante las mande. */
const CABECERAS_SECRETAS = new Set(['x-mgapi-key', 'x-mgapi-firma', 'authorization', 'cookie']);

type Captura = {
  numero: number;
  recibidoEn: string;
  metodo: string;
  ip: string;
  cabeceras: Record<string, string | string[]>;
  cuerpoCrudo: string;
  cuerpo: unknown;
};

const capturas: Captura[] = [];

/** Quita las cabeceras secretas para no devolverle al llamante nuestra propia clave. */
function cabecerasSeguras(
  cabeceras: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const limpias: Record<string, string | string[]> = {};

  for (const [nombre, valor] of Object.entries(cabeceras)) {
    if (valor === undefined) continue;
    limpias[nombre] = CABECERAS_SECRETAS.has(nombre.toLowerCase()) ? '[oculto]' : valor;
  }

  return limpias;
}

/** Lee el cuerpo como JSON. @returns null si no era JSON valido */
function interpretarCuerpo(cuerpoCrudo: string): unknown {
  try {
    return JSON.parse(cuerpoCrudo);
  } catch {
    return null;
  }
}

/** Solo para pruebas: vacia las capturas acumuladas. */
export function reiniciarCapturas(): void {
  capturas.length = 0;
}

export function rutaCaptura(): FastifyPluginAsync {
  return async function registrar(app: FastifyInstance): Promise<void> {
    // Acepta cualquier tipo de contenido: GHL podria mandar JSON, formulario o texto.
    // El parser vive solo en este plugin, asi /v1/reclamos conserva su exigencia de JSON.
    app.addContentTypeParser('*', { parseAs: 'string' }, (peticion, cuerpo, listo) => {
      const texto = typeof cuerpo === 'string' ? cuerpo : cuerpo.toString('utf8');

      peticion.cuerpoCrudo = texto;
      listo(null, texto);
    });

    app.post('/captura', async (peticion, respuesta) => {
      if (capturas.length >= entorno.CAPTURA_MAXIMA) {
        return respuesta.code(410).send({
          error: 'captura_agotada',
          mensaje: `Se alcanzaron las ${entorno.CAPTURA_MAXIMA} capturas. El endpoint se apago solo.`,
        });
      }

      const captura: Captura = {
        numero: capturas.length + 1,
        recibidoEn: new Date().toISOString(),
        metodo: peticion.method,
        ip: peticion.ip,
        cabeceras: cabecerasSeguras(peticion.headers),
        cuerpoCrudo: peticion.cuerpoCrudo ?? '',
        cuerpo: interpretarCuerpo(peticion.cuerpoCrudo ?? ''),
      };

      capturas.push(captura);
      // Unico lugar del sistema donde se registra un cuerpo, y solo en modo captura.
      peticion.log.warn({ captura }, 'modo_captura_peticion_recibida');

      return respuesta.code(200).send({
        recibido: captura,
        captura: { numero: captura.numero, restantes: entorno.CAPTURA_MAXIMA - capturas.length },
      });
    });

    // La lectura si pide clave: GHL no siempre muestra el cuerpo de la respuesta.
    app.get('/capturas', async (peticion, respuesta) => {
      const resultado = verificarClave(peticion.headers);

      if (!resultado.ok) return respuesta.code(401).send({ error: 'no_autorizado' });

      return respuesta.send({ total: capturas.length, capturas });
    });
  };
}
