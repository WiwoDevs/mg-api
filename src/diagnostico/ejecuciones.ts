import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Bitacora de ejecuciones: una fila por cada llamada a POST /v1/reclamos,
 * salga bien o mal, para no perder las que fallan.
 *
 * No guarda cuerpos ni datos del reclamante: solo cuando llego, que resultado
 * tuvo, cuanto tardo y lo que respondio Zoho. Por eso puede estar siempre
 * encendida, a diferencia del diagnostico de entrada.
 */

const ESQUEMA = `
  CREATE TABLE IF NOT EXISTS ejecuciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creado INTEGER NOT NULL,
    id_correlacion TEXT NOT NULL,
    ip TEXT NOT NULL,
    http INTEGER NOT NULL,
    resultado TEXT NOT NULL,
    ms INTEGER NOT NULL,
    detalle TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ejecuciones_creado ON ejecuciones (creado);
  CREATE INDEX IF NOT EXISTS ejecuciones_resultado ON ejecuciones (resultado, id);
`;

/** Tope de caracteres por texto libre, para que una respuesta enorme no infle la bitacora. */
const LARGO_MAXIMO_TEXTO = 500;

/** Resultados que cuentan como exito; todo lo demas se considera falla. */
const RESULTADOS_OK = ['recibido', 'simulado', 'encolado'];

export type Ejecucion = {
  idCorrelacion: string;
  recibidoEn: string;
  ip: string;
  http: number;
  resultado: string;
  ms: number;
  detalle: Record<string, unknown>;
};

export type FiltroEjecuciones = {
  /** Solo las que no terminaron bien. */
  soloFallas?: boolean;
  /** Solo un resultado concreto, por ejemplo "reclamo_rechazado". */
  resultado?: string;
  limite: number;
};

export type OpcionesEjecuciones = {
  archivo: string;
  maximo: number;
  retencionDias: number;
};

/** Recorta un texto para que quepa en la bitacora. */
export function acotar(texto: string): string {
  return texto.length > LARGO_MAXIMO_TEXTO ? `${texto.slice(0, LARGO_MAXIMO_TEXTO)}…` : texto;
}

export class RegistroEjecuciones {
  readonly #db: DatabaseSync;
  readonly #opciones: OpcionesEjecuciones;

  constructor(opciones: OpcionesEjecuciones) {
    this.#opciones = opciones;
    mkdirSync(dirname(opciones.archivo), { recursive: true });
    this.#db = new DatabaseSync(opciones.archivo);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(ESQUEMA);
    chmodSync(opciones.archivo, 0o600);
  }

  /**
   * Anota una ejecucion y purga lo vencido.
   *
   * @param entrada lo ocurrido; `detalle` no debe llevar datos del reclamante
   */
  registrar(entrada: Omit<Ejecucion, 'recibidoEn'>): void {
    this.#db
      .prepare(
        'INSERT INTO ejecuciones (creado, id_correlacion, ip, http, resultado, ms, detalle) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        Date.now(),
        entrada.idCorrelacion,
        entrada.ip,
        entrada.http,
        entrada.resultado,
        entrada.ms,
        JSON.stringify(entrada.detalle),
      );

    this.purgar();
  }

  /** Borra lo mas antiguo que la retencion y lo que excede el maximo. */
  purgar(): void {
    const limite = Date.now() - this.#opciones.retencionDias * 86_400_000;

    this.#db.prepare('DELETE FROM ejecuciones WHERE creado < ?').run(limite);
    this.#db
      .prepare(
        'DELETE FROM ejecuciones WHERE id NOT IN (SELECT id FROM ejecuciones ORDER BY id DESC LIMIT ?)',
      )
      .run(this.#opciones.maximo);
  }

  /**
   * Lee ejecuciones, de la mas reciente a la mas antigua.
   *
   * @param filtro limite de filas y, opcionalmente, solo fallas o un resultado
   */
  leer(filtro: FiltroEjecuciones): Ejecucion[] {
    const condiciones: string[] = [];
    const valores: (string | number)[] = [];

    if (filtro.resultado) {
      condiciones.push('resultado = ?');
      valores.push(filtro.resultado);
    } else if (filtro.soloFallas) {
      condiciones.push(`resultado NOT IN (${RESULTADOS_OK.map(() => '?').join(', ')})`);
      valores.push(...RESULTADOS_OK);
    }

    const donde = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';
    const filas = this.#db
      .prepare(
        'SELECT creado, id_correlacion, ip, http, resultado, ms, detalle FROM ejecuciones ' +
          `${donde} ORDER BY id DESC LIMIT ?`,
      )
      .all(...valores, filtro.limite) as unknown as {
      creado: number;
      id_correlacion: string;
      ip: string;
      http: number;
      resultado: string;
      ms: number;
      detalle: string;
    }[];

    return filas.map((fila) => ({
      idCorrelacion: fila.id_correlacion,
      recibidoEn: new Date(fila.creado).toISOString(),
      ip: fila.ip,
      http: fila.http,
      resultado: fila.resultado,
      ms: fila.ms,
      detalle: JSON.parse(fila.detalle),
    }));
  }

  /** Cuenta ejecuciones por resultado sobre todo lo guardado. */
  resumen(): Record<string, number> {
    const filas = this.#db
      .prepare('SELECT resultado, COUNT(*) AS total FROM ejecuciones GROUP BY resultado')
      .all() as unknown as { resultado: string; total: number }[];

    return Object.fromEntries(filas.map((fila) => [fila.resultado, fila.total]));
  }

  cerrar(): void {
    this.#db.close();
  }
}
