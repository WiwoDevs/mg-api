import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cifrar, descifrar } from '../security/cifrado.ts';
import type { Reclamo } from '../schemas/reclamo.ts';
import type { ResultadoUpstream } from '../upstream/cliente.ts';

const ESQUEMA = `
  CREATE TABLE IF NOT EXISTS pendientes (
    id TEXT PRIMARY KEY,
    carga BLOB NOT NULL,
    intentos INTEGER NOT NULL DEFAULT 0,
    proximo_intento INTEGER NOT NULL,
    creado INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pendientes_proximo ON pendientes (proximo_intento);
  CREATE TABLE IF NOT EXISTS muertos (
    id TEXT PRIMARY KEY,
    carga BLOB NOT NULL,
    motivo TEXT NOT NULL,
    creado INTEGER NOT NULL
  );
`;

const ESPERA_MAXIMA_MS = 3_600_000;

type EnviarReclamo = (reclamo: Reclamo, idCorrelacion: string) => Promise<ResultadoUpstream>;

type FilaPendiente = { id: string; carga: Uint8Array; intentos: number };

export type OpcionesCola = {
  archivo: string;
  clave: Buffer;
  intentosMax: number;
  intervaloMs: number;
  retencionMuertosDias: number;
  registrar?: (evento: string, datos: Record<string, unknown>) => void;
};

/**
 * Cola en disco para reclamos que la API externa no pudo recibir todavia.
 *
 * El reclamo se guarda cifrado con AES-256-GCM y se borra en cuanto la entrega
 * se confirma: es transito con memoria corta, no almacenamiento.
 */
export class ColaReintentos {
  readonly #db: DatabaseSync;
  readonly #opciones: OpcionesCola;
  #temporizador: NodeJS.Timeout | undefined;
  #procesando = false;

  constructor(opciones: OpcionesCola) {
    this.#opciones = opciones;
    mkdirSync(dirname(opciones.archivo), { recursive: true });
    this.#db = new DatabaseSync(opciones.archivo);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(ESQUEMA);
    // Solo el usuario del servicio puede leer la cola.
    chmodSync(opciones.archivo, 0o600);
  }

  #log(evento: string, datos: Record<string, unknown>): void {
    this.#opciones.registrar?.(evento, datos);
  }

  /**
   * Guarda un reclamo cifrado para reintentar despues.
   * @returns el identificador de seguimiento que se devuelve a GHL
   */
  encolar(reclamo: Reclamo, idCorrelacion: string = randomUUID()): string {
    const ahora = Date.now();
    const carga = cifrar(JSON.stringify(reclamo), this.#opciones.clave);

    this.#db
      .prepare('INSERT INTO pendientes (id, carga, intentos, proximo_intento, creado) VALUES (?, ?, 0, ?, ?)')
      .run(idCorrelacion, carga, ahora, ahora);

    this.#log('reclamo_encolado', { idCorrelacion });

    return idCorrelacion;
  }

  /** Cantidad de reclamos esperando entrega. */
  pendientes(): number {
    const fila = this.#db.prepare('SELECT COUNT(*) AS total FROM pendientes').get() as { total: number };

    return fila.total;
  }

  /** Cantidad de reclamos que agotaron sus reintentos. */
  muertos(): number {
    const fila = this.#db.prepare('SELECT COUNT(*) AS total FROM muertos').get() as { total: number };

    return fila.total;
  }

  #aMuertos(fila: FilaPendiente, motivo: string): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO muertos (id, carga, motivo, creado) VALUES (?, ?, ?, ?)')
      .run(fila.id, fila.carga, motivo, Date.now());
    this.#db.prepare('DELETE FROM pendientes WHERE id = ?').run(fila.id);
    this.#log('reclamo_a_cola_muerta', { idCorrelacion: fila.id, motivo, intentos: fila.intentos });
  }

  #reprogramar(fila: FilaPendiente, detalle: string): void {
    const intentos = fila.intentos + 1;

    if (intentos >= this.#opciones.intentosMax) {
      this.#aMuertos({ ...fila, intentos }, detalle);

      return;
    }

    const espera = Math.min(2 ** intentos * this.#opciones.intervaloMs, ESPERA_MAXIMA_MS);

    this.#db
      .prepare('UPDATE pendientes SET intentos = ?, proximo_intento = ? WHERE id = ?')
      .run(intentos, Date.now() + espera, fila.id);
    this.#log('reintento_programado', { idCorrelacion: fila.id, intentos, esperaMs: espera });
  }

  /**
   * Intenta entregar los reclamos vencidos.
   * @param enviar funcion que habla con la API externa
   */
  async procesarPendientes(enviar: EnviarReclamo): Promise<void> {
    if (this.#procesando) return;
    this.#procesando = true;

    try {
      const filas = this.#db
        .prepare('SELECT id, carga, intentos FROM pendientes WHERE proximo_intento <= ? ORDER BY creado LIMIT 20')
        .all(Date.now()) as unknown as FilaPendiente[];

      for (const fila of filas) {
        let reclamo: Reclamo;

        try {
          reclamo = JSON.parse(descifrar(Buffer.from(fila.carga), this.#opciones.clave)) as Reclamo;
        } catch {
          // Clave rotada sin migrar o fila corrupta: no se puede recuperar reintentando.
          this.#aMuertos(fila, 'no se pudo descifrar');
          continue;
        }

        const resultado = await enviar(reclamo, fila.id);

        if (resultado.ok) {
          this.#db.prepare('DELETE FROM pendientes WHERE id = ?').run(fila.id);
          this.#log('reclamo_entregado', { idCorrelacion: fila.id, intentos: fila.intentos });
        } else if (resultado.reintentable) {
          this.#reprogramar(fila, resultado.detalle);
        } else {
          this.#aMuertos(fila, resultado.detalle);
        }
      }
    } finally {
      this.#procesando = false;
    }
  }

  /** Borra los reclamos muertos que superaron la retencion configurada. */
  purgarMuertos(): void {
    const limite = Date.now() - this.#opciones.retencionMuertosDias * 86_400_000;

    this.#db.prepare('DELETE FROM muertos WHERE creado < ?').run(limite);
  }

  /** Arranca el ciclo periodico de reintentos. */
  iniciar(enviar: EnviarReclamo): void {
    if (this.#temporizador) return;

    this.#temporizador = setInterval(() => {
      this.purgarMuertos();
      void this.procesarPendientes(enviar);
    }, this.#opciones.intervaloMs);
    this.#temporizador.unref();
  }

  detener(): void {
    if (!this.#temporizador) return;
    clearInterval(this.#temporizador);
    this.#temporizador = undefined;
  }

  cerrar(): void {
    this.detener();
    this.#db.close();
  }
}
