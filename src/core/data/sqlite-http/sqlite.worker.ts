/**
 * Worker que hospeda SQLite-WASM con el VFS de HTTP Range.
 *
 * Vive en un Worker por obligacion tecnica, no por gusto: `RangeReader` usa
 * XMLHttpRequest sincrono, que el navegador prohibe en el hilo principal.
 */

/// <reference lib="webworker" />

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { installHttpVfs, VFS_NAME, warmup, getReaderStats } from './http-vfs.js';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

export type WorkerRequest =
  | { id: number; type: 'open'; url: string; blockSize?: number; maxBlocks?: number }
  | { id: number; type: 'query'; sql: string; params?: unknown[] }
  | { id: number; type: 'get'; sql: string; params?: unknown[] }
  | { id: number; type: 'stats' }
  | { id: number; type: 'close' };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

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

async function open(url: string, blockSize?: number, maxBlocks?: number): Promise<{ ok: true }> {
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
  return { ok: true };
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
      case 'open':
        reply({ id: msg.id, ok: true, result: await open(msg.url, msg.blockSize, msg.maxBlocks) });
        break;
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
