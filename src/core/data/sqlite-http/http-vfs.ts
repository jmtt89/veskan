/**
 * VFS de SQLite de solo lectura sobre HTTP Range.
 *
 * Se implementa sobre `@sqlite.org/sqlite-wasm`, el paquete OFICIAL del
 * proyecto SQLite (actualizado en 2026), en vez de usar `sql.js-httpvfs`, que
 * es la referencia historica del metodo pero lleva sin publicar desde
 * 2022-09-23 y arrastra una version antigua de SQLite.
 *
 * Al ser de solo lectura, casi todos los metodos de escritura y bloqueo se
 * reducen a devolver SQLITE_READONLY o cero, lo que recorta mucho la
 * superficie frente a un VFS completo.
 *
 * REQUISITO: ejecutar dentro de un Web Worker. `RangeReader` usa XHR sincrono,
 * prohibido en el hilo principal.
 */

import { RangeReader } from './range-reader.js';

export const VFS_NAME = 'http-range';

/** Tipos minimos de la superficie de sqlite-wasm que usamos. */
interface WasmUtil {
  heap8u(): Uint8Array;
  poke(ptr: number, value: unknown, type: string): void;
  poke32(ptr: number, value: number): void;
  cstrToJs(ptr: number): string;
  allocCString(s: string): number;
  peek(ptr: number, type?: string): number;
}

interface Sqlite3Api {
  capi: Record<string, unknown> & {
    sqlite3_vfs: new () => VfsStruct;
    sqlite3_file: new (ptr: number) => FileStruct;
    sqlite3_io_methods: new () => IoStruct;
    sqlite3_vfs_find(name: string | number): number;
  };
  wasm: WasmUtil;
  vfs: { installVfs(opt: unknown): unknown };
}

interface VfsStruct {
  $iVersion: number;
  $szOsFile: number;
  $mxPathname: number;
  $zName: number;
  pointer: number;
  addOnDispose(ptr: number): void;
  installMethods(methods: unknown, argcCheck: boolean): void;
  registerVfs(asDefault: boolean): void;
}

interface FileStruct {
  $pMethods: number;
  dispose(): void;
}

interface IoStruct {
  $iVersion: number;
  pointer: number;
  installMethods(methods: unknown, argcCheck: boolean): void;
}

/** Codigos de resultado usados. */
const SQLITE_OK = 0;
const SQLITE_IOERR = 10;
const SQLITE_IOERR_SHORT_READ = 522;
const SQLITE_READONLY = 8;
const SQLITE_NOTFOUND = 12;
const SQLITE_CANTOPEN = 14;
const SQLITE_IOCAP_IMMUTABLE = 0x2000;

/**
 * Archivos abiertos, indexados por el puntero de `sqlite3_file`.
 * El VFS solo sirve UN archivo remoto, registrado antes de abrir la base.
 */
const openFiles = new Map<number, RangeReader>();

let registeredUrl: string | undefined;
let sharedReader: RangeReader | undefined;
let installed = false;

export interface InstallOptions {
  /** URL del archivo SQLite remoto */
  url: string;
  /** Debe coincidir con el `page_size` de la base */
  blockSize?: number;
  maxBlocks?: number;
}

/** Estadisticas de red, para poder mostrar cuanto se transfirio de verdad. */
export function getReaderStats() {
  return sharedReader?.stats;
}

/**
 * Registra el VFS en la instancia de sqlite3. Es idempotente: llamarlo dos
 * veces solo cambia la URL apuntada.
 */
