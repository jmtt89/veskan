/**
 * Nutri-Score 2023 (FSAm-NPS revisado).
 *
 * Port directo de la implementacion de referencia de Open Food Facts
 * (`lib/ProductOpener/Nutriscore.pm`, funcion `compute_nutriscore_score_2023`),
 * descargada y leida el 2026-09-16. Se porto desde el codigo fuente y no desde
 * articulos divulgativos porque las tablas que circulan en la web estan
 * redondeadas o incompletas.
 *
 * Objetivo explicito: para un mismo producto, este modulo debe devolver el
 * mismo `score` y `grade` que devuelve la API de OFF en `nutriscore_data`.
 * Eso es exactamente lo que verifican los tests.
 */

import type {
  CategoryFlags,
  NutriscoreComponent,
  NutriscoreGrade,
  NutriscoreResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Tablas de umbrales (valores exactos de la referencia)
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  // --- puntos negativos ---
  /** kJ / 100 g */
  energy: [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350],
  /** kJ / 100 ml */
  energy_beverages: [30, 90, 150, 210, 240, 270, 300, 330, 360, 390],
  /** g / 100 g */
  sugars: [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51],
  /** g / 100 ml */
  sugars_beverages: [0.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11],
  /** g / 100 g */
  saturated_fat: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  /** g / 100 g (sal, NO sodio) */
  salt: [
    0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4,
  ],

  // --- variantes para grasas, aceites, frutos secos y semillas ---
  /** kJ / 100 g procedentes de grasas saturadas */
  energy_from_saturated_fat: [120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200],
  /** % de grasa saturada sobre grasa total */
  saturated_fat_ratio: [10, 16, 22, 28, 34, 40, 46, 52, 58, 64],

  // --- puntos positivos ---
  /** % */
  fruits_vegetables_legumes: [40, 60, 80, 80, 80],
  fruits_vegetables_legumes_beverages: [40, 40, 60, 60, 80, 80],
  /** g / 100 g, metodo AOAC */
  fiber: [3.0, 4.1, 5.2, 6.3, 7.4],
  /** g / 100 g */
  proteins: [2.4, 4.8, 7.2, 9.6, 12, 14, 17],
  /** g / 100 ml */
  proteins_beverages: [1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0],
} as const satisfies Record<string, readonly number[]>;

type ThresholdKey = keyof typeof THRESHOLDS;

/** Entrada del calculo. Todo por 100 g o 100 ml. */
export interface NutriscoreInput {
  /** kJ / 100 g */
  energy?: number;
  /** kJ / 100 g procedentes de grasa saturada (solo grasas/aceites/frutos secos) */
  energyFromSaturatedFat?: number;
  /** g / 100 g */
  sugars?: number;
  saturatedFat?: number;
  /** % = grasa saturada / grasa total * 100 */
  saturatedFatRatio?: number;
  /** g / 100 g de SAL (no sodio) */
  salt?: number;
  /** % de frutas, verduras, legumbres y frutos secos */
  fruitsVegetablesLegumes?: number;
  fiber?: number;
  proteins?: number;
  /** Presencia de edulcorantes no nutritivos (solo penaliza en bebidas) */
  nonNutritiveSweeteners?: boolean;
  flags: CategoryFlags;
}

const UNITS: Record<string, string> = {
  energy: 'kJ',
  energy_beverages: 'kJ',
  energy_from_saturated_fat: 'kJ',
  sugars: 'g',
  sugars_beverages: 'g',
  saturated_fat: 'g',
  saturated_fat_ratio: '%',
  salt: 'g',
  non_nutritive_sweeteners: '',
  fruits_vegetables_legumes: '%',
  fruits_vegetables_legumes_beverages: '%',
  fiber: 'g',
  proteins: 'g',
  proteins_beverages: 'g',
};

/**
 * Cuenta cuantos umbrales supera el valor.
 *
 * Detalle que se pasa por alto con facilidad y que la referencia trata como
 * caso especial: `saturated_fat_ratio` compara con `>=`; todo lo demas con `>`.
 */
