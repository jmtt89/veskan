/**
 * Capa L2: Open Food Facts / Open Beauty Facts en vivo.
 *
 * Datos verificados contra el servicio real el 2026-09-16:
 *  - Responde `access-control-allow-origin: *`, por lo que se llama directo
 *    desde el navegador sin proxy ni backend.
 *  - Limite: 15 req/min/IP en producto, 10 req/min/IP en busqueda. Superarlo
 *    devuelve 503, comprobado empiricamente.
 *  - Las lecturas NO requieren autenticacion: no hay claves ni cuentas.
 *
 * Identificacion de la aplicacion
 * -------------------------------
 * OFF pide que cada app diga como se llama, para distinguir aplicaciones reales
 * de bots. No es autenticacion: no se verifica nada y no hay secreto alguno.
 *
 * Lo habitual es la cabecera `User-Agent`, pero es una "forbidden header name"
 * de la especificacion Fetch: el navegador la descarta EN SILENCIO. Comprobado:
 * `new Request(url, {headers:{'User-Agent':'x'}}).headers.get('user-agent')`
 * devuelve null. Por eso el nombre viaja como parametro de consulta, que si
 * llega.
 *
 * No se envia ninguna direccion de correo. Nombre y version bastan para que OFF
 * identifique el trafico, y asi no se publica el dato personal de nadie en un
 * repositorio abierto.
 */

import type {
  CategoryFlags,
  DataSource,
  ImplausibleNutriment,
  Nutriments,
  NutriscoreGrade,
  Product,
  ProductKind,
} from '../types.js';
import type { NutriscoreInput } from '../scoring/nutriscore2023.js';
// La escalera vive en `scripts/lib/` y no aqui a proposito: ese arbol se copia
// tal cual al repositorio de datos (veskan-data), que construye los catalogos.
// Si la aplicacion tuviera su propia copia, el catalogo descargado y la API
// podrian leer distinto el mismo producto y dar puntuaciones distintas.
import { leerNutrientes } from '../../../scripts/lib/nutrients.mjs';
import { ingredientesDe, nombreDe } from '../../../scripts/lib/nombres.mjs';
import { banderasDe } from '../../../scripts/lib/categorias.mjs';

export const OFF_BASE = 'https://world.openfoodfacts.org';
export const OBF_BASE = 'https://world.openbeautyfacts.org';

/** Campos que pedimos siempre. Acotarlos baja la respuesta de ~50 kB a ~2.5 kB. */
const PRODUCT_FIELDS = [
  // `nutrition_data_per`, `serving_quantity` y `no_nutrition_data` son los
  // campos de ORIGEN de los nutrientes: los `_100g` son calculados y no
  // siempre vienen. Ver `nutrients.mjs`.
  'nutrition_data_per',
  'serving_quantity',
  'no_nutrition_data',
  'code',
  'product_name',
  'lang',
  'generic_name',
  'brands',
  'quantity',
  'image_front_url',
  'image_front_small_url',
  'ingredients_text',
  'additives_tags',
  'allergens_tags',
  'labels_tags',
  'categories_tags',
  'countries_tags',
  'nutriments',
  'nutriscore_data',
  'nutriscore_grade',
  'nova_group',
  'nova_groups_tags',
  'ingredients_analysis_tags',
  'last_modified_t',
].join(',');

const COSMETIC_FIELDS = [
  'code',
  'product_name',
  'brands',
  'quantity',
  'image_front_url',
  'image_front_small_url',
  'ingredients_text',
  'ingredients',
  'allergens_tags',
  'labels_tags',
  'categories_tags',
  'countries_tags',
  'periods_after_opening',
  'last_modified_t',
].join(',');

export interface OffClientOptions {
  /** Nombre con el que la app se presenta ante OFF. Publico, no es un secreto. */
  appName: string;
  appVersion: string;
  /**
   * URL publica del proyecto. Opcional. Sirve como via de contacto en los
   * entornos donde la cabecera `User-Agent` si se puede fijar (Node), en lugar
   * de exponer el correo de una persona.
   */
  projectUrl?: string;
  /** Idioma de los campos localizados */
  lang?: string;
  fetchImpl?: typeof fetch;
  /** ms */
  timeout?: number;
}

export class OffRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('Open Food Facts ha limitado la tasa de peticiones');
    this.name = 'OffRateLimitError';
  }
}

export class OffNotFoundError extends Error {
  constructor(public readonly barcode: string) {
    super(`Producto ${barcode} no encontrado`);
    this.name = 'OffNotFoundError';
  }
}

