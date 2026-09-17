/**
 * NOVA: clasificacion por grado de procesamiento (Monteiro et al.).
 *
 * Aporta una dimension ortogonal al Nutri-Score: un refresco light puede tener
 * un perfil de nutrientes aceptable y ser NOVA 4. Por eso se puntuan aparte y
 * nunca se funden en una sola cifra sin dejar rastro.
 */

import type { Product } from '../types.js';

export const NOVA_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: 'Sin procesar o minimamente procesado',
  2: 'Ingrediente culinario procesado',
  3: 'Procesado',
  4: 'Ultraprocesado',
};

export const NOVA_DESCRIPTIONS: Record<1 | 2 | 3 | 4, string> = {
  1: 'Partes comestibles de plantas o animales, o alimentos alterados por procesos que no anaden sal, azucar, aceites ni otros ingredientes.',
  2: 'Sustancias extraidas de alimentos del grupo 1 y usadas para cocinar: aceites, mantequilla, azucar, sal.',
  3: 'Alimentos del grupo 1 a los que se anade sal, azucar o aceite, normalmente para conservarlos o hacerlos mas apetecibles.',
  4: 'Formulaciones industriales hechas mayoritariamente con sustancias extraidas de alimentos, con aditivos de uso exclusivamente industrial. Su consumo elevado se asocia a obesidad, diabetes, enfermedad cardiovascular y peores resultados en salud mental.',
};

/** NOVA en escala 0-100. La caida de 3 a 4 es la mas pronunciada a proposito. */
export function novaToHundred(group: 1 | 2 | 3 | 4): number {
  return { 1: 100, 2: 80, 3: 55, 4: 25 }[group];
}

/**
 * Marcadores de ultraprocesamiento: clases de aditivo que practicamente solo
 * aparecen en formulaciones industriales. Sirven para inferir NOVA 4 cuando OFF
 * no lo ha determinado.
 */
const ULTRA_PROCESSING_MARKER_CLASSES = new Set([
  'en:colour',
  'en:flavour-enhancer',
  'en:sweetener',
  'en:emulsifier',
  'en:thickener',
  'en:humectant',
  'en:anti-caking-agent',
  'en:firming-agent',
  'en:bulking-agent',
  'en:foaming-agent',
  'en:glazing-agent',
  'en:gelling-agent',
  'en:stabiliser',
]);

/** Ingredientes cuyo nombre delata procesamiento industrial. */
const ULTRA_PROCESSING_INGREDIENT_PATTERNS = [
  /jarabe de (glucosa|fructosa|maiz)/i,
  /high.fructose/i,
  /aceite (vegetal )?(parcialmente )?hidrogenado/i,
  /proteina (de suero |de soja )?(aislada|hidrolizada|texturizada)/i,
  /maltodextrina/i,
  /aroma(s)? (artificial|natural)/i,
  /dextrosa/i,
  /almidon modificado/i,
  /suero en polvo/i,
];

export interface NovaInference {
  group: 1 | 2 | 3 | 4;
  /** true si el grupo lo determino OFF; false si lo inferimos nosotros */
  fromSource: boolean;
  reasons: string[];
}

/**
 * Devuelve el grupo NOVA, inferiendolo si hace falta.
 *
 * La inferencia es explicitamente conservadora: solo eleva a 4 cuando hay
 * marcadores claros, y nunca afirma NOVA 1 sin datos, porque un falso NOVA 1
 * seria mucho mas enganoso que un "desconocido".
 */
export function inferNova(
  product: Product,
  additiveClasses: Map<string, string[]>,
): NovaInference | undefined {
  if (product.novaGroup) {
    return { group: product.novaGroup, fromSource: true, reasons: [] };
  }

  const reasons: string[] = [];

  for (const tag of product.additiveTags) {
    const classes = additiveClasses.get(tag) ?? [];
    const marker = classes.find((c) => ULTRA_PROCESSING_MARKER_CLASSES.has(c));
    if (marker) {
      reasons.push(`Contiene ${tag.replace('en:', '').toUpperCase()}, aditivo de uso industrial`);
      break;
    }
  }

  const text = product.ingredientsText ?? '';
  for (const pattern of ULTRA_PROCESSING_INGREDIENT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      reasons.push(`Contiene "${match[0]}", marcador de ultraprocesamiento`);
      break;
    }
  }

  if (reasons.length > 0) return { group: 4, fromSource: false, reasons };

  // Sin marcadores y sin dato de origen no se inventa un grupo.
  return undefined;
}
