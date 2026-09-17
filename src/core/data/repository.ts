/**
 * Orquestador de las capas de datos: L0 -> L1 -> L2 -> L3.
 *
 * Es el unico punto por el que la UI pide productos. Decide de donde sale el
 * dato, cachea, registra en el historial y reporta de que capa vino para
 * poder mostrarlo con honestidad.
 */

import type { Assessment, Product } from '../types.js';
import { scoreProduct, type ScoringContext } from '../scoring/engine.js';
import { assessCosmetic } from '../scoring/cosmetics.js';
import { OffClient, OffNotFoundError, OffRateLimitError } from './off.js';
import type { CatalogManager } from './catalog-manager.js';
import { addHistory, getCachedProduct, putCachedProduct } from './idb.js';

/**
 * Comprueba si un producto trae datos suficientes para evaluarlo.
 *
 * Open Food Facts contiene muchos registros "fantasma": el codigo existe porque
 * alguien lo escaneo alguna vez, pero nadie llego a rellenar nada. Caso real
 * comprobado: 7502219553429 devuelve `status: 1` con nombre vacio, sin
 * ingredientes y sin nutrientes. Mostrar una puntuacion con eso seria
 * inventarsela, y ademas es PEOR que un "no encontrado", porque la app afirma
 * saber algo que no sabe.
 */
export function hasUsableData(product: Product): boolean {
  const n = product.nutriments;
  const hasNutrition =
    n.energyKj !== undefined ||
    n.energyKcal !== undefined ||
    n.sugars !== undefined ||
    n.fat !== undefined ||
    n.proteins !== undefined;
  const hasIdentity = Boolean(product.name?.trim());
  // Hace falta al menos saber que es Y algo que medir.
  return hasIdentity && (hasNutrition || Boolean(product.ingredientsText?.trim()));
}

export class ProductNotFoundError extends Error {
  constructor(public readonly barcode: string) {
    super(`No se ha encontrado el producto ${barcode} en ninguna fuente`);
    this.name = 'ProductNotFoundError';
  }
}

export interface RepositoryOptions {
  off: OffClient;
  /**
   * Gestor de catalogos. Sin el, la app funciona solo con cache y API en vivo.
   * Mutable: se asigna cuando se ha leido el indice publicado.
   */
  catalogs?: CatalogManager;
  scoringContext: () => Promise<ScoringContext>;
}

export interface LookupOptions {
  /** Ignora el cache local y va a la fuente */
  forceRefresh?: boolean;
  /** Busca en Open Beauty Facts en lugar de Open Food Facts */
  cosmetic?: boolean;
  /** Notifica el progreso para poder mostrarlo en la UI */
  onProgress?: (stage: 'cache' | 'snapshot' | 'network') => void;
}

export class ProductRepository {
  constructor(private readonly opts: RepositoryOptions) {}

  /**
   * Fija el gestor de catalogos ya en marcha.
   *
   * Hace falta porque el indice publicado se lee despues de arrancar: la
   * aplicacion ya es usable contra la API mientras tanto.
   */
  setCatalogs(manager: CatalogManager | undefined): void {
    this.opts.catalogs = manager;
  }

  get catalogs(): CatalogManager | undefined {
    return this.opts.catalogs;
  }

  /**
   * Busca un producto recorriendo las capas en orden.
   *
   * Si la red falla pero el snapshot tenia el producto, se devuelve el del
   * snapshot: un dato algo viejo es mucho mejor que un error.
   */
  async lookup(barcode: string, options: LookupOptions = {}): Promise<Product> {
    const { forceRefresh = false, cosmetic = false, onProgress } = options;

    if (!forceRefresh) {
      onProgress?.('cache');
      const cached = await getCachedProduct(barcode);
      if (cached) return cached;
    }

    let snapshotHit: Product | undefined;
    if (this.opts.catalogs && !cosmetic) {
      onProgress?.('snapshot');
      try {
        // El gestor recorre los catalogos por orden de probabilidad: primero
        // los descargados (sin red), despues el que sugiere el prefijo GS1 por
        // rangos, para no gastar cupo de la API si el producto ya lo tenemos.
        snapshotHit = (await this.opts.catalogs.getProduct(barcode))?.product;
      } catch (err) {
        // Los catalogos son un acelerador, no una dependencia: si fallan, se sigue.
        console.warn('[repositorio] catalogos no disponibles:', err);
      }
      if (snapshotHit && !forceRefresh) {
        await putCachedProduct(snapshotHit);
        return snapshotHit;
      }
    }

    onProgress?.('network');
    try {
      const product = await this.opts.off.getProduct(barcode, cosmetic ? 'cosmetic' : 'food');
      await putCachedProduct(product);
      return product;
    } catch (err) {
      if (snapshotHit) return snapshotHit;
      if (err instanceof OffNotFoundError) throw new ProductNotFoundError(barcode);
      if (err instanceof OffRateLimitError) throw err;
      throw err;
    }
  }

  /** Busca y evalua en una sola operacion, y lo anota en el historial. */
  async assess(barcode: string, options: LookupOptions = {}): Promise<Assessment> {
    return this.assessProduct(await this.lookup(barcode, options));
  }

  /**
   * Evalua un producto YA obtenido.
   *
   * Existe porque quien llama suele necesitar el producto antes de puntuarlo
   * -- para comprobar que trae datos suficientes -- y volver a pedirlo por
   * codigo lo encontraba en la cache que acababa de escribir la primera
   * busqueda. Ademas de repetir el trabajo, eso falseaba la procedencia: todo
   * acababa marcado como «guardado en este dispositivo», aunque viniera de
   * Open Food Facts hacia un segundo.
   */
  async assessProduct(product: Product): Promise<Assessment> {
    const ctx = await this.opts.scoringContext();

    if (product.kind === 'cosmetic') {
      const assessment = assessCosmetic(product);
      await addHistory({
        barcode: product.barcode,
        scannedAt: Date.now(),
        name: product.name,
        brand: product.brands?.[0],
        imageThumbUrl: product.imageThumbUrl,
      });
      return { kind: 'cosmetic', product, assessment };
    }

    const score = scoreProduct(product, ctx);
    await addHistory({
      barcode: product.barcode,
      scannedAt: Date.now(),
      name: product.name,
      brand: product.brands?.[0],
      imageThumbUrl: product.imageThumbUrl,
      score: score.value,
      band: score.band,
    });
    return { kind: 'food', product, score };
  }

  /**
   * Busqueda por texto sobre los catalogos descargados.
   *
   * La API de Open Food Facts tambien sabe buscar, pero limita a 10 busquedas
   * por minuto y necesita red. Los catalogos locales no tienen ninguno de los
   * dos problemas.
   */
  async search(term: string, limit = 25): Promise<Product[]> {
    if (!this.opts.catalogs) return [];
    try {
      return await this.opts.catalogs.search(term, limit);
    } catch (err) {
      console.warn('[repositorio] busqueda en catalogos fallida:', err);
      return [];
    }
  }
}