function countPoints(value: number | undefined, key: ThresholdKey, nutrientId: string): number {
  if (value === undefined || value === null || Number.isNaN(value)) return 0;
  const table = THRESHOLDS[key];
  const useGreaterOrEqual = nutrientId === 'saturated_fat_ratio';
  let points = 0;
  for (const threshold of table) {
    if (useGreaterOrEqual ? value >= threshold : value > threshold) points++;
  }
  return points;
}

/** Elige la tabla `_beverages` cuando existe y el producto es bebida. */
function thresholdKeyFor(nutrientId: string, isBeverage: boolean): ThresholdKey {
  const beverageKey = `${nutrientId}_beverages`;
  if (isBeverage && beverageKey in THRESHOLDS) return beverageKey as ThresholdKey;
  return nutrientId as ThresholdKey;
}

function round2(v: number | undefined): number | undefined {
  if (v === undefined || v === null || Number.isNaN(v)) return undefined;
  return Math.round(v * 100) / 100;
}

/**
 * Cortes a letra. Ojo: son `<=` inclusivos, no `<`. Los articulos divulgativos
 * suelen escribirlos como `< 1`, `< 3`, `< 11`, `< 19`, que coincide solo
 * porque el score siempre es entero.
 */
export function computeGrade2023(
  score: number,
  flags: Pick<CategoryFlags, 'isBeverage' | 'isWater' | 'isFatOilNutsSeeds'>,
): NutriscoreGrade {
  if (flags.isBeverage) {
    if (flags.isWater) return 'a';
    if (score <= 2) return 'b';
    if (score <= 6) return 'c';
    if (score <= 9) return 'd';
    return 'e';
  }
  if (flags.isFatOilNutsSeeds) {
    if (score <= -6) return 'a';
    if (score <= 2) return 'b';
    if (score <= 10) return 'c';
    if (score <= 18) return 'd';
    return 'e';
  }
  if (score <= 0) return 'a';
  if (score <= 2) return 'b';
  if (score <= 10) return 'c';
  if (score <= 18) return 'd';
  return 'e';
}

