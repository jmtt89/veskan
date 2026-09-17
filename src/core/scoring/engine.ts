/**
 * Motor de puntuacion global.
 *
 * Combina cuatro bloques con base cientifica o regulatoria independiente, y
 * deja registro de la contribucion de cada uno para poder explicar el numero
 * renglon por renglon. Nada aqui es una constante magica sin justificacion en
 * `docs/03-algoritmo.md`.
 *
 * Diferencias deliberadas frente a Yuka (60% nutricion / 30% aditivos / 10%
 * organico):
 *  - No hay bonificacion por "organico": no tiene respaldo en resultados de
 *    salud. La etiqueta se muestra como informacion, no como puntos.
 *  - No hay tope duro opaco (Yuka congela en 49/100 con un aditivo de riesgo).
 *    La penalizacion es fuerte pero gradual y explicada.
 *  - Se separa el grado de procesamiento (NOVA) de la calidad nutricional,
 *    porque son dimensiones ortogonales.
 *  - Se declara la confianza: con datos incompletos se dice, en vez de fingir
 *    precision.
 */

import type {
  Confidence,
  HealthScore,
  Product,
  ScoreBreakdownItem,
} from '../types.js';
import { computeNutriscore2023, nutriscoreToHundred } from './nutriscore2023.js';
import { offProductToNutriscoreInput } from '../data/off.js';
import { assessAdditives, type AdditiveTaxonomy } from './additives.js';
import { inferNova, NOVA_LABELS, novaToHundred } from './nova.js';
import { evaluatePaho } from './paho.js';

export const ALGORITHM_VERSION = '1.0.0';

/** Pesos de los bloques. Suman 1. Documentados en docs/03-algoritmo.md. */
export const WEIGHTS = {
  nutrition: 0.55,
  processing: 0.2,
  additives: 0.2,
  regulatory: 0.05,
} as const;

/** Penalizacion por cada sello de advertencia OPS, en puntos del total. */
const PAHO_SEAL_PENALTY = 4;
/** Techo de penalizacion por sellos, para que no aplaste al resto. */
const PAHO_MAX_PENALTY = 16;

export interface ScoringContext {
  additiveTaxonomy: AdditiveTaxonomy;
  /** Mapa tag -> clases, para inferir NOVA */
  additiveClasses: Map<string, string[]>;
}

export function buildAdditiveClassMap(taxonomy: AdditiveTaxonomy): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [tag, entry] of Object.entries(taxonomy)) {
    if (entry.classes?.length) map.set(tag, entry.classes);
  }
  return map;
}

/**
 * Evalua cuanto podemos confiar en el resultado.
 *
 * Se pondera por importancia: faltar la energia invalida casi todo, faltar la
 * fibra solo quita matiz. Es lo que permite mostrar una barra de incertidumbre
 * en vez de un numero con falsa autoridad.
 */
function assessConfidence(product: Product, hasNova: boolean): Confidence {
  const n = product.nutriments;
  const required: Array<[key: string, label: string, present: boolean, weight: number]> = [
    ['energy', 'valor energetico', n.energyKj !== undefined || n.energyKcal !== undefined, 3],
    ['sugars', 'azucares', n.sugars !== undefined, 2],
    ['saturatedFat', 'grasas saturadas', n.saturatedFat !== undefined, 2],
    ['salt', 'sal', n.salt !== undefined || n.sodium !== undefined, 2],
    ['proteins', 'proteinas', n.proteins !== undefined, 1],
    ['fiber', 'fibra', n.fiber !== undefined, 1],
    ['fat', 'grasas totales', n.fat !== undefined, 1],
    ['ingredients', 'lista de ingredientes', Boolean(product.ingredientsText), 2],
    ['nova', 'grado de procesamiento', hasNova, 2],
  ];

  const totalWeight = required.reduce((s, [, , , w]) => s + w, 0);
  const presentWeight = required.reduce((s, [, , p, w]) => s + (p ? w : 0), 0);
  const ratio = presentWeight / totalWeight;
  const missing = required.filter(([, , p]) => !p).map(([, label]) => label);

  const notes: string[] = [];
  if (n.fruitsVegetablesLegumes === undefined) {
    notes.push(
      'No consta el porcentaje de frutas, verduras y legumbres: su posible aporte positivo no se ha contado.',
    );
  }
  if (n.fiber === undefined) {
    notes.push('No consta la fibra: su posible aporte positivo no se ha contado.');
  }
  if (!hasNova) {
    notes.push('No se ha podido determinar el grado de procesamiento (NOVA).');
  }

  let level: Confidence['level'];
  if (ratio >= 0.85) level = 'high';
  else if (ratio >= 0.6) level = 'medium';
  else if (ratio >= 0.35) level = 'low';
  else level = 'insufficient';

  return { level, ratio: Math.round(ratio * 100) / 100, missing, notes };
}

function bandFor(value: number): HealthScore['band'] {
  if (value >= 75) return 'excellent';
  if (value >= 50) return 'good';
  if (value >= 25) return 'mediocre';
  if (value >= 10) return 'poor';
  return 'bad';
}

