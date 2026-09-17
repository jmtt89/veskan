/**
 * Cliente del Worker de SQLite remoto (capa L1).
 *
 * Expone una API de promesas sobre el paso de mensajes, y traduce las filas
 * del snapshot a nuestro modelo de dominio.
 */

import type { Product } from '../../types.js';
import type { WorkerRequest, WorkerResponse } from './sqlite.worker.js';

/**
 * `Omit<Union, K>` colapsa una union discriminada en un solo objeto y pierde
 * las variantes. Esta version se distribuye sobre cada miembro y las conserva.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type WorkerCommand = DistributiveOmit<WorkerRequest, 'id'>;

export interface SqliteHttpOptions {
  /** URL del archivo .sqlite3 servido por un host que soporte HTTP 206 */
  url: string;
  /**
   * `download` baja el archivo entero una vez (y despues funciona sin
   * conexion); `range` consulta solo las paginas necesarias. Lo decide quien
   * construye esta fuente, leyendo el tamano del indice.
   */
  strategy?: 'range' | 'download';
  /** Clave de cache local; normalmente el pais */
  cacheKey?: string;
  /** Fecha del indice: si cambia, la copia guardada se descarta */
  generatedAt?: string;
  blockSize?: number;
  maxBlocks?: number;
  /** ms antes de dar por perdida una consulta */
  timeout?: number;
  /** Progreso de descarga, para poder mostrarlo */
  onProgress?: (p: { loaded: number; total: number }) => void;
}

export interface ReaderStats {
  requests: number;
  bytesTransferred: number;
  cacheHits: number;
  cacheMisses: number;
  evictions: number;
}

export class SqliteHttpSource {
  private worker?: Worker;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private ready?: Promise<void>;
  private readonly timeout: number;
  private readonly onProgress?: (p: { loaded: number; total: number }) => void;

  constructor(private readonly opts: SqliteHttpOptions) {
    // Una descarga completa en movil puede tardar bastante mas que una consulta
    // por rangos, asi que el margen es mayor.
    this.timeout = opts.timeout ?? (opts.strategy === 'download' ? 90_000 : 20_000);
    this.onProgress = opts.onProgress;
  }