export function installHttpVfs(sqlite3: Sqlite3Api, opts: InstallOptions): void {
  const { capi, wasm } = sqlite3;

  registeredUrl = opts.url;
  sharedReader = new RangeReader({
    url: opts.url,
    blockSize: opts.blockSize ?? 4096,
    maxBlocks: opts.maxBlocks ?? 4096,
  });

  if (installed) return;

  const ioMethods = {
    xClose(pFile: number): number {
      openFiles.delete(pFile);
      try {
        new capi.sqlite3_file(pFile).dispose();
      } catch {
        /* el puntero lo gestiona SQLite; ignorar */
      }
      return SQLITE_OK;
    },

    xRead(pFile: number, pDest: number, n: number, offset64: bigint | number): number {
      const reader = openFiles.get(pFile);
      if (!reader) return SQLITE_IOERR;
      const offset = Number(offset64);
      try {
        const bytes = reader.read(offset, n);
        const heap = wasm.heap8u();
        heap.set(bytes, pDest);
        if (bytes.length < n) {
          // SQLite exige que el resto quede a cero y que se avise con
          // SHORT_READ; si no, lee basura del heap.
          heap.fill(0, pDest + bytes.length, pDest + n);
          return SQLITE_IOERR_SHORT_READ;
        }
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR;
      }
    },

    xWrite(): number {
      return SQLITE_READONLY;
    },

    xTruncate(): number {
      return SQLITE_READONLY;
    },

    xSync(): number {
      return SQLITE_OK;
    },

    xFileSize(pFile: number, pSize64: number): number {
      const reader = openFiles.get(pFile);
      if (!reader) return SQLITE_IOERR;
      try {
        wasm.poke(pSize64, BigInt(reader.fileSize()), 'i64');
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR;
      }
    },

    // Sin escritura no hay contencion: los bloqueos son no-ops.
    xLock(): number {
      return SQLITE_OK;
    },
    xUnlock(): number {
      return SQLITE_OK;
    },
    xCheckReservedLock(_pFile: number, pOut: number): number {
      wasm.poke32(pOut, 0);
      return SQLITE_OK;
    },
    xFileControl(): number {
      return SQLITE_NOTFOUND;
    },
    xSectorSize(): number {
      return sharedReader?.blockSize ?? 4096;
    },
    xDeviceCharacteristics(): number {
      // Declarar el archivo inmutable permite a SQLite saltarse comprobaciones
      // de coherencia que no tienen sentido contra un objeto estatico de CDN.
      return SQLITE_IOCAP_IMMUTABLE;
    },
  };

  const ioStruct = new capi.sqlite3_io_methods();
  ioStruct.$iVersion = 1;

  const vfsMethods = {
    xOpen(_pVfs: number, _zName: number, pFile: number, _flags: number, pOutFlags: number): number {
      if (!sharedReader) return SQLITE_CANTOPEN;
      try {
        const file = new capi.sqlite3_file(pFile);
        file.$pMethods = ioStruct.pointer;
        openFiles.set(pFile, sharedReader);
        // Se fuerza solo-lectura sea cual sea el flag pedido.
        wasm.poke32(pOutFlags, 1 /* SQLITE_OPEN_READONLY */);
        return SQLITE_OK;
      } catch {
        return SQLITE_CANTOPEN;
      }
    },

    xDelete(): number {
      return SQLITE_READONLY;
    },

    xAccess(_pVfs: number, _zName: number, _flags: number, pOut: number): number {
      // El unico archivo que existe es el remoto, y siempre "existe".
      wasm.poke32(pOut, sharedReader ? 1 : 0);
      return SQLITE_OK;
    },

    xFullPathname(_pVfs: number, zName: number, nOut: number, pOut: number): number {
      const name = wasm.cstrToJs(zName);
      const bytes = new TextEncoder().encode(name);
      if (bytes.length + 1 > nOut) return SQLITE_IOERR;
      const heap = wasm.heap8u();
      heap.set(bytes, pOut);
      heap[pOut + bytes.length] = 0;
      return SQLITE_OK;
    },

    xCurrentTime(_pVfs: number, pOut: number): number {
      wasm.poke(pOut, 2440587.5 + Date.now() / 86400000, 'double');
      return SQLITE_OK;
    },

    xCurrentTimeInt64(_pVfs: number, pOut: number): number {
      wasm.poke(pOut, BigInt(210866760000000 + Date.now()), 'i64');
      return SQLITE_OK;
    },

    xRandomness(_pVfs: number, nByte: number, pOut: number): number {
      const heap = wasm.heap8u();
      for (let i = 0; i < nByte; i++) {
        heap[pOut + i] = (Math.random() * 255) | 0;
      }
      return nByte;
    },

    xSleep(): number {
      return SQLITE_OK;
    },

    xGetLastError(): number {
      return SQLITE_OK;
    },
  };

  const vfsStruct = new capi.sqlite3_vfs();
  vfsStruct.$iVersion = 2;
  vfsStruct.$szOsFile = 4 + 4; // sqlite3_file: solo el puntero a pMethods
  vfsStruct.$mxPathname = 1024;

  sqlite3.vfs.installVfs({
    io: { struct: ioStruct, methods: ioMethods },
    vfs: { struct: vfsStruct, methods: vfsMethods, name: VFS_NAME, asDefault: false },
  });

  installed = true;
}

export function getRegisteredUrl(): string | undefined {
  return registeredUrl;
}

/** Precarga la cabecera y las primeras paginas, donde vive el esquema. */
export function warmup(bytes = 64 * 1024): void {
  sharedReader?.prefetch(0, bytes);
}
