/**
 * Evaluacion de cosmetica: banderas regulatorias, NO puntuacion 0-100.
 *
 * Decision metodologica deliberada. Las apps del sector (EWG Skin Deep, Think
 * Dirty) puntuan el PELIGRO intrinseco del ingrediente ignorando concentracion,
 * via de exposicion y si el producto se enjuaga o se deja. Un ingrediente
 * problematico al 10% en laboratorio puede ser irrelevante al 0.1% en una
 * crema. Emitir un numero con esa base seria dar una precision que no se tiene.
 *
 * En su lugar se informa de lo que si es verificable:
 *   - situacion regulatoria: Anexos del Reglamento (CE) 1223/2009
 *       II  prohibidos       III restringidos
 *       IV  colorantes       V   conservantes      VI filtros UV
 *   - los 26 alergenos de fragancia de declaracion obligatoria en la UE
 *   - transparencia: si la lista INCI esta completa o no
 */

import type { CosmeticAssessment, CosmeticFlag, Confidence, Product } from '../types.js';

/**
 * Los 26 alergenos de fragancia cuya declaracion exige el Anexo III del
 * Reglamento (CE) 1223/2009 cuando superan 0,001% en productos sin aclarado o
 * 0,01% en productos con aclarado.
 */
export const EU_FRAGRANCE_ALLERGENS: Array<{ inci: string; common: string }> = [
  { inci: 'amyl cinnamal', common: 'amilcinamal' },
  { inci: 'amylcinnamyl alcohol', common: 'alcohol amilcinamilico' },
  { inci: 'anisyl alcohol', common: 'alcohol anisilico' },
  { inci: 'benzyl alcohol', common: 'alcohol bencilico' },
  { inci: 'benzyl benzoate', common: 'benzoato de bencilo' },
  { inci: 'benzyl cinnamate', common: 'cinamato de bencilo' },
  { inci: 'benzyl salicylate', common: 'salicilato de bencilo' },
  { inci: 'cinnamal', common: 'cinamal' },
  { inci: 'cinnamyl alcohol', common: 'alcohol cinamilico' },
  { inci: 'citral', common: 'citral' },
  { inci: 'citronellol', common: 'citronelol' },
  { inci: 'coumarin', common: 'cumarina' },
  { inci: 'eugenol', common: 'eugenol' },
  { inci: 'farnesol', common: 'farnesol' },
  { inci: 'geraniol', common: 'geraniol' },
  { inci: 'hexyl cinnamal', common: 'hexilcinamal' },
  { inci: 'hydroxycitronellal', common: 'hidroxicitronelal' },
  { inci: 'isoeugenol', common: 'isoeugenol' },
  { inci: 'limonene', common: 'limoneno' },
  { inci: 'linalool', common: 'linalol' },
  { inci: 'methyl 2-octynoate', common: '2-octinoato de metilo' },
  { inci: 'alpha-isomethyl ionone', common: 'alfa-isometil ionona' },
  { inci: 'evernia prunastri', common: 'extracto de musgo de encina' },
  { inci: 'evernia furfuracea', common: 'extracto de musgo de arbol' },
  { inci: 'butylphenyl methylpropional', common: 'lilial' },
  { inci: 'hydroxyisohexyl 3-cyclohexene carboxaldehyde', common: 'lyral' },
];

/**
 * Subconjunto de sustancias con restriccion o prohibicion relevante, extraido
 * de los Anexos del Reglamento (CE) 1223/2009 (CosIng).
 *
 * Es un subconjunto curado a proposito, no la lista completa de ~2400 entradas:
 * se centra en lo que aparece de verdad en productos de consumo. El pipeline
 * `scripts/build-cosing.mjs` puede ampliarlo desde la fuente oficial.
 */
export interface CosingEntry {
  inci: string;
  annex: 'II' | 'III' | 'IV' | 'V' | 'VI';
  note: string;
  reference?: string;
}