export function computeNutriscore2023(input: NutriscoreInput): NutriscoreResult {
  const { flags } = input;
  const isBeverage = flags.isBeverage;

  // En grasas, aceites, frutos secos y semillas, dos componentes se sustituyen:
  // la energia pasa a ser energia procedente de grasa saturada, y la grasa
  // saturada pasa a ser el ratio grasa saturada / grasa total.
  const energyId = flags.isFatOilNutsSeeds ? 'energy_from_saturated_fat' : 'energy';
  const satFatId = flags.isFatOilNutsSeeds ? 'saturated_fat_ratio' : 'saturated_fat';

  const values: Record<string, number | undefined> = {
    energy: input.energy,
    energy_from_saturated_fat: input.energyFromSaturatedFat,
    sugars: input.sugars,
    saturated_fat: input.saturatedFat,
    saturated_fat_ratio: input.saturatedFatRatio,
    salt: input.salt,
    fruits_vegetables_legumes: input.fruitsVegetablesLegumes,
    fiber: input.fiber,
    proteins: input.proteins,
  };

  const missingInputs: string[] = [];
  const points: Record<string, number> = {};
  const pointsMax: Record<string, number> = {};

  for (const nutrientId of [
    energyId,
    'sugars',
    satFatId,
    'salt',
    'fruits_vegetables_legumes',
    'fiber',
    'proteins',
  ]) {
    const key = thresholdKeyFor(nutrientId, isBeverage);
    points[nutrientId] = countPoints(values[nutrientId], key, nutrientId);
    pointsMax[nutrientId] = THRESHOLDS[key].length;
    if (values[nutrientId] === undefined) missingInputs.push(nutrientId);
  }

  // Carne roja: los puntos positivos por proteina se limitan a 2.
  let proteinsLimitedReason: string | undefined;
  if (flags.isRedMeat && (points['proteins'] ?? 0) > 2) {
    points['proteins'] = 2;
    proteinsLimitedReason = 'red_meat_product';
  }

  // --- puntos negativos ---
  const negativeIds = [energyId, 'sugars', satFatId, 'salt'];
  if (isBeverage) negativeIds.push('non_nutritive_sweeteners');

  if (isBeverage) {
    // Sin lista de ingredientes se asume ausencia de edulcorantes, igual que
    // hace la referencia.
    points['non_nutritive_sweeteners'] = input.nonNutritiveSweeteners ? 4 : 0;
    pointsMax['non_nutritive_sweeteners'] = 4;
    values['non_nutritive_sweeteners'] = input.nonNutritiveSweeteners ? 1 : 0;
  }

  const negative: NutriscoreComponent[] = [];
  let negativePoints = 0;
  let negativePointsMax = 0;
  for (const id of negativeIds) {
    const p = points[id] ?? 0;
    const pMax = pointsMax[id] ?? 0;
    negative.push({
      id,
      value: round2(values[id]),
      unit: UNITS[thresholdKeyFor(id, isBeverage)] ?? UNITS[id] ?? '',
      points: p,
      pointsMax: pMax,
    });
    negativePoints += p;
    negativePointsMax += pMax;
  }

  // --- puntos positivos ---
  // La proteina solo cuenta en tres casos, y este es el punto donde mas se
  // equivocan las reimplementaciones:
  //   - bebidas: siempre
  //   - quesos: siempre
  //   - grasas/aceites/frutos secos/semillas: si los puntos negativos < 7
  //   - resto: si los puntos negativos < 11
  let countProteins = false;
  let countProteinsReason: string;
  if (isBeverage) {
    countProteins = true;
    countProteinsReason = 'beverage';
  } else if (flags.isCheese) {
    countProteins = true;
    countProteinsReason = 'cheese';
  } else if (flags.isFatOilNutsSeeds) {
    countProteins = negativePoints < 7;
    countProteinsReason = countProteins
      ? 'negative_points_less_than_7'
      : 'negative_points_greater_than_or_equal_to_7';
  } else {
    countProteins = negativePoints < 11;
    countProteinsReason = countProteins
      ? 'negative_points_less_than_11'
      : 'negative_points_greater_than_or_equal_to_11';
  }

  const positiveIds = countProteins
    ? ['proteins', 'fiber', 'fruits_vegetables_legumes']
    : ['fiber', 'fruits_vegetables_legumes'];

  const positive: NutriscoreComponent[] = [];
  let positivePoints = 0;
  let positivePointsMax = 0;
  for (const id of positiveIds) {
    const p = points[id] ?? 0;
    const pMax = pointsMax[id] ?? 0;
    positive.push({
      id,
      value: round2(values[id]),
      unit: UNITS[thresholdKeyFor(id, isBeverage)] ?? UNITS[id] ?? '',
      points: p,
      pointsMax: pMax,
    });
    positivePoints += p;
    positivePointsMax += pMax;
  }

  const score = negativePoints - positivePoints;
  const grade = computeGrade2023(score, flags);

  return {
    score,
    grade,
    negativePoints,
    negativePointsMax,
    positivePoints,
    positivePointsMax,
    components: { negative, positive },
    countProteins,
    countProteinsReason,
    proteinsLimitedReason,
    missingInputs,
  };
}

/**
 * Normaliza el score Nutri-Score a una escala 0-100 (100 = mejor).
 *
 * El rango teorico depende de la categoria, asi que se normaliza contra los
 * limites reales de cada una en vez de usar un rango unico, que aplastaria las
 * bebidas contra el extremo bueno.
 */
export function nutriscoreToHundred(result: NutriscoreResult, flags: CategoryFlags): number {
  let min: number;
  let max: number;
  if (flags.isBeverage) {
    if (flags.isWater) return 100;
    min = -15;
    max = 14;
  } else if (flags.isFatOilNutsSeeds) {
    min = -17;
    max = 30;
  } else {
    min = -17;
    max = 40;
  }
  const clamped = Math.min(Math.max(result.score, min), max);
  return ((max - clamped) / (max - min)) * 100;
}

export const GRADE_ORDER: NutriscoreGrade[] = ['a', 'b', 'c', 'd', 'e'];
