/**
 * Fuente de datos sobre un snapshot SQLite, una por pais.
 *
 * Ya NO es "una fuente = un Worker": todas cuelgan del Worker unico de
 * `worker-pool.ts`, porque el VFS de OPFS no admite dos instancias sobre el
 * mismo directorio. Cada fuente se identifica ante el Worker con su nombre
 * logico (el pais) y mantiene su propia conexion alli.
 */

import type { ImplausibleNutriment, OrigenValor, Product } from '../../types.js';
import type { OpenStrategy } from './sqlite.worker.js';
import { send, type ProgressHandler } from './worker-pool.js';
import type { DeltaFile } from './delta-sync.js';
import { urlImagenFrontal } from '../off-images.js';

export interface SqliteHttpOptions {
  /** Nombre logico, normalmente el pais. Identifica la conexion en el Worker. */
  source: string;
  /** URL del archivo .sqlite3 servido por un host que soporte HTTP 206 */
  url: string;
  /**
   * `download` baja el archivo entero una vez (y despues funciona sin
   * conexion); `range` consulta solo las paginas necesarias. Lo decide quien
   * construye esta fuente, leyendo el tamano del indice.
   */
  strategy?: OpenStrategy;
  /** Fecha del indice: si cambia, la copia guardada se descarta */
  generatedAt?: string;
  blockSize?: number;
  maxBlocks?: number;
  /** ms antes de dar por perdida una consulta */
  timeout?: number;
  /** Progreso de descarga, para poder mostrarlo */
  onProgress?: ProgressHandler;
}

export interface ReaderStats {
  requests: number;
  bytesTransferred: number;
  cacheHits: number;
  cacheMisses: number;
  evictions: number;
}

export class SqliteHttpSource {
  private ready?: Promise<void>;
  private readonly timeout: number;

  constructor(private readonly opts: SqliteHttpOptions) {
    // Una descarga completa en movil puede tardar bastante mas que una consulta
    // por rangos, asi que el margen es mayor.
    this.timeout = opts.timeout ?? (opts.strategy === 'download' ? 90_000 : 20_000);
  }

  get source(): string {
    return this.opts.source;
  }

  get strategy(): OpenStrategy {
    return this.opts.strategy ?? 'range';
  }

  /** Abre la conexion en el Worker. Idempotente. */
  init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = send<void>(
      {
        type: 'open',
        source: this.opts.source,
        url: this.opts.url,
        strategy: this.opts.strategy,
        generatedAt: this.opts.generatedAt,
        blockSize: this.opts.blockSize,
        maxBlocks: this.opts.maxBlocks,
      },
      { timeout: this.timeout, onProgress: this.opts.onProgress },
    ).then(() => undefined);
    // Si la apertura falla, no dejar cacheada una promesa rechazada: impediria
    // reintentar sin recrear la fuente.
    this.ready.catch(() => {
      this.ready = undefined;
    });
    return this.ready;
  }

  async getProduct(barcode: string): Promise<Product | undefined> {
    await this.init();
    const row = await send<SnapshotRow | null>(
      {
        type: 'get',
        source: this.opts.source,
        sql: 'SELECT * FROM products WHERE barcode = ? LIMIT 1',
        params: [barcode],
      },
      { timeout: this.timeout },
    );
    return row ? rowToProduct(row) : undefined;
  }

  /**
   * Busqueda por texto sobre el indice FTS del snapshot.
   *
   * El SQL lo arma el Worker, no este cliente: solo alli se conocen las
   * columnas reales del archivo abierto, y cliente y datos se despliegan por
   * separado.
   */
  async search(term: string, limit = 25): Promise<Product[]> {
    await this.init();
    const rows = await send<SnapshotRow[]>(
      { type: 'search', source: this.opts.source, term, limit },
      { timeout: this.timeout },
    );
    return rows.map(rowToProduct);
  }

  async stats(): Promise<ReaderStats | null> {
    await this.init();
    return send<ReaderStats | null>({ type: 'stats', source: this.opts.source });
  }

  /** Version de la copia local, o `undefined` si la base no la declara. */
  async version(): Promise<string | undefined> {
    await this.init();
    return (await send<string | null>({ type: 'version', source: this.opts.source })) ?? undefined;
  }

  /**
   * Aplica un delta sobre la copia local.
   *
   * El margen es generoso: sobre un catalogo grande, reconstruir las entradas
   * del indice de texto es lo que manda, no el numero de filas.
   */
  async applyDelta(delta: DeltaFile): Promise<{ applied: number; reindexed: number }> {
    await this.init();
    return send<{ applied: number; reindexed: number }>(
      {
        type: 'apply-delta',
        source: this.opts.source,
        columns: delta.header.columns,
        upserts: delta.upserts,
        deletes: delta.deletes,
        to: delta.header.to,
      },
      { timeout: 120_000 },
    );
  }

  /** Cierra esta conexion. El Worker sigue vivo para las demas fuentes. */
  async close(): Promise<void> {
    if (!this.ready) return;
    this.ready = undefined;
    await send({ type: 'close', source: this.opts.source }).catch(() => {});
  }
}