export const COSING_SUBSET: CosingEntry[] = [
  {
    inci: 'butylphenyl methylpropional',
    annex: 'II',
    note: 'Prohibido en cosmeticos en la UE desde marzo de 2022 por clasificacion CMR 1B (toxico para la reproduccion).',
  },
  {
    inci: 'methylisothiazolinone',
    annex: 'III',
    note: 'Conservante restringido: prohibido en productos sin aclarado desde 2017 por sensibilizacion cutanea.',
  },
  {
    inci: 'methylchloroisothiazolinone',
    annex: 'V',
    note: 'Restringido a productos con aclarado, maximo 0,0015% en mezcla 3:1 con metilisotiazolinona.',
  },
  {
    inci: 'triclosan',
    annex: 'V',
    note: 'Conservante restringido: maximo 0,3% y solo en tipos de producto concretos.',
  },
  {
    inci: 'formaldehyde',
    annex: 'II',
    note: 'Prohibido como tal en cosmeticos. Vigilar los liberadores de formaldehido.',
  },
  {
    inci: 'dmdm hydantoin',
    annex: 'V',
    note: 'Conservante liberador de formaldehido; exige advertencia en la etiqueta por encima de 0,05%.',
  },
  {
    inci: 'imidazolidinyl urea',
    annex: 'V',
    note: 'Conservante liberador de formaldehido, maximo 0,6%.',
  },
  {
    inci: 'diazolidinyl urea',
    annex: 'V',
    note: 'Conservante liberador de formaldehido, maximo 0,5%.',
  },
  {
    inci: 'butylparaben',
    annex: 'V',
    note: 'Restringido: maximo 0,14% como ester individual; prohibido en productos sin aclarado para la zona del panal en menores de 3 anos.',
  },
  {
    inci: 'propylparaben',
    annex: 'V',
    note: 'Restringido: maximo 0,14% como ester individual.',
  },
  {
    inci: 'benzophenone-3',
    annex: 'VI',
    note: 'Filtro UV restringido; limites revisados por el SCCS por posible actividad endocrina.',
  },
  {
    inci: 'homosalate',
    annex: 'VI',
    note: 'Filtro UV restringido a 7,34% en productos faciales tras la revision del SCCS.',
  },
  {
    inci: 'octocrylene',
    annex: 'VI',
    note: 'Filtro UV restringido; concentraciones maximas revisadas en 2021.',
  },
  {
    inci: 'talc',
    annex: 'III',
    note: 'Restringido: prohibido en polvos para menores de 3 anos.',
  },
  {
    inci: 'aluminium chlorohydrate',
    annex: 'III',
    note: 'Antitranspirante restringido; el SCCS fijo limites por tipo de producto en 2020.',
  },
];

function normalizeIngredient(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[*+()[\]{}.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trocea una lista INCI. Separa por coma y tolera el uso de punto y coma. */
export function parseInciList(text: string): string[] {
  return text
    .replace(/^ingredients?\s*:/i, '')
    .split(/[,;]/)
    .map((s) => normalizeIngredient(s))
    .filter((s) => s.length > 1);
}

export function assessCosmetic(product: Product): CosmeticAssessment {
  const text = product.ingredientsText ?? '';
  const ingredients = text ? parseInciList(text) : [];
  const flags: CosmeticFlag[] = [];

  const cosingIndex = new Map(COSING_SUBSET.map((e) => [e.inci, e]));
  const allergenIndex = new Map(EU_FRAGRANCE_ALLERGENS.map((a) => [a.inci, a]));

  let recognized = 0;

  for (const ingredient of ingredients) {
    const cosing = cosingIndex.get(ingredient);
    if (cosing) {
      recognized++;
      flags.push({
        id: `cosing-${cosing.inci}`,
        severity: cosing.annex === 'II' ? 'prohibited' : 'restricted',
        ingredient,
        message:
          cosing.annex === 'II'
            ? `Sustancia del Anexo II (prohibida en cosmeticos en la UE). ${cosing.note}`
            : `Sustancia del Anexo ${cosing.annex} (uso restringido). ${cosing.note}`,
        reference: 'Reglamento (CE) 1223/2009',
      });
      continue;
    }

    const allergen = allergenIndex.get(ingredient);
    if (allergen) {
      recognized++;
      flags.push({
        id: `allergen-${allergen.inci}`,
        severity: 'allergen',
        ingredient,
        message: `Alergeno de fragancia de declaracion obligatoria en la UE (${allergen.common}). Relevante solo si tienes sensibilidad conocida.`,
        reference: 'Anexo III del Reglamento (CE) 1223/2009',
      });
    }
  }

  const hasFullInciList = ingredients.length >= 3;
  if (!hasFullInciList) {
    flags.push({
      id: 'no-inci',
      severity: 'info',
      ingredient: '',
      message:
        'No consta la lista INCI completa de este producto. Sin ella no se puede valorar la formula; puedes anadirla con una foto del envase.',
    });
  }

  const confidence: Confidence = {
    level: hasFullInciList ? 'medium' : 'insufficient',
    ratio: hasFullInciList ? 0.6 : 0.1,
    missing: hasFullInciList ? [] : ['lista de ingredientes INCI'],
    notes: [
      'La cosmetica se evalua por situacion regulatoria y alergenos declarados, no con una puntuacion de salud. Las puntuaciones de "peligro" habituales en el sector ignoran la concentracion y la via de exposicion.',
    ],
  };

  // Orden: primero lo prohibido, luego lo restringido, luego alergenos.
  const severityRank = { prohibited: 0, restricted: 1, allergen: 2, info: 3 } as const;
  flags.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    flags,
    recognizedIngredients: recognized,
    totalIngredients: ingredients.length,
    hasFullInciList,
    confidence,
  };
}
