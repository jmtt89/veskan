/**
 * Capa L0: almacenamiento local en IndexedDB.
 *
 * Tres responsabilidades:
 *  - cache de productos ya vistos (evita agotar el limite de 15 req/min de OFF)
 *  - historial del usuario
 *  - cola de contribuciones de productos que no existen en ninguna fuente
 */

import Dexie, { type EntityTable } from 'dexie';
import type { Product } from '../types.js';

/** Un producto cacheado caduca a los 30 dias. */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CachedProduct extends Product {
  /** Clave primaria */
  barcode: string;
  cachedAt: number;
}

export interface HistoryEntry {
  id?: number;
  barcode: string;
  scannedAt: number;
  name?: string;
  brand?: string;
  imageThumbUrl?: string;
  score?: number;
  band?: string;
  /** El usuario lo marco como favorito */
  starred?: boolean;
}

export type ContributionStatus = 'pending' | 'submitted' | 'failed';

export interface Contribution {
  id?: number;
  barcode: string;
  createdAt: number;
  status: ContributionStatus;
  payload: {
    name?: string;
    brands?: string;
    quantity?: string;
    categories?: string;
    ingredientsText?: string;
    nutrimentsPer100g?: Record<string, number | undefined>;
    /** Fotos como data URL; se suben al enviar */
    photos?: { front?: string; ingredients?: string; nutrition?: string };
    countryTag?: string;
  };
  error?: string;
  attempts: number;
}

export class VeskanDb extends Dexie {
  products!: EntityTable<CachedProduct, 'barcode'>;
  history!: EntityTable<HistoryEntry, 'id'>;
  contributions!: EntityTable<Contribution, 'id'>;

  constructor(name = 'veskan') {
    super(name);
    this.version(1).stores({
      products: 'barcode, cachedAt, source',
      history: '++id, barcode, scannedAt, starred',
      contributions: '++id, barcode, status, createdAt',
    });
  }
}

export const db = new VeskanDb();

export async function getCachedProduct(barcode: string): Promise<Product | undefined> {
  const row = await db.products.get(barcode);
  if (!row) return undefined;
  if (Date.now() - row.cachedAt > CACHE_TTL_MS) {
    await db.products.delete(barcode);
    return undefined;
  }
  return { ...row, source: 'cache' };
}

export async function putCachedProduct(product: Product): Promise<void> {
  await db.products.put({ ...product, cachedAt: Date.now() });
}

/**
 * Invalida del cache los productos que acaba de cambiar un delta.
 *
 * Sin esto, actualizar el catalogo no se nota: el cache de productos ya vistos
 * es la primera capa que consulta `lookup()`, asi que seguiria devolviendo la
 * version anterior hasta que caducara, 30 dias despues. Se borran solo los
 * codigos que el delta toco, que vienen en el propio archivo.
 */
export async function invalidateCached(barcodes: string[]): Promise<void> {
  if (barcodes.length === 0) return;
  await db.products.bulkDelete(barcodes);
}

export async function addHistory(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
  // Un reescaneo del mismo producto actualiza la entrada en vez de duplicarla.
  const existing = await db.history.where('barcode').equals(entry.barcode).first();
  if (existing?.id !== undefined) {
    await db.history.update(existing.id, { ...entry, starred: existing.starred });
    return;
  }
  await db.history.add(entry);
}

export async function listHistory(limit = 100): Promise<HistoryEntry[]> {
  return db.history.orderBy('scannedAt').reverse().limit(limit).toArray();
}

export async function toggleStar(id: number): Promise<void> {
  const entry = await db.history.get(id);
  if (entry) await db.history.update(id, { starred: !entry.starred });
}

export async function clearHistory(): Promise<void> {
  await db.history.clear();
}

/**
 * Vacia los recientes CONSERVANDO los favoritos, y devuelve lo borrado.
 *
 * Devolverlo es lo que hace posible el «Deshacer»: borrar el historial es
 * irreversible y sin una salida a mano el usuario tiene que acertar a la
 * primera. Con esto, la confirmacion puede ser ligera en vez de una advertencia
 * que nadie lee.
 */
export async function clearRecent(): Promise<HistoryEntry[]> {
  const borrados = await db.history.filter((h) => !h.starred).toArray();
  await db.history.bulkDelete(borrados.map((h) => h.id!).filter((id) => id !== undefined));
  return borrados;
}

/** Devuelve al historial lo que se acaba de borrar. */
export async function restoreHistory(entries: HistoryEntry[]): Promise<void> {
  if (entries.length) await db.history.bulkPut(entries);
}

export async function queueContribution(
  barcode: string,
  payload: Contribution['payload'],
): Promise<number> {
  return db.contributions.add({
    barcode,
    createdAt: Date.now(),
    status: 'pending',
    payload,
    attempts: 0,
  }) as Promise<number>;
}

export async function listPendingContributions(): Promise<Contribution[]> {
  return db.contributions.where('status').equals('pending').toArray();
}

/** Exporta la cola en JSON, para enviarla como PR al repo de datos. */
export async function exportContributions(): Promise<string> {
  const all = await db.contributions.toArray();
  return JSON.stringify(
    all.map((c) => ({ barcode: c.barcode, createdAt: c.createdAt, ...c.payload })),
    null,
    2,
  );
}
