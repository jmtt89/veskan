/**
 * Almacen de catalogos en OPFS (Origin Private File System).
 *
 * Aqui el catalogo descargado NO es un blob opaco que haya que cargar entero a
 * memoria: es un **archivo SQLite real sobre el disco del usuario**, que SQLite
 * lee y escribe por paginas de 4 kB. Eso es lo que hace posible mantenerlo al
 * dia con deltas diminutos en vez de volver a bajar el archivo completo.
 *
 * Se usa el VFS `opfs-sahpool` y no el `opfs` clasico por una razon concreta:
 * el clasico necesita `SharedArrayBuffer`, y por tanto cabeceras COOP/COEP que
 * GitHub Pages no permite configurar. Verificado que el SAH Pool funciona en
 * `jmtt89.github.io` con `crossOriginIsolated === false`.
 */

/// <reference lib="webworker" />

/** Nombre del VFS registrado en SQLite. */
export const POOL_VFS_NAME = 'veskan-pool';
/** Directorio propio dentro de OPFS. */
export const POOL_DIR = '.veskan/catalogs';
/** Nombre del candado que evita dos inicializaciones simultaneas. */
const POOL_LOCK = 'veskan-opfs-pool';

export type OpfsFailureReason =
  /** El navegador no expone las APIs necesarias */
  | 'no-api'
  /** Las expone pero en una version demasiado antigua */
  | 'too-old'
  /** Otra pestana tiene tomado el almacenamiento */
  | 'locked-by-other-tab'
  | 'unknown';

export class OpfsUnavailableError extends Error {
  constructor(
    public readonly reason: OpfsFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'OpfsUnavailableError';
  }
}

/** La descarga se corto a medias. */
export class TruncatedDownloadError extends Error {
  constructor(
    public readonly received: number,
    public readonly expected: number,
  ) {
    super(
      `La descarga se interrumpio: se recibieron ${received} bytes de ${expected}. ` +
        'Vuelve a intentarlo con una conexion estable.',
    );
    this.name = 'TruncatedDownloadError';
  }
}

/** Superficie del objeto que devuelve `installOpfsSAHPoolVfs`. */
interface SAHPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => {
    exec: (opts: unknown) => unknown;
    close: () => void;
  };
  importDb: (
    name: string,
    data: Uint8Array | ArrayBuffer | (() => Promise<Uint8Array | undefined>),
  ) => Promise<number>;
  getCapacity: () => number;
  getFileCount: () => number;
  getFileNames: () => string[];
  addCapacity: (n: number) => Promise<number>;
  reserveMinimumCapacity: (n: number) => Promise<number>;
  unlink: (name: string) => boolean;
  wipeFiles: () => Promise<void>;
  removeVfs: () => Promise<boolean>;
}

interface Sqlite3WithOpfs {
  installOpfsSAHPoolVfs?: (opts: {
    name?: string;
    directory?: string;
    initialCapacity?: number;
    clearOnInit?: boolean;
  }) => Promise<SAHPoolUtil>;
}

/**
 * Comprobacion rapida, sin efectos secundarios.
 *
 * Refleja exactamente lo que valida la libreria antes de rechazar, para poder
 * decidir si ofrecer la descarga sin arriesgarse a inicializar.
 */
export function opfsLooksAvailable(): boolean {
  return Boolean(
    globalThis.FileSystemFileHandle?.prototype &&
      'createSyncAccessHandle' in globalThis.FileSystemFileHandle.prototype &&
      navigator?.storage?.getDirectory,
  );
}

/** Ranuras necesarias: cada base puede necesitar su journal, mas margen. */
export function slotsFor(databases: number): number {
  return databases * 2 + 4;
}

let pool: SAHPoolUtil | undefined;
let poolPromise: Promise<SAHPoolUtil> | undefined;

/**
 * Inicializa el pool. Idempotente.
 *
 * El candado NO es decorativo. La libreria, ante CUALQUIER fallo de
 * inicializacion, ejecuta:
 *
 *     }).catch(async (e) => { await thePool.removeVfs().catch(() => {}); throw e; });
 *
 * y `removeVfs()` hace `removeEntry(OPAQUE_DIR_NAME, { recursive: true })`.
 * Es decir: un fallo transitorio **borra recursivamente todo el directorio**, y
 * con el los catalogos que el usuario haya descargado. Dos inicializaciones
 * concurrentes (dos pestanas, o dos llamadas a la vez) son justo la forma mas
 * facil de provocar ese fallo, asi que se serializan con `navigator.locks` y,
 * si otra pestana ya lo tiene, se rechaza SIN llegar a inicializar.
 */
