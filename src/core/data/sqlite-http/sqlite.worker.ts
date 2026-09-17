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
import {
  ensurePool,
  importCatalog,
  listCatalogs,
  openCatalog,
  opfsLooksAvailable,
  OpfsUnavailableError,
  pausePool,
  removeCatalog,
} from './opfs-store.js';

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
  | { id: number; type: 'list' }
  /** Que puede hacer este navegador: OPFS disponible, catalogos ya en disco */
  | { id: number; type: 'capabilities' }
  /** Borra un catalogo del disco */
  | { id: number; type: 'remove'; source: string }
  /** Libera los manejadores de OPFS antes de que la pagina desaparezca */
  | { id: number; type: 'pause' };

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
 * Descarga el catalogo y lo guarda en OPFS.
 *
 * A diferencia de la version anterior, que lo metia en IndexedDB como un blob y
 * lo cargaba entero a memoria con `deserialize`, aqui queda como un **archivo
 * SQLite real en disco**: SQLite lo lee y escribe por paginas de 4 kB, sin que
 * la memoria dependa del tamano del catalogo. Es lo que permite despues
 * mantenerlo al dia con deltas diminutos en vez de volver a bajarlo entero.
 */
async function openWithDownload(source: string, url: string, id: number) {
  const api = await ensureSqlite();
  const pool = await ensurePool(api, 4);

  // Si ya esta en disco, no se vuelve a bajar. Quien decide si hay que
  // actualizarlo es el cliente, comparando versiones.
  if (!listCatalogs(pool).includes(source)) {
    const res = await fetch(url);
    await importCatalog(pool, source, res, (loaded, total) => {
      self.postMessage({ id, progress: { loaded, total } } satisfies WorkerResponse);
    });
  }

  const db = openCatalog(pool, source);
  const columns = readColumns(db);
  connections.set(source, { db, strategy: 'download', file: catalogFileName(source), columns });
  return { ok: true as const, strategy: 'download' as const, source, columns: [...columns] };
}

/** Nombre con el que el catalogo vive dentro del pool de OPFS. */
const catalogFileName = (source: string) => `${source}.sqlite3`;

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
            ? await openWithDownload(msg.source, msg.url, msg.id)
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
      case 'capabilities': {
        // Se consulta ANTES de ofrecer la descarga, para poder explicar por que
        // no se puede en lugar de fallar a mitad.
        if (!opfsLooksAvailable()) {
          reply({
            id: msg.id, ok: true,
            result: { opfs: false, reason: 'no-api', catalogs: [] },
          });
          break;
        }
        try {
          const api = await ensureSqlite();
          const pool = await ensurePool(api, 4);
          reply({
            id: msg.id, ok: true,
            result: { opfs: true, catalogs: listCatalogs(pool) },
          });
        } catch (err) {
          const reason = err instanceof OpfsUnavailableError ? err.reason : 'unknown';
          reply({
            id: msg.id, ok: true,
            result: { opfs: false, reason, detail: (err as Error).message, catalogs: [] },
          });
        }
        break;
      }
      case 'pause':
        await pausePool();
        reply({ id: msg.id, ok: true, result: null });
        break;
      case 'remove': {
        closeConnection(msg.source);
        const api = await ensureSqlite();
        const pool = await ensurePool(api, 4);
        reply({ id: msg.id, ok: true, result: { removed: removeCatalog(pool, msg.source) } });
        break;
      }
    }
  } catch (err) {
    reply({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
