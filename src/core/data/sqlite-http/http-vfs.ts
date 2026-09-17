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
 * Lectores registrados, indexados por el NOMBRE LOGICO del archivo.
 *
 * Antes habia un unico `sharedReader` de modulo, lo que limitaba el VFS a
 * servir un solo archivo remoto: abrir el catalogo de otro pais reemplazaba al
 * anterior. Ahora cada archivo tiene su lector, con su propia cache LRU y sus
 * propias estadisticas, y SQLite elige cual usar por el nombre que pasa a
 * `xOpen`.
 */
const readers = new Map<string, RangeReader>();

/** Archivos abiertos, indexados por el puntero de `sqlite3_file`. */
const openFiles = new Map<number, RangeReader>();

let installed = false;

export interface InstallOptions {
  /**
   * Nombre logico con el que se abrira la base, p.ej. `venezuela.sqlite3`.
   * Es el que SQLite pasa a `xOpen`, y por tanto la clave de busqueda.
   */
  name: string;
  /** URL del archivo SQLite remoto */
  url: string;
  /** Debe coincidir con el `page_size` de la base */
  blockSize?: number;
  maxBlocks?: number;
}

/**
 * Estadisticas de red de un archivo, para poder mostrar cuanto se transfirio
 * de verdad. Sin nombre, agrega las de todos.
 */
export function getReaderStats(name?: string) {
  if (name) return readers.get(name)?.stats;
  const total = {
    requests: 0, bytesTransferred: 0, cacheHits: 0, cacheMisses: 0, evictions: 0,
  };
  for (const r of readers.values()) {
    total.requests += r.stats.requests;
    total.bytesTransferred += r.stats.bytesTransferred;
    total.cacheHits += r.stats.cacheHits;
    total.cacheMisses += r.stats.cacheMisses;
    total.evictions += r.stats.evictions;
  }
  return total;
}

/** Olvida un archivo registrado y libera su cache. */
export function unregisterFile(name: string): void {
  readers.get(name)?.clearCache();
  readers.delete(name);
}

export function registeredFiles(): string[] {
  return [...readers.keys()];
}

/**
 * Registra un archivo remoto e instala el VFS si aun no lo estaba.
 *
 * Llamarlo varias veces con nombres distintos acumula archivos; con el mismo
 * nombre, reemplaza su lector (util cuando el snapshot se republica).
 */
export function installHttpVfs(sqlite3: Sqlite3Api, opts: InstallOptions): void {
  const { capi, wasm } = sqlite3;

  readers.set(
    opts.name,
    new RangeReader({
      url: opts.url,
      blockSize: opts.blockSize ?? 4096,
      maxBlocks: opts.maxBlocks ?? 4096,
    }),
  );

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
    xSectorSize(pFile: number): number {
      return openFiles.get(pFile)?.blockSize ?? 4096;
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
    xOpen(_pVfs: number, zName: number, pFile: number, _flags: number, pOutFlags: number): number {
      // El nombre es lo que decide QUE archivo remoto se abre. Antes se
      // ignoraba y siempre se usaba el mismo lector.
      const reader = zName ? readers.get(baseName(wasm.cstrToJs(zName))) : undefined;
      // Un nombre no registrado suele ser un journal o un temporal. Al abrirse
      // la base con `immutable=1` no deberian aparecer, y si aparecen es mejor
      // negarlos que servir bytes de otro archivo.
      if (!reader) return SQLITE_CANTOPEN;
      try {
        const file = new capi.sqlite3_file(pFile);
        file.$pMethods = ioStruct.pointer;
        openFiles.set(pFile, reader);
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

    xAccess(_pVfs: number, zName: number, _flags: number, pOut: number): number {
      // Solo "existen" los archivos registrados. Responder que si a cualquier
      // nombre haria que SQLite buscase journals que no existen.
      const exists = zName ? readers.has(baseName(wasm.cstrToJs(zName))) : false;
      wasm.poke32(pOut, exists ? 1 : 0);
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

export function getRegisteredUrl(name: string): string | undefined {
  return readers.get(name)?.url;
}

/** Precarga la cabecera y las primeras paginas, donde vive el esquema. */
export function warmup(name: string, bytes = 64 * 1024): void {
  readers.get(name)?.prefetch(0, bytes);
}

/**
 * Normaliza el nombre que pasa SQLite a la clave del registro.
 *
 * SQLite puede entregar una ruta completa (`/venezuela.sqlite3`) porque
 * `xFullPathname` la devuelve tal cual, asi que se compara solo el nombre.
 */
function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