export async function ensurePool(sqlite3: unknown, databases = 4): Promise<SAHPoolUtil> {
  if (pool) return pool;
  if (poolPromise) return poolPromise;

  const api = sqlite3 as Sqlite3WithOpfs;
  if (typeof api.installOpfsSAHPoolVfs !== 'function' || !opfsLooksAvailable()) {
    throw new OpfsUnavailableError(
      'no-api',
      'Este navegador no permite guardar bases de datos en disco.',
    );
  }

  poolPromise = (async () => {
    const install = api.installOpfsSAHPoolVfs!;
    const run = async () =>
      install({
        name: POOL_VFS_NAME,
        directory: POOL_DIR,
        initialCapacity: slotsFor(databases),
      });

    /**
     * Reintento acotado ante manejadores aun retenidos.
     *
     * Al recargar o navegar, el Worker de la pagina anterior puede seguir con
     * los manejadores de OPFS tomados unos instantes. El navegador los libera
     * al destruir aquel contexto, pero no de inmediato, asi que el primer
     * intento falla con "Access Handles cannot be created...". Es una carrera,
     * no un estado permanente.
     *
     * Reintentar es seguro PARA ESTE fallo concreto: la libreria, al fallar,
     * intenta `removeVfs()` (que borraria el directorio entero), pero ese
     * borrado tambien choca con los mismos manejadores retenidos y no llega a
     * ejecutarse. Comprobado: tras un fallo asi, el catalogo seguia intacto en
     * disco. Otros fallos NO se reintentan, porque ahi el borrado si podria
     * haber ocurrido y reintentar solo repetiria el dano.
     */
    const runWithRetry = async (): Promise<SAHPoolUtil> => {
      const esperas = [150, 400, 900, 1800];
      for (let intento = 0; ; intento++) {
        try {
          return await run();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const esCarrera = msg.includes('Access Handles cannot be created');
          if (!esCarrera || intento >= esperas.length) throw err;
          await new Promise((r) => setTimeout(r, esperas[intento]));
        }
      }
    };

    let result: SAHPoolUtil;
    if (navigator.locks?.request) {
      const acquired = await navigator.locks.request(
        POOL_LOCK,
        { ifAvailable: true },
        async (lock) => (lock ? runWithRetry() : undefined),
      );
      if (!acquired) {
        throw new OpfsUnavailableError(
          'locked-by-other-tab',
          'Veskan ya esta abierto en otra pestana. La copia local solo puede usarse en una a la vez.',
        );
      }
      result = acquired;
    } else {
      // Sin la Lock API no hay proteccion posible; se intenta igualmente.
      result = await runWithRetry();
    }

    pool = result;
    return result;
  })();

  try {
    return await poolPromise;
  } catch (err) {
    poolPromise = undefined;
    if (err instanceof OpfsUnavailableError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // La libreria lanza este texto exacto cuando faltan las APIs.
    if (msg.includes('Missing required OPFS APIs')) {
      throw new OpfsUnavailableError('no-api', 'Este navegador no expone las APIs de OPFS.');
    }
    throw new OpfsUnavailableError('unknown', msg);
  }
}

/**
 * Libera los manejadores de OPFS sin cerrar el pool.
 *
 * Se llama al ocultarse la pagina para que la siguiente carga no tenga que
 * esperar a que el navegador destruya este contexto. Sin esto, recargar deja el
 * catalogo inaccesible durante uno o dos segundos.
 */
export async function pausePool(): Promise<void> {
  const p = pool as (SAHPoolUtil & { pauseVfs?: () => unknown }) | undefined;
  try {
    p?.pauseVfs?.();
  } catch {
    /* si no se puede, el navegador acabara liberandolos igual */
  }
}

/** Nombre del archivo dentro del pool para un catalogo. */
export const catalogFile = (country: string) => `/${country}.sqlite3`;

/** Catalogos presentes en disco ahora mismo. */
export function listCatalogs(p: SAHPoolUtil): string[] {
  return p
    .getFileNames()
    .map((f) => f.replace(/^\//, '').replace(/\.sqlite3$/, ''))
    .filter(Boolean);
}

export interface ImportReport {
  bytes: number;
  ms: number;
}

/**
 * Vuelca una descarga a OPFS por trozos, segun llega.
 *
 * `importDb` acepta una funcion que devuelve trozos, asi que el archivo NO se
 * acumula en memoria antes de escribirse: se escribe segun se recibe. Es lo que
 * hace viable un catalogo grande en un movil.
 */
export async function importCatalog(
  p: SAHPoolUtil,
  country: string,
  res: Response,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ImportReport> {
  if (!res.ok) throw new Error(`No se pudo descargar el catalogo (HTTP ${res.status})`);
  const total = Number(res.headers.get('Content-Length') ?? 0);
  const started = Date.now();

  // Hacen falta al menos dos ranuras por base (datos y journal).
  await p.reserveMinimumCapacity(slotsFor(listCatalogs(p).length + 1));

  let loaded = 0;
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    loaded = bytes.length;
    await p.importDb(catalogFile(country), bytes);
  } else {
    const reader = res.body.getReader();
    await p.importDb(catalogFile(country), async () => {
      const { done, value } = await reader.read();
      if (done) return undefined;
      loaded += value.length;
      onProgress?.(loaded, total);
      return value;
    });
  }

  // Una descarga cortada produce un archivo valido en apariencia pero
  // incompleto. La libreria solo se queja si el tamano no es multiplo de 512,
  // y entonces lo hace con un mensaje incomprensible; asi se detecta antes y
  // se explica.
  if (total > 0 && loaded !== total) {
    p.unlink(catalogFile(country));
    throw new TruncatedDownloadError(loaded, total);
  }

  return { bytes: loaded, ms: Date.now() - started };
}

/** Borra un catalogo. Libera el espacio de verdad: la ranura queda en 4 kB. */
export function removeCatalog(p: SAHPoolUtil, country: string): boolean {
  return p.unlink(catalogFile(country));
}

export function openCatalog(p: SAHPoolUtil, country: string) {
  const db = new p.OpfsSAHPoolDb(catalogFile(country));
  // Las tablas temporales de la aplicacion de deltas irian si no a ranuras del
  // pool, consumiendo capacidad reservada para catalogos.
  db.exec({ sql: 'PRAGMA temp_store = MEMORY' });
  return db;
}
