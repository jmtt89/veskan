/**
 * Worker que hospeda SQLite-WASM.
 *
 * Vive en un Worker por dos obligaciones tecnicas, no por gusto:
 *
 *  1. `RangeReader` usa XMLHttpRequest sincrono, que el navegador prohibe en el
 *     hilo principal.
 *  2. El VFS de OPFS necesita `createSyncAccessHandle`, que solo existe en
 *     Workers.
 *
 * Y es UN SOLO Worker para toda la aplicacion, tambien por obligacion: la
 * documentacion del VFS de OPFS es explicita en que "only one instance of this
 * VFS can use the same directory concurrently". Un Worker por pais corromperia
 * el almacenamiento.
 */

/// <reference lib="webworker" />

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { installHttpVfs, VFS_NAME, warmup, getReaderStats, unregisterFile } from './http-vfs.js';
import { getCached, putCached } from './blob-cache.js';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

/**
 * `range`    consulta solo las paginas necesarias, sin descargar nada.
 * `download` baja el archivo entero una vez. Despues funciona SIN CONEXION,
 *            que es lo que hace util esta app en un supermercado con mala
 *            cobertura.
 */
export type OpenStrategy = 'range' | 'download';

export type WorkerRequest =
  | {
      id: number;
      type: 'open';
      /** Nombre logico de la fuente, normalmente el pais. Identifica la conexion. */
      source: string;
      url: string;
      strategy?: OpenStrategy;
      /** Fecha del indice: si cambia, la copia guardada se descarta */
      generatedAt?: string;
      blockSize?: number;
      maxBlocks?: number;
    }
  | { id: number; type: 'query'; source: string; sql: string; params?: unknown[] }
  /**
   * Busqueda por texto. El SQL lo arma el Worker y no el cliente, porque solo
   * aqui se sabe que columnas tiene realmente el archivo abierto.
   */
  | { id: number; type: 'search'; source: string; term: string; limit: number }
  | { id: number; type: 'get'; source: string; sql: string; params?: unknown[] }
  | { id: number; type: 'stats'; source?: string }
  | { id: number; type: 'close'; source: string }
  | { id: number; type: 'list' };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  /** Progreso de descarga, para poder mostrar una barra en vez de un spinner mudo */
  | { id: number; progress: { loaded: number; total: number } };

interface Connection {
  db: { exec: (opts: unknown) => unknown; close: () => void };
  strategy: OpenStrategy;
  /** Nombre del archivo tal como lo conoce el VFS */
  file: string;
  /** Columnas presentes en `products`, para tolerar esquemas antiguos */
  columns: Set<string>;
}

/**
 * Lee las columnas reales de la tabla.
 *
 * Hace falta porque cliente y datos se despliegan por separado: la aplicacion
 * se publica al instante y los catalogos se reconstruyen de noche, asi que
 * durante horas el cliente nuevo consulta datos con el esquema viejo. Sin esta
 * comprobacion, anadir una columna rompe la busqueda en produccion hasta la
 * siguiente reconstruccion. Ocurrio con `popularity`.
 */
function readColumns(db: Connection['db']): Set<string> {
  const cols = new Set<string>();
  try {
    db.exec({
      sql: 'PRAGMA table_info(products)',
      rowMode: 'object',
      callback: (row: Record<string, unknown>) => {
        if (typeof row['name'] === 'string') cols.add(row['name']);
      },
    });
  } catch {
    /* si falla, se asume el esquema minimo */
  }
  return cols;
}

let sqlite3: Sqlite3 | undefined;

/**
 * Conexiones abiertas, indexadas por nombre logico.
 *
 * Antes era una unica variable `dbHandle`, lo que impedia tener el catalogo de
 * dos paises a la vez. Eso importa porque en Latinoamerica los importados
 * estadounidenses son frecuentes: un usuario mexicano necesita Mexico Y
 * Estados Unidos abiertos al mismo tiempo.
 */
const connections = new Map<string, Connection>();

