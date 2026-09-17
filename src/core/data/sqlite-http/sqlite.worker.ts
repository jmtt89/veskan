/**
 * Worker que hospeda SQLite-WASM con el VFS de HTTP Range.
 *
 * Vive en un Worker por obligacion tecnica, no por gusto: `RangeReader` usa
 * XMLHttpRequest sincrono, que el navegador prohibe en el hilo principal.
 */

/// <reference lib="webworker" />

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { installHttpVfs, VFS_NAME, warmup, getReaderStats } from './http-vfs.js';
import { getCached, putCached, pruneExcept } from './blob-cache.js';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

export type WorkerRequest =
  | {
      id: number;
      type: 'open';
      url: string;
      /**
       * `range`    consulta solo las paginas necesarias. Para bases grandes.
       * `download` baja el archivo entero una vez y lo guarda. Despues funciona
       *            SIN CONEXION, que es lo que hace util esta app en un
       *            supermercado con mala cobertura.
       */
      strategy?: 'range' | 'download';
      /** Clave de cache; normalmente el pais */
      cacheKey?: string;
      /** Fecha del indice: si cambia, la copia guardada se descarta */
      generatedAt?: string;
      blockSize?: number;
      maxBlocks?: number;
    }
  | { id: number; type: 'query'; sql: string; params?: unknown[] }
  | { id: number; type: 'get'; sql: string; params?: unknown[] }
  | { id: number; type: 'stats' }
  | { id: number; type: 'close' };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  /** Progreso de descarga, para poder mostrar una barra en vez de un spinner mudo */
  | { id: number; progress: { loaded: number; total: number } };

let sqlite3: Sqlite3 | undefined;
let dbHandle: { exec: (opts: unknown) => unknown; close: () => void } | undefined;

async function ensureSqlite(): Promise<Sqlite3> {
  if (!sqlite3) {
    // El .d.mts publicado declara `init()` sin argumentos, pero en tiempo de
    // ejecucion acepta las opciones de Emscripten. Sin este cast, silenciaria
    // los logs seria imposible.
    const init = sqlite3InitModule as unknown as (opts: {
      print?: (msg: string) => void;
      printErr?: (msg: string) => void;
    }) => Promise<Sqlite3>;
    sqlite3 = await init({
      print: () => {},
      printErr: (msg: string) => console.error('[sqlite]', msg),
    });
  }
  return sqlite3;
}

async function openWithRange(url: string, blockSize?: number, maxBlocks?: number) {
  const api = await ensureSqlite();
  installHttpVfs(api as never, { url, blockSize, maxBlocks });
  warmup();

  // `immutable=1` le dice a SQLite que el archivo no cambia mientras esta
  // abierto: se salta el journal, los bloqueos y las comprobaciones de cambio,
  // que es exactamente la semantica de un objeto estatico servido por CDN.
  const oo1 = (api as unknown as { oo1: { DB: new (opts: unknown) => never } }).oo1;
  dbHandle = new (oo1.DB as never as new (o: unknown) => {
    exec: (opts: unknown) => unknown;
    close: () => void;
  })({
    filename: `file:remote.sqlite3?vfs=${VFS_NAME}&immutable=1&mode=ro`,
    flags: 'r',
  });
  return { ok: true as const, strategy: 'range' as const };
}

/**
 * Descarga el archivo entero y lo abre en memoria.
 *
 * Merece la pena cuando la base es pequena: un SQLite comprime ~71% por la red,
 * asi que la de Venezuela son ~0,3 MB, menos que dos consultas por rangos. Y a
 * diferencia de los rangos, una vez guardada funciona sin conexion.
 */
async function openWithDownload(
  url: string,
  id: number,
  cacheKey?: string,
  generatedAt?: string,
) {
  const api = await ensureSqlite();
  const key = cacheKey ?? url;

  let bytes: Uint8Array | undefined;
  const cached = await getCached(key);
  // Solo se reutiliza si el indice no ha publicado una version mas nueva.
  if (cached && (!generatedAt || cached.generatedAt === generatedAt)) {
    bytes = new Uint8Array(cached.bytes);
  }

  if (!bytes) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo descargar el snapshot (HTTP ${res.status})`);
    const total = Number(res.headers.get('Content-Length') ?? 0);

    if (res.body && total > 0) {
      // Lectura por trozos para poder informar del progreso: en una conexion
      // lenta, una barra es muy distinto de un spinner que no dice nada.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        self.postMessage({ id, progress: { loaded, total } } satisfies WorkerResponse);
      }
      bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
    }

    await putCached({
      key,
      bytes: bytes.buffer.slice(0) as ArrayBuffer,
      generatedAt: generatedAt ?? '',
      storedAt: Date.now(),
    });
    // Guardar la base de otro pais no aporta nada y ocupa megas.
    await pruneExcept(key);
  }

  const capi = (api as unknown as { capi: Record<string, never> }).capi;
  const wasm = (api as unknown as {
    wasm: { allocFromTypedArray(a: Uint8Array): number };
  }).wasm;
  const oo1 = (api as unknown as { oo1: { DB: new () => { pointer: number } } }).oo1;

  const db = new oo1.DB() as unknown as {
    pointer: number;
    exec: (opts: unknown) => unknown;
    close: () => void;
  };
  const ptr = wasm.allocFromTypedArray(bytes);
  const deserialize = capi['sqlite3_deserialize'] as unknown as (
    db: number, schema: string, p: number, sz: number, cap: number, flags: number,
  ) => number;
  const FREEONCLOSE = capi['SQLITE_DESERIALIZE_FREEONCLOSE'] as unknown as number;
  const RESIZEABLE = capi['SQLITE_DESERIALIZE_RESIZEABLE'] as unknown as number;
  const rc = deserialize(db.pointer, 'main', ptr, bytes.length, bytes.length, FREEONCLOSE | RESIZEABLE);
  if (rc !== 0) throw new Error(`sqlite3_deserialize fallo con codigo ${rc}`);

  dbHandle = db;
  return { ok: true as const, strategy: 'download' as const, bytes: bytes.length };
}

function query(sql: string, params?: unknown[]): Record<string, unknown>[] {
  if (!dbHandle) throw new Error('La base remota no esta abierta');
  const rows: Record<string, unknown>[] = [];
  dbHandle.exec({
    sql,
    bind: params,
    rowMode: 'object',
    callback: (row: Record<string, unknown>) => {
      rows.push(row);
    },
  });
  return rows;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  const reply = (res: WorkerResponse) => self.postMessage(res);

  try {
    switch (msg.type) {
      case 'open': {
        const result =
          msg.strategy === 'download'
            ? await openWithDownload(msg.url, msg.id, msg.cacheKey, msg.generatedAt)
            : await openWithRange(msg.url, msg.blockSize, msg.maxBlocks);
        reply({ id: msg.id, ok: true, result });
        break;
      }
      case 'query':
        reply({ id: msg.id, ok: true, result: query(msg.sql, msg.params) });
        break;
      case 'get': {
        const rows = query(msg.sql, msg.params);
        reply({ id: msg.id, ok: true, result: rows[0] ?? null });
        break;
      }
      case 'stats':
        reply({ id: msg.id, ok: true, result: getReaderStats() ?? null });
        break;
      case 'close':
        dbHandle?.close();
        dbHandle = undefined;
        reply({ id: msg.id, ok: true, result: null });
        break;
    }
  } catch (err) {
    reply({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
