/**
 * Evaluacion de aditivos a partir de la taxonomia de Open Food Facts.
 *
 * Punto clave de metodologia, y la diferencia central frente a Yuka: NO se
 * puntua el peligro intrinseco del aditivo, sino el **riesgo de sobreexposicion
 * evaluado por la EFSA**. La distincion no es semantica: una sustancia puede ser
 * peligrosa en laboratorio a dosis altas y resultar irrelevante en la
 * concentracion a la que se usa en un alimento. EFSA publica, para cada
 * aditivo, si la exposicion real de la poblacion supera la Ingesta Diaria
 * Admisible, y en que grupos de edad. Eso SI es riesgo.
 *
 * Campos de origen (verificados en `static.openfoodfacts.org/data/taxonomies/
 * additives.json`, 683 aditivos, el 2026-09-16):
 *   efsa_evaluation_overexposure_risk               -> en:no | en:moderate | en:high
 *   efsa_evaluation_exposure_mean_greater_than_adi  -> grupos con consumo medio > IDA
 *   efsa_evaluation_exposure_95th_greater_than_adi  -> grupos en percentil 95 > IDA
 *   anses_additives_of_interest                     -> vigilancia reforzada de ANSES
 */

import type { AdditiveAssessment, AdditiveRisk } from '../types.js';

/** Entrada compacta de la taxonomia, generada por `scripts/build-taxonomies.mjs`. */
export interface AdditiveTaxonomyEntry {
  /** p.ej. "250" */
  e?: string;
  /** nombre en espanol, con respaldo en ingles */
  name: string;
  /** clases: en:preservative, en:colour, ... */
  classes?: string[];
  /** riesgo de sobreexposicion segun EFSA */
  risk?: 'no' | 'moderate' | 'high';
  /** grupos poblacionales que superan la IDA en consumo medio */
  meanOver?: string[];
  /** grupos poblacionales que superan la IDA en percentil 95 */
  p95Over?: string[];
  anses?: boolean;
  sweetener?: boolean;
  nonNutritiveSweetener?: boolean;
  url?: string;
  date?: string;
  desc?: string;
}

export type AdditiveTaxonomy = Record<string, AdditiveTaxonomyEntry>;

/**
 * Penalizacion en puntos sobre 100 por aditivo, segun riesgo.
 *
 * Se penaliza de forma gradual y explicada. No se replica el tope duro de
 * Yuka (un aditivo de riesgo alto congela el producto en 49/100), porque es
 * opaco y produce saltos que el usuario no puede entender.
 */
const BASE_PENALTY: Record<AdditiveRisk, number> = {
  high: 22,
  moderate: 9,
  low: 3,
  none: 0,
  unknown: 1.5,
};

/** Recargo si ANSES lo marca como aditivo de interes (vigilancia reforzada). */
const ANSES_SURCHARGE = 4;

/** Recargo por grupo poblacional vulnerable que ya supera la IDA de media. */
const VULNERABLE_GROUPS = new Set(['en:infants', 'en:toddlers', 'en:children']);
const VULNERABLE_SURCHARGE = 5;

/**
 * Los aditivos que se acumulan pesan cada vez menos.
 *
 * Razon: cinco conservantes de riesgo bajo no son cinco veces peor que uno.
 * Sin este amortiguamiento, cualquier producto con lista larga caeria a cero y
 * el score dejaria de discriminar.
 */
const DIMINISHING_FACTOR = 0.72;

function parseRisk(risk: AdditiveTaxonomyEntry['risk']): AdditiveRisk {
  switch (risk) {
    case 'high':
      return 'high';
    case 'moderate':
      return 'moderate';
    case 'no':
      return 'none';
    default:
      return 'unknown';
  }
}