async function ensureSqlite(): Promise<Sqlite3> {
  if (!sqlite3) {
    // El .d.mts publicado declara `init()` sin argumentos, pero en tiempo de
    // ejecucion acepta las opciones de Emscripten. Sin este cast, silenciar
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

/** Nombre de archivo que vera el VFS para una fuente dada. */
const fileNameFor = (source: string) => `${source}.sqlite3`;

function closeConnection(source: string): void {
  const conn = connections.get(source);
  if (!conn) return;
  try {
    conn.db.close();
  } catch {
    /* si ya estaba cerrada, da igual */
  }
  connections.delete(source);
  if (conn.strategy === 'range') unregisterFile(conn.file);
}

async function openWithRange(
  source: string,
  url: string,
  blockSize?: number,
  maxBlocks?: number,
) {
  const api = await ensureSqlite();
  const file = fileNameFor(source);
  installHttpVfs(api as never, { name: file, url, blockSize, maxBlocks });
  warmup(file);

  // `immutable=1` le dice a SQLite que el archivo no cambia mientras esta
  // abierto: se salta el journal, los bloqueos y las comprobaciones de cambio,
  // que es exactamente la semantica de un objeto estatico servido por CDN.
  const oo1 = (api as unknown as { oo1: { DB: new (opts: unknown) => never } }).oo1;
  const db = new (oo1.DB as never as new (o: unknown) => {
    exec: (opts: unknown) => unknown;
    close: () => void;
  })({
    filename: `file:${file}?vfs=${VFS_NAME}&immutable=1&mode=ro`,
    flags: 'r',
  });

  const columns = readColumns(db);
  connections.set(source, { db, strategy: 'range', file, columns });
  return { ok: true as const, strategy: 'range' as const, source, columns: [...columns] };
}

/**
 * Descarga el archivo entero y lo abre.
 *
 * Merece la pena cuando la base es pequena: un SQLite comprime ~65% por la red,
 * asi que la de Venezuela son ~0,1 MB, menos que una consulta por rangos. Y a
 * diferencia de los rangos, una vez guardada funciona sin conexion.
 */
async function openWithDownload(source: string, url: string, id: number, generatedAt?: string) {
  const api = await ensureSqlite();
  const file = fileNameFor(source);

  let bytes: Uint8Array | undefined;
  const cached = await getCached(source);
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
      key: source,
      bytes: bytes.buffer.slice(0) as ArrayBuffer,
      generatedAt: generatedAt ?? '',
      storedAt: Date.now(),
    });
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

  const columns = readColumns(db);
  connections.set(source, { db, strategy: 'download', file, columns });
  return {
    ok: true as const, strategy: 'download' as const, source,
    bytes: bytes.length, columns: [...columns],
  };
}

function query(source: string, sql: string, params?: unknown[]): Record<string, unknown>[] {
  const conn = connections.get(source);
  if (!conn) throw new Error(`La fuente "${source}" no esta abierta`);
  const rows: Record<string, unknown>[] = [];
  conn.db.exec({
    sql,
    bind: params,
    rowMode: 'object',
    callback: (row: Record<string, unknown>) => {
      rows.push(row);
    },
  });
  return rows;
}

/**
 * Busqueda por texto sobre el indice FTS.
 *
 * Se ordena por relevancia textual Y POPULARIDAD cuando el archivo tiene esa
 * columna. Solo con `rank`, buscar "harina" devolvia antes coincidencias
 * exactas de productos que nadie escanea que "Harina P.A.N.", que es la que la
 * gente busca de verdad.
 */
function search(source: string, term: string, limit: number): Record<string, unknown>[] {
  const conn = connections.get(source);
  if (!conn) throw new Error(`La fuente "${source}" no esta abierta`);
  const cleaned = term.trim().replace(/["']/g, '');
  if (!cleaned) return [];

  const orden = conn.columns.has('popularity')
    ? 'ORDER BY rank, COALESCE(p.popularity, 0) DESC'
    : 'ORDER BY rank';

  // Se une por `barcode`, no por rowid: la tabla `products` es WITHOUT ROWID y
  // por tanto no tiene columna rowid que usar.
  return query(
    source,
    `SELECT p.* FROM products_fts f
     JOIN products p ON p.barcode = f.barcode
     WHERE products_fts MATCH ?
     ${orden}
     LIMIT ?`,
    [`${cleaned}*`, limit],
  );
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  const reply = (res: WorkerResponse) => self.postMessage(res);

  try {
    switch (msg.type) {
      case 'open': {
        // Reabrir una fuente ya abierta cierra la anterior primero: de lo
        // contrario quedaria una conexion huerfana consumiendo memoria.
        closeConnection(msg.source);
        const result =
          msg.strategy === 'download'
            ? await openWithDownload(msg.source, msg.url, msg.id, msg.generatedAt)
            : await openWithRange(msg.source, msg.url, msg.blockSize, msg.maxBlocks);
        reply({ id: msg.id, ok: true, result });
        break;
      }
      case 'query':
        reply({ id: msg.id, ok: true, result: query(msg.source, msg.sql, msg.params) });
        break;
      case 'search':
        reply({ id: msg.id, ok: true, result: search(msg.source, msg.term, msg.limit) });
        break;
      case 'get': {
        const rows = query(msg.source, msg.sql, msg.params);
        reply({ id: msg.id, ok: true, result: rows[0] ?? null });
        break;
      }
      case 'stats':
        reply({
          id: msg.id,
          ok: true,
          result: getReaderStats(msg.source ? fileNameFor(msg.source) : undefined) ?? null,
        });
        break;
      case 'close':
        closeConnection(msg.source);
        reply({ id: msg.id, ok: true, result: null });
        break;
      case 'list':
        reply({ id: msg.id, ok: true, result: [...connections.keys()] });
        break;
    }
  } catch (err) {
    reply({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