/**
 * Cliente con limitador de tasa propio.
 *
 * Nos auto-limitamos por debajo del limite del servidor en lugar de esperar al
 * 503: es mas educado con un servicio donado y evita que el usuario vea
 * errores que podemos prevenir.
 */
export class OffClient {
  private readonly appName: string;
  private readonly appVersion: string;
  private readonly userAgent: string;
  private readonly lang: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;
  private recentCalls: number[] = [];
  private static readonly MAX_CALLS_PER_MINUTE = 12; // margen bajo el limite real de 15

  constructor(opts: OffClientOptions) {
    this.appName = opts.appName;
    this.appVersion = opts.appVersion;
    // En el navegador esta cabecera se descarta; en Node si se envia.
    this.userAgent = `${opts.appName}/${opts.appVersion}${
      opts.projectUrl ? ` (+${opts.projectUrl})` : ''
    }`;
    this.lang = opts.lang ?? 'es';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeout = opts.timeout ?? 12_000;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    this.recentCalls = this.recentCalls.filter((t) => now - t < 60_000);
    if (this.recentCalls.length >= OffClient.MAX_CALLS_PER_MINUTE) {
      const oldest = this.recentCalls[0]!;
      const waitMs = 60_000 - (now - oldest) + 250;
      throw new OffRateLimitError(waitMs);
    }
    this.recentCalls.push(now);
  }

