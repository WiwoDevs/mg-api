import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cifrar, descifrar } from '../security/cifrado.ts';

/**
 * Registro de peticiones rechazadas, para poder leerlas despues.
 *
 * Existe solo mientras DIAGNOSTICO_ENTRADA este encendido: guarda cuerpos tal
 * como llegaron, con datos personales adentro. Por eso van cifrados igual que
 * la cola, se guardan pocos y se borran solos.
 */

const ESQUEMA = `
  CREATE TABLE IF NOT EXISTS rechazos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creado INTEGER NOT NULL,
    forma TEXT NOT NULL,
    campos TEXT NOT NULL,
    carga BLOB NOT NULL
  );
`;

export type EntradaRechazo = {
  idCorrelacion: string;
  recibidoEn: string;
  forma: string;
  campos: { campo: string; mensaje: string }[];
  cuerpoRecibido: string;
};

export type OpcionesRegistro = {
  archivo: string;
  clave: Buffer;
  maximo: number;
  retencionHoras: number;
};

export class RegistroDiagnostico {
  readonly #db: DatabaseSync;
  readonly #opciones: OpcionesRegistro;

  constructor(opciones: OpcionesRegistro) {
    this.#opciones = opciones;
    mkdirSync(dirname(opciones.archivo), { recursive: true });
    this.#db = new DatabaseSync(opciones.archivo);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(ESQUEMA);
    chmodSync(opciones.archivo, 0o600);
  }

  /**
   * Guarda una peticion rechazada.
   *
   * @param entrada lo que llego y por que se rechazo
   */
  registrar(entrada: Omit<EntradaRechazo, 'recibidoEn'>): void {
    const carga = cifrar(
      JSON.stringify({ idCorrelacion: entrada.idCorrelacion, cuerpo: entrada.cuerpoRecibido }),
      this.#opciones.clave,
    );

    this.#db
      .prepare('INSERT INTO rechazos (creado, forma, campos, carga) VALUES (?, ?, ?, ?)')
      .run(Date.now(), entrada.forma, JSON.stringify(entrada.campos), carga);

    this.purgar();
  }

  /** Borra lo vencido y lo que sobra del maximo, para no acumular sin limite. */
  purgar(): void {
    const limite = Date.now() - this.#opciones.retencionHoras * 3_600_000;

    this.#db.prepare('DELETE FROM rechazos WHERE creado < ?').run(limite);
    this.#db
      .prepare(
        'DELETE FROM rechazos WHERE id NOT IN (SELECT id FROM rechazos ORDER BY id DESC LIMIT ?)',
      )
      .run(this.#opciones.maximo);
  }

  /**
   * Devuelve los rechazos guardados, del mas reciente al mas antiguo.
   * Una fila que no se pueda descifrar se informa en vez de tumbar la lectura.
   */
  leer(): EntradaRechazo[] {
    const filas = this.#db
      .prepare('SELECT creado, forma, campos, carga FROM rechazos ORDER BY id DESC')
      .all() as unknown as { creado: number; forma: string; campos: string; carga: Uint8Array }[];

    return filas.map((fila) => {
      let idCorrelacion = 'desconocido';
      let cuerpoRecibido = '';

      try {
        const contenido = JSON.parse(descifrar(Buffer.from(fila.carga), this.#opciones.clave));

        idCorrelacion = contenido.idCorrelacion;
        cuerpoRecibido = contenido.cuerpo;
      } catch {
        cuerpoRecibido = '[no se pudo descifrar: la clave cambio desde que se guardo]';
      }

      return {
        idCorrelacion,
        recibidoEn: new Date(fila.creado).toISOString(),
        forma: fila.forma,
        campos: JSON.parse(fila.campos),
        cuerpoRecibido,
      };
    });
  }

  /** Cuantos rechazos hay guardados. */
  total(): number {
    const fila = this.#db.prepare('SELECT COUNT(*) AS total FROM rechazos').get() as {
      total: number;
    };

    return fila.total;
  }

  /** Borra todo lo guardado. */
  vaciar(): void {
    this.#db.exec('DELETE FROM rechazos;');
  }

  cerrar(): void {
    this.#db.close();
  }
}