  /** Arranca el Worker y abre la base. Idempotente. */
  init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.worker = new Worker(new URL('./sqlite.worker.js', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
      this.worker.onerror = (e) => {
        for (const [, p] of this.pending) p.reject(new Error(`Worker de SQLite: ${e.message}`));
        this.pending.clear();
      };
      await this.send({
        type: 'open',
        url: this.opts.url,
        strategy: this.opts.strategy,
        cacheKey: this.opts.cacheKey,
        generatedAt: this.opts.generatedAt,
        blockSize: this.opts.blockSize,
        maxBlocks: this.opts.maxBlocks,
      });
    })();
    return this.ready;
  }

  private handle(res: WorkerResponse): void {
    const entry = this.pending.get(res.id);
    if (!entry) return;

    // Los mensajes de progreso no resuelven la promesa: solo informan. Y
    // reinician el temporizador, porque una descarga lenta pero viva no debe
    // darse por perdida.
    if ('progress' in res) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        this.pending.delete(res.id);
        entry.reject(new Error(`Descarga del snapshot agotada tras ${this.timeout} ms sin avance`));
      }, this.timeout);
      this.onProgress?.(res.progress);
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(res.id);
    if (res.ok) entry.resolve(res.result);
    else entry.reject(new Error(res.error));
  }

  private send<T = unknown>(msg: WorkerCommand): Promise<T> {
    if (!this.worker) throw new Error('Worker no iniciado');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Consulta a la base remota agotada tras ${this.timeout} ms`));
      }, this.timeout);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.worker!.postMessage({ ...msg, id } as WorkerRequest);
    });
  }

  async getProduct(barcode: string): Promise<Product | undefined> {
    await this.init();
    const row = await this.send<SnapshotRow | null>({
      type: 'get',
      sql: 'SELECT * FROM products WHERE barcode = ? LIMIT 1',
      params: [barcode],
    });
    return row ? rowToProduct(row) : undefined;
  }

  /** Busqueda por texto sobre el indice FTS del snapshot. */
  async search(term: string, limit = 25): Promise<Product[]> {
    await this.init();
    const cleaned = term.trim().replace(/["']/g, '');
    if (!cleaned) return [];
    const rows = await this.send<SnapshotRow[]>({
      type: 'query',
      // Se une por `barcode`, no por rowid: la tabla `products` es
      // WITHOUT ROWID y por tanto no tiene columna rowid que usar.
      sql: `SELECT p.* FROM products_fts f
            JOIN products p ON p.barcode = f.barcode
            WHERE products_fts MATCH ?
            ORDER BY rank
            LIMIT ?`,
      params: [`${cleaned}*`, limit],
    });
    return rows.map(rowToProduct);
  }

  async stats(): Promise<ReaderStats | null> {
    await this.init();
    return this.send<ReaderStats | null>({ type: 'stats' });
  }

  async close(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.send({ type: 'close' });
    } finally {
      this.worker.terminate();
      this.worker = undefined;
      this.ready = undefined;
    }
  }
}

interface SnapshotRow {
  barcode: string;
  name: string | null;
  brands: string | null;
  quantity: string | null;
  image_url: string | null;
  ingredients_text: string | null;
  additives: string | null;
  allergens: string | null;
  nova_group: number | null;
  nutriscore_grade: string | null;
  nutriscore_score: number | null;
  energy_kj: number | null;
  energy_kcal: number | null;
  fat: number | null;
  saturated_fat: number | null;
  trans_fat: number | null;
  carbohydrates: number | null;
  sugars: number | null;
  fiber: number | null;
  proteins: number | null;
  salt: number | null;
  sodium: number | null;
  fvl: number | null;
  is_beverage: number | null;
  is_water: number | null;
  is_cheese: number | null;
  is_fat_oil_nuts_seeds: number | null;
  is_red_meat: number | null;
  last_modified: number | null;
}

const splitList = (v: string | null): string[] =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

const nn = (v: number | null): number | undefined => (v === null ? undefined : v);

function rowToProduct(row: SnapshotRow): Product {
  const grade = row.nutriscore_grade;
  return {
    barcode: row.barcode,
    name: row.name ?? undefined,
    brands: splitList(row.brands),
    kind: row.is_beverage ? 'beverage' : 'food',
    quantity: row.quantity ?? undefined,
    imageUrl: row.image_url ?? undefined,
    imageThumbUrl: row.image_url ?? undefined,
    ingredientsText: row.ingredients_text ?? undefined,
    additiveTags: splitList(row.additives),
    allergenTags: splitList(row.allergens),
    // El snapshot no guarda etiquetas, categorias ni paises: no los lee nadie y
    // las banderas de categoria vienen ya resueltas en sus propias columnas.
    labelTags: [],
    categoryTags: [],
    countryTags: [],
    nutriments: {
      energyKj: nn(row.energy_kj),
      energyKcal: nn(row.energy_kcal),
      fat: nn(row.fat),
      saturatedFat: nn(row.saturated_fat),
      transFat: nn(row.trans_fat),
      carbohydrates: nn(row.carbohydrates),
      sugars: nn(row.sugars),
      fiber: nn(row.fiber),
      proteins: nn(row.proteins),
      salt: nn(row.salt),
      sodium: nn(row.sodium),
      fruitsVegetablesLegumes: nn(row.fvl),
    },
    novaGroup:
      row.nova_group && row.nova_group >= 1 && row.nova_group <= 4
        ? (row.nova_group as 1 | 2 | 3 | 4)
        : undefined,
    offNutriscoreGrade:
      grade && grade.length === 1 && 'abcde'.includes(grade)
        ? (grade as Product['offNutriscoreGrade'])
        : undefined,
    offNutriscoreScore: nn(row.nutriscore_score),
    categoryFlags: {
      isBeverage: Boolean(row.is_beverage),
      isWater: Boolean(row.is_water),
      isCheese: Boolean(row.is_cheese),
      isFatOilNutsSeeds: Boolean(row.is_fat_oil_nuts_seeds),
      isRedMeat: Boolean(row.is_red_meat),
    },
    source: 'snapshot',
    lastModified: nn(row.last_modified),
    fetchedAt: Date.now(),
    editUrl: `https://world.openfoodfacts.org/cgi/product.pl?type=edit&code=${encodeURIComponent(row.barcode)}`,
  };
}