export function scoreProduct(product: Product, ctx: ScoringContext): HealthScore {
  const breakdown: ScoreBreakdownItem[] = [];

  // --- 1. Calidad nutricional (Nutri-Score 2023) ---
  const nsInput = offProductToNutriscoreInput({
    code: product.barcode,
    nutriments: nutrimentsToOffShape(product),
    additives_tags: product.additiveTags,
    categories_tags: product.categoryTags,
    nutriscore_data: {
      is_beverage: product.categoryFlags.isBeverage ? 1 : 0,
      is_water: product.categoryFlags.isWater ? 1 : 0,
      is_cheese: product.categoryFlags.isCheese ? 1 : 0,
      is_fat_oil_nuts_seeds: product.categoryFlags.isFatOilNutsSeeds ? 1 : 0,
      is_red_meat_product: product.categoryFlags.isRedMeat ? 1 : 0,
    },
  });
  const nutriscore = computeNutriscore2023(nsInput);
  const nutritionHundred = nutriscoreToHundred(nutriscore, product.categoryFlags);

  breakdown.push({
    id: 'nutrition',
    label: 'Calidad nutricional',
    contribution: nutritionHundred * WEIGHTS.nutrition,
    weight: WEIGHTS.nutrition,
    detail: `Nutri-Score ${nutriscore.grade.toUpperCase()} (${nutriscore.score} puntos: ${nutriscore.negativePoints} negativos menos ${nutriscore.positivePoints} positivos)`,
  });

  // --- 2. Grado de procesamiento (NOVA) ---
  const nova = inferNova(product, ctx.additiveClasses);
  // Sin dato NOVA se usa un valor neutro para no premiar ni castigar la ausencia.
  const NEUTRAL_PROCESSING = 55;
  const processingHundred = nova ? novaToHundred(nova.group) : NEUTRAL_PROCESSING;

  breakdown.push({
    id: 'processing',
    label: 'Grado de procesamiento',
    contribution: processingHundred * WEIGHTS.processing,
    weight: WEIGHTS.processing,
    detail: nova
      ? `NOVA ${nova.group}: ${NOVA_LABELS[nova.group]}${nova.fromSource ? '' : ' (inferido)'}`
      : 'Desconocido: se aplica un valor neutro',
  });

  // --- 3. Aditivos (riesgo de sobreexposicion EFSA) ---
  const additives = assessAdditives(product.additiveTags, ctx.additiveTaxonomy);
  breakdown.push({
    id: 'additives',
    label: 'Aditivos',
    contribution: additives.score * WEIGHTS.additives,
    weight: WEIGHTS.additives,
    detail:
      product.additiveTags.length === 0
        ? 'Sin aditivos declarados'
        : `${product.additiveTags.length} aditivo(s); ${additives.highRiskCount} con riesgo alto de sobreexposicion`,
  });

  // --- 4. Advertencias regulatorias (modelo OPS) ---
  const hasSweeteners = additives.assessments.some((a) => a.isSweetener);
  const paho = evaluatePaho({
    nutriments: product.nutriments,
    novaGroup: nova?.group,
    hasSweeteners,
  });
  const pahoPenalty = Math.min(paho.exceededCount * PAHO_SEAL_PENALTY, PAHO_MAX_PENALTY);
  const regulatoryHundred = 100 - (pahoPenalty / PAHO_MAX_PENALTY) * 100;

  breakdown.push({
    id: 'regulatory',
    label: 'Advertencias OPS/OMS',
    contribution: regulatoryHundred * WEIGHTS.regulatory,
    weight: WEIGHTS.regulatory,
    detail: paho.applicable
      ? paho.exceededCount === 0
        ? 'Sin sellos de advertencia'
        : `${paho.exceededCount} sello(s) de exceso`
      : 'No aplica: el modelo OPS cubre productos procesados y ultraprocesados',
  });

  // --- Total ---
  const weighted =
    nutritionHundred * WEIGHTS.nutrition +
    processingHundred * WEIGHTS.processing +
    additives.score * WEIGHTS.additives +
    regulatoryHundred * WEIGHTS.regulatory;

  // Los sellos OPS actuan ademas como modulador directo: un producto con varios
  // excesos no deberia poder quedar en la banda alta por mucho que compense.
  const value = Math.max(0, Math.min(100, Math.round(weighted - pahoPenalty * 0.5)));

  return {
    value,
    band: bandFor(value),
    breakdown,
    confidence: assessConfidence(product, nova !== undefined),
    nutriscore,
    nova: nova ? { group: nova.group, label: NOVA_LABELS[nova.group] } : undefined,
    additives: additives.assessments,
    paho,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

/**
 * Convierte nuestros nutrientes al vocabulario crudo de OFF, para poder
 * reutilizar `offProductToNutriscoreInput` y tener un unico camino de calculo.
 */
function nutrimentsToOffShape(product: Product): Record<string, number | undefined> {
  const n = product.nutriments;
  return {
    'energy-kj_100g': n.energyKj,
    'energy-kcal_100g': n.energyKcal,
    fat_100g: n.fat,
    'saturated-fat_100g': n.saturatedFat,
    'trans-fat_100g': n.transFat,
    carbohydrates_100g: n.carbohydrates,
    sugars_100g: n.sugars,
    fiber_100g: n.fiber,
    proteins_100g: n.proteins,
    salt_100g: n.salt,
    sodium_100g: n.sodium !== undefined ? n.sodium / 1000 : undefined,
    'fruits-vegetables-legumes-estimate-from-ingredients_100g': n.fruitsVegetablesLegumes,
  };
}

export const BAND_LABELS: Record<HealthScore['band'], string> = {
  excellent: 'Excelente',
  good: 'Bueno',
  mediocre: 'Mediocre',
  poor: 'Malo',
  bad: 'Muy malo',
};

/**
 * Colores de banda.
 *
 * Se usan como FONDO con texto blanco encima, asi que todos cumplen el minimo
 * AA de 4.5:1 contra blanco. Los tonos vivos habituales no servian: el ambar
 * #ffc107 con texto blanco da 1.97:1, practicamente ilegible.
 */
export const BAND_COLORS: Record<HealthScore['band'], string> = {
  excellent: '#0d864b',
  good: '#59802f',
  mediocre: '#a46705',
  poor: '#d73b0b',
  bad: '#d93025',
};