  async getProduct(barcode: string, kind: 'food' | 'cosmetic' = 'food'): Promise<Product> {
    await this.throttle();
    const base = kind === 'cosmetic' ? OBF_BASE : OFF_BASE;
    const fields = kind === 'cosmetic' ? COSMETIC_FIELDS : PRODUCT_FIELDS;
    const params = new URLSearchParams({
      fields,
      lc: this.lang,
      // Identificacion de la app: publica, sin datos personales.
      app_name: this.appName,
      app_version: this.appVersion,
    });
    const url = `${base}/api/v2/product/${encodeURIComponent(barcode)}.json?${params}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 429 || res.status === 503) throw new OffRateLimitError(30_000);
      if (res.status === 404) throw new OffNotFoundError(barcode);
      if (!res.ok) throw new Error(`Open Food Facts respondio ${res.status}`);
      const body = (await res.json()) as OffApiResponse;
      if (body.status !== 1 || !body.product) throw new OffNotFoundError(barcode);
      return offProductToProduct(
        body.product,
        kind === 'cosmetic' ? 'openbeautyfacts' : 'openfoodfacts',
        this.lang,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Tipos crudos de la API
// ---------------------------------------------------------------------------

interface OffApiResponse {
  status: number;
  product?: OffRawProduct;
}

export interface OffNutriscoreComponent {
  id: string;
  value: number | null;
  points: number;
  points_max?: number;
  unit?: string;
}

export interface OffNutriscoreData {
  score?: number;
  grade?: string;
  negative_points?: number;
  positive_points?: number;
  is_beverage?: number | boolean | string;
  is_water?: number | boolean | string;
  is_cheese?: number | boolean | string;
  is_fat_oil_nuts_seeds?: number | boolean | string;
  is_red_meat_product?: number | boolean | string;
  count_proteins?: number | boolean | string;
  components?: {
    negative?: OffNutriscoreComponent[];
    positive?: OffNutriscoreComponent[];
  };
}

export interface OffRawProduct {
  code: string;
  product_name?: string;
  /** Idioma principal que Open Food Facts asigna al producto. */
  lang?: string;
  generic_name?: string;
  brands?: string;
  quantity?: string;
  image_front_url?: string;
  image_front_small_url?: string;
  ingredients_text?: string;
  additives_tags?: string[];
  allergens_tags?: string[];
  labels_tags?: string[];
  categories_tags?: string[];
  countries_tags?: string[];
  ingredients_analysis_tags?: string[];
  nutriments?: Record<string, number | string | undefined>;
  /**
   * Base de los valores sin sufijo de `nutriments`. Sin este campo no se
   * pueden leer los productos cuyos `_100g` -que son calculados- no vienen.
   */
  nutrition_data_per?: 'serving' | '100g';
  /** Racion en gramos, ya calculada por Open Food Facts. */
  serving_quantity?: number | string;
  /** "on" cuando el producto declara no llevar tabla nutricional. */
  no_nutrition_data?: string | boolean;
  nutriscore_data?: OffNutriscoreData;
  /** Estructura v3: `nutriscore["2023"].data` trae las banderas en el 99,1%. */
  nutriscore?: Record<string, { data?: Record<string, unknown> } | undefined>;
  /** `nutrition.aggregated_set.nutrients`: los nutrientes normalizados por 100 g. */
  nutrition?: { aggregated_set?: { nutrients?: Record<string, unknown> } };
  nutriscore_grade?: string;
  nova_group?: number;
  nova_groups_tags?: string[];
  last_modified_t?: number;
  periods_after_opening?: string;
}

// ---------------------------------------------------------------------------
// Traduccion a nuestro dominio
// ---------------------------------------------------------------------------

export function extractNutriments(raw: OffRawProduct): Nutriments {
  // La lectura vive en `nutrients.mjs`, compartida con la tuberia de datos: si
  // cada lado leyera a su manera, un producto del catalogo descargado y el
  // mismo producto resuelto por la API darian puntuaciones distintas.
  const { valores } = leerNutrientes(raw);
  const v = (x: number | null): number | undefined => (x === null ? undefined : x);

  return {
    energyKj: v(valores.energy_kj),
    energyKcal: v(valores.energy_kcal),
    fat: v(valores.fat),
    saturatedFat: v(valores.saturated_fat),
    transFat: v(valores.trans_fat),
    carbohydrates: v(valores.carbohydrates),
    sugars: v(valores.sugars),
    fiber: v(valores.fiber),
    proteins: v(valores.proteins),
    salt: v(valores.salt),
    // La escalera devuelve gramos; nuestro dominio guarda el sodio en mg.
    sodium: valores.sodium === null ? undefined : valores.sodium * 1000,
    fruitsVegetablesLegumes: v(valores.fvl),
  };
}

/**
 * Nutrientes que Open Food Facts registra con un valor imposible. No se tiran:
 * la ficha los muestra para que el usuario sepa que el dato existe y que hay
 * que comprobarlo en el envase. Ver `nutrients.mjs`.
 */
export function extractImplausible(raw: OffRawProduct): ImplausibleNutriment[] | undefined {
  const { imposibles } = leerNutrientes(raw);
  if (!imposibles.length) return undefined;
  return imposibles.map((x) => ({
    key: x.nutriente,
    value: x.valor,
    unit: x.unidad,
    reason: x.motivo === 'racion-incoherente' ? 'racion' : 'max',
    replacedBy: x.sustituido ?? undefined,
  }));
}

export function extractCategoryFlags(raw: OffRawProduct): CategoryFlags {
  // Se resuelven en `scripts/lib/categorias.mjs`, compartido con la tuberia.
  // Aqui se deducian de `categories_tags` y alli se leian de `nutriscore_data`:
  // dos fuentes distintas para el mismo producto, con 43,5% y 29,6% de
  // cobertura, cuando `nutriscore["2023"].data` las tiene en el 99,1%.
  const { isBeverage, isWater, isCheese, isFatOilNutsSeeds, isRedMeat } = banderasDe(raw);
  return { isBeverage, isWater, isCheese, isFatOilNutsSeeds, isRedMeat };
}

function detectKind(raw: OffRawProduct, source: DataSource): ProductKind {
  if (source === 'openbeautyfacts') return 'cosmetic';
  const flags = extractCategoryFlags(raw);
  return flags.isBeverage ? 'beverage' : 'food';
}

/**
 * `idioma` es el que prefiere el usuario. Es opcional porque el producto puede
 * no tenerlo, y entonces se coge cualquier variante antes que dejarlo sin
 * nombre: un producto sin nombre no se muestra.
 */
export function offProductToProduct(
  raw: OffRawProduct,
  source: DataSource,
  idioma?: string,
): Product {
  const kind = detectKind(raw, source);
  const editBase = source === 'openbeautyfacts' ? OBF_BASE : OFF_BASE;
  const grade = raw.nutriscore_data?.grade ?? raw.nutriscore_grade;

  return {
    barcode: raw.code,
    // El idioma del usuario manda, pero si el producto no lo tiene se coge
    // cualquiera antes que dejarlo sin nombre.
    name: nombreDe(raw, idioma) ?? undefined,
    brands: raw.brands
      ? raw.brands
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean)
      : [],
    kind,
    quantity: raw.quantity,
    imageUrl: raw.image_front_url,
    imageThumbUrl: raw.image_front_small_url,
    ingredientsText: ingredientesDe(raw, idioma) ?? undefined,
    additiveTags: raw.additives_tags ?? [],
    allergenTags: raw.allergens_tags ?? [],
    labelTags: raw.labels_tags ?? [],
    categoryTags: raw.categories_tags ?? [],
    countryTags: raw.countries_tags ?? [],
    nutriments: extractNutriments(raw),
    implausibleNutriments: extractImplausible(raw),
    novaGroup:
      raw.nova_group !== undefined && raw.nova_group >= 1 && raw.nova_group <= 4
        ? (raw.nova_group as 1 | 2 | 3 | 4)
        : undefined,
    // Ojo: `'abcde'.includes('')` devuelve true, y OFF envia tanto cadena vacia
    // como "not-applicable" o "unknown". Se comprueba la longitud exacta.
    offNutriscoreGrade:
      grade && grade.length === 1 && 'abcde'.includes(grade)
        ? (grade as NutriscoreGrade)
        : undefined,
    offNutriscoreScore: raw.nutriscore_data?.score,
    categoryFlags: extractCategoryFlags(raw),
    source,
    lastModified: raw.last_modified_t ? raw.last_modified_t * 1000 : undefined,
    fetchedAt: Date.now(),
    editUrl: `${editBase}/cgi/product.pl?type=edit&code=${encodeURIComponent(raw.code)}`,
  };
}

/**
 * Construye la entrada del calculo Nutri-Score a partir de un producto crudo.
 *
 * Si OFF ya publico `nutriscore_data.components`, se usan ESOS valores. No es
 * pereza: OFF estima el porcentaje de frutas/verduras/legumbres analizando la
 * lista de ingredientes con su propia taxonomia, y esa estimacion no es
 * reproducible desde fuera. Usando sus valores de entrada, el test comprueba lo
 * que si nos corresponde: la asignacion de puntos y las reglas de combinacion.
 */
export function offProductToNutriscoreInput(raw: OffRawProduct): NutriscoreInput {
  const flags = extractCategoryFlags(raw);
  const nd = raw.nutriscore_data;
  const comps = [...(nd?.components?.negative ?? []), ...(nd?.components?.positive ?? [])];

  if (comps.length > 0) {
    const byId = new Map(comps.map((c) => [c.id, c.value ?? undefined]));
    const sweetenerComponent = nd?.components?.negative?.find(
      (c) => c.id === 'non_nutritive_sweeteners',
    );
    return {
      energy: byId.get('energy'),
      energyFromSaturatedFat: byId.get('energy_from_saturated_fat'),
      sugars: byId.get('sugars'),
      saturatedFat: byId.get('saturated_fat'),
      saturatedFatRatio: byId.get('saturated_fat_ratio'),
      salt: byId.get('salt'),
      fruitsVegetablesLegumes: byId.get('fruits_vegetables_legumes'),
      fiber: byId.get('fiber'),
      proteins: byId.get('proteins'),
      nonNutritiveSweeteners: (sweetenerComponent?.points ?? 0) > 0,
      flags,
    };
  }

  // Sin datos previos, se calcula desde los nutrientes crudos.
  const nut = extractNutriments(raw);
  const satRatio =
    nut.fat !== undefined && nut.fat > 0 && nut.saturatedFat !== undefined
      ? (nut.saturatedFat / nut.fat) * 100
      : undefined;
  return {
    energy: nut.energyKj,
    energyFromSaturatedFat: nut.saturatedFat !== undefined ? nut.saturatedFat * 37 : undefined,
    sugars: nut.sugars,
    saturatedFat: nut.saturatedFat,
    saturatedFatRatio: satRatio,
    salt: nut.salt,
    fruitsVegetablesLegumes: nut.fruitsVegetablesLegumes,
    fiber: nut.fiber,
    proteins: nut.proteins,
    nonNutritiveSweeteners: hasNonNutritiveSweetener(raw.additives_tags ?? []),
    flags,
  };
}

/**
 * Edulcorantes no nutritivos autorizados en la UE, por numero E.
 * Fuente: taxonomia de aditivos de OFF, campo `non_nutritive_sweetener`.
 */
const NON_NUTRITIVE_SWEETENERS = new Set([
  'en:e950', // acesulfamo K
  'en:e951', // aspartamo
  'en:e952', // ciclamato
  'en:e954', // sacarina
  'en:e955', // sucralosa
  'en:e957', // taumatina
  'en:e959', // neohesperidina DC
  'en:e960', // glucosidos de esteviol
  'en:e961', // neotamo
  'en:e962', // sal de aspartamo-acesulfamo
  'en:e969', // advantamo
]);

export function hasNonNutritiveSweetener(additiveTags: string[]): boolean {
  return additiveTags.some((t) => NON_NUTRITIVE_SWEETENERS.has(t.toLowerCase()));
}