interface SnapshotRow {
  barcode: string;
  name: string | null;
  brands: string | null;
  quantity: string | null;
  image_ref: string | null;
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
  alcohol: number | null;
  quantity_ml: number | null;
  drink_type: string | null;
  labels: string | null;
  is_beverage: number | null;
  is_water: number | null;
  is_cheese: number | null;
  is_fat_oil_nuts_seeds: number | null;
  is_red_meat: number | null;
  last_modified: number | null;
  popularity: number | null;
  implausible: string | null;
  estimados: string | null;
}

/**
 * Los valores imposibles se guardan como JSON compacto para no anadir una
 * columna por nutriente. Si viniera corrupto se ignora: es informacion
 * adicional, nunca motivo para que la ficha no se muestre.
 */
/** "fvl:estimate,salt:computed" -> objeto. Si viniera roto se ignora. */
function parseEstimados(raw: string | null): Record<string, OrigenValor> | undefined {
  if (!raw) return undefined;
  const out: Record<string, OrigenValor> = {};
  for (const par of raw.split(',')) {
    const [k, v] = par.split(':');
    if (k && (v === 'estimate' || v === 'computed' || v === 'approx')) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseImplausible(raw: string | null): ImplausibleNutriment[] | undefined {
  if (!raw) return undefined;
  try {
    const xs = JSON.parse(raw);
    if (!Array.isArray(xs)) return undefined;
    const out = xs
      .filter((x) => x && typeof x.n === 'string' && Number.isFinite(x.v))
      .map((x) => ({
        key: x.n as string,
        value: x.v as number,
        unit: typeof x.u === 'string' ? x.u : '',
        reason: x.m === 'racion' ? ('racion' as const) : ('max' as const),
        replacedBy: typeof x.s === 'string' ? x.s : undefined,
      }));
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
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
    // La URL se construye aqui: el catalogo solo guarda "<idioma>.<rev>".
    imageUrl: urlImagenFrontal(row.barcode, row.image_ref, 400),
    imageThumbUrl: urlImagenFrontal(row.barcode, row.image_ref, 200),
    ingredientsText: row.ingredients_text ?? undefined,
    additiveTags: splitList(row.additives),
    allergenTags: splitList(row.allergens),
    // El snapshot no guarda etiquetas, categorias ni paises: no los lee nadie y
    // las banderas de categoria vienen ya resueltas en sus propias columnas.
    labelTags: splitList(row.labels),
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
      alcohol: nn(row.alcohol),
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
    quantityMl: nn(row.quantity_ml),
    ...(row.drink_type ? { drinkType: row.drink_type as Product['drinkType'] } : {}),
    implausibleNutriments: parseImplausible(row.implausible),
    estimatedNutriments: parseEstimados(row.estimados),
    // Las banderas vienen NULL cuando no se pudieron resolver. Se traducen a
    // `false` para el calculo -es el valor seguro- pero se anota que no se sabe.
    ...(row.is_beverage === null ? {} : { categoryFlagsSource: 'snapshot' }),
    source: 'snapshot',
    lastModified: nn(row.last_modified),
    fetchedAt: Date.now(),
    editUrl: `https://world.openfoodfacts.org/cgi/product.pl?type=edit&code=${encodeURIComponent(row.barcode)}`,
  };
}
