/**
 * Almacen de snapshots descargados, en IndexedDB.
 *
 * Es lo que convierte la descarga completa en funcionamiento SIN CONEXION: una
 * vez guardada la base del pais, las consultas no tocan la red. Se usa
 * IndexedDB en crudo y no Dexie porque esto corre dentro del Worker de SQLite y
 * no merece la pena cargar una dependencia mas ahi.
 */

const DB_NAME = 'veskan-snapshots';
const STORE = 'files';
const VERSION = 1;

export interface CachedSnapshot {
  key: string;
  bytes: ArrayBuffer;
  /** Fecha de generacion declarada por el indice, para saber si caduco */
  generatedAt: string;
  storedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('No se pudo abrir IndexedDB'));
  });
}

export async function getCached(key: string): Promise<CachedSnapshot | undefined> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as CachedSnapshot | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // En navegacion privada o con el almacenamiento bloqueado, IndexedDB puede
    // fallar. No es motivo para romper la app: se descarga cada vez.
    return undefined;
  }
}

export async function putCached(entry: CachedSnapshot): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* sin cache la app sigue funcionando, solo descarga cada vez */
  }
}

/** Borra snapshots de otros paises para no acumular megas inutiles. */
export async function pruneExcept(keepKey: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result) if (k !== keepKey) store.delete(k);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignorar */
  }
}