export function assessAdditive(
  tag: string,
  taxonomy: AdditiveTaxonomy,
): AdditiveAssessment {
  const entry = taxonomy[tag.toLowerCase()];
  const eNumber = entry?.e;
  const risk = parseRisk(entry?.risk);
  const meanOver = entry?.meanOver ?? [];
  const p95Over = entry?.p95Over ?? [];
  const anses = entry?.anses ?? false;

  let penalty = BASE_PENALTY[risk];
  if (anses) penalty += ANSES_SURCHARGE;
  if (meanOver.some((g) => VULNERABLE_GROUPS.has(g))) penalty += VULNERABLE_SURCHARGE;

  return {
    tag,
    eNumber,
    name: entry?.name ?? (eNumber ? `E${eNumber}` : tag.replace(/^en:/, '').toUpperCase()),
    classes: entry?.classes ?? [],
    risk,
    overexposedGroupsMean: meanOver,
    overexposedGroupsP95: p95Over,
    ansesOfInterest: anses,
    isSweetener: entry?.sweetener ?? false,
    isNonNutritiveSweetener: entry?.nonNutritiveSweetener ?? false,
    efsaEvaluationUrl: entry?.url,
    efsaEvaluationDate: entry?.date,
    description: entry?.desc,
    penalty: Math.round(penalty * 10) / 10,
  };
}

export interface AdditivesResult {
  assessments: AdditiveAssessment[];
  /** Penalizacion total ya amortiguada, en puntos de 0-100 */
  totalPenalty: number;
  /** Puntuacion del bloque de aditivos, 0-100 */
  score: number;
  highRiskCount: number;
}

export function assessAdditives(
  tags: string[],
  taxonomy: AdditiveTaxonomy,
): AdditivesResult {
  const assessments = tags
    .map((t) => assessAdditive(t, taxonomy))
    .sort((a, b) => b.penalty - a.penalty);

  // Se aplica el amortiguamiento de mayor a menor: el aditivo mas problematico
  // pesa entero y cada siguiente pesa menos.
  let totalPenalty = 0;
  assessments.forEach((a, index) => {
    totalPenalty += a.penalty * Math.pow(DIMINISHING_FACTOR, index);
  });

  return {
    assessments,
    totalPenalty: Math.round(totalPenalty * 10) / 10,
    score: Math.max(0, Math.min(100, 100 - totalPenalty)),
    highRiskCount: assessments.filter((a) => a.risk === 'high').length,
  };
}

export const POPULATION_GROUP_LABELS: Record<string, string> = {
  'en:infants': 'lactantes',
  'en:toddlers': 'ninos pequenos',
  'en:children': 'ninos',
  'en:adolescents': 'adolescentes',
  'en:adults': 'adultos',
  'en:elderly': 'personas mayores',
  'en:the-elderly': 'personas mayores',
  'en:pregnant-women': 'embarazadas',
};

export const ADDITIVE_CLASS_LABELS: Record<string, string> = {
  'en:colour': 'colorante',
  'en:preservative': 'conservante',
  'en:antioxidant': 'antioxidante',
  'en:emulsifier': 'emulgente',
  'en:stabiliser': 'estabilizante',
  'en:thickener': 'espesante',
  'en:sweetener': 'edulcorante',
  'en:flavour-enhancer': 'potenciador del sabor',
  'en:acidity-regulator': 'regulador de acidez',
  'en:anti-caking-agent': 'antiaglomerante',
  'en:raising-agent': 'gasificante',
  'en:humectant': 'humectante',
  'en:gelling-agent': 'gelificante',
  'en:glazing-agent': 'agente de recubrimiento',
  'en:firming-agent': 'endurecedor',
  'en:bulking-agent': 'agente de carga',
  'en:foaming-agent': 'espumante',
  'en:acid': 'acidulante',
};

export function describeRisk(risk: AdditiveRisk): string {
  switch (risk) {
    case 'high':
      return 'Riesgo alto de sobreexposicion segun EFSA';
    case 'moderate':
      return 'Riesgo moderado de sobreexposicion segun EFSA';
    case 'low':
      return 'Riesgo bajo';
    case 'none':
      return 'Sin riesgo de sobreexposicion identificado por EFSA';
    default:
      return 'Sin evaluacion de sobreexposicion disponible';
  }
}
