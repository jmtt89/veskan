/**
 * Worker unico de SQLite para toda la aplicacion.
 *
 * NO es una optimizacion, es un requisito. La documentacion del VFS de OPFS es
 * explicita: "only one instance of this VFS can use the same directory
 * concurrently". Con un Worker por pais, dos instancias del VFS competirian por
 * el mismo directorio y corromperian el almacenamiento.
 *
 * Asi que aqui vive el unico Worker, y las fuentes logicas (una por pais)
 * cuelgan de el identificandose con un nombre.
 */

import type { WorkerRequest, WorkerResponse } from './sqlite.worker.js';

/**
 * `Omit<Union, K>` colapsa una union discriminada y pierde las variantes. Esta
 * version se distribuye sobre cada miembro y las conserva.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WorkerCommand = DistributiveOmit<WorkerRequest, 'id'>;

export type ProgressHandler = (p: { loaded: number; total: number }) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeout: number;
  onProgress?: ProgressHandler;
}

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./sqlite.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => handle(e.data);
  worker.onerror = (e) => {
    // Un fallo del Worker deja huerfanas todas las promesas en vuelo.
    const err = new Error(`Worker de SQLite: ${e.message}`);
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };
  return worker;
}

function handle(res: WorkerResponse): void {
  const entry = pending.get(res.id);
  if (!entry) return;

  // Los mensajes de progreso no resuelven la promesa: solo informan. Y
  // reinician el temporizador, porque una descarga lenta pero viva no debe
  // darse por perdida.
  if ('progress' in res) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pending.delete(res.id);
      entry.reject(new Error(`Operacion agotada tras ${entry.timeout} ms sin avance`));
    }, entry.timeout);
    entry.onProgress?.(res.progress);
    return;
  }

  clearTimeout(entry.timer);
  pending.delete(res.id);
  if (res.ok) entry.resolve(res.result);
  else entry.reject(new Error(res.error));
}

export function send<T = unknown>(
  msg: WorkerCommand,
  opts: { timeout?: number; onProgress?: ProgressHandler } = {},
): Promise<T> {
  const w = ensureWorker();
  const id = nextId++;
  const timeout = opts.timeout ?? 20_000;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Operacion agotada tras ${timeout} ms`));
    }, timeout);
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      timer,
      timeout,
      onProgress: opts.onProgress,
    });
    w.postMessage({ ...msg, id } as WorkerRequest);
  });
}

/**
 * Libera los manejadores de OPFS cuando la pagina se va.
 *
 * `pagehide` y no `beforeunload` porque es el unico que dispara de forma fiable
 * en movil, donde la pagina se descarta sin avisar. Sin esto, la siguiente
 * carga encuentra los manejadores retenidos por este contexto y el catalogo
 * queda inaccesible uno o dos segundos.
 */
if (typeof addEventListener === 'function') {
  addEventListener('pagehide', () => {
    if (!worker) return;
    // No se puede esperar: la pagina ya se esta yendo. Se envia y punto.
    try {
      worker.postMessage({ type: 'pause', id: nextId++ } satisfies WorkerRequest);
    } catch {
      /* el worker ya podria estar muerto */
    }
  });
}

/** Fuentes abiertas ahora mismo en el Worker. */
export function openSources(): Promise<string[]> {
  return send<string[]>({ type: 'list' });
}

/**
 * Termina el Worker. Solo para tests y para descargar la pagina: en uso normal
 * el Worker vive lo que viva la aplicacion.
 */
export function terminatePool(): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error('Worker terminado'));
  }
  pending.clear();
  worker?.terminate();
  worker = undefined;
}
