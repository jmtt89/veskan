/**
 * NOVA: clasificacion por grado de procesamiento (Monteiro et al.).
 *
 * Aporta una dimension ortogonal al Nutri-Score: un refresco light puede tener
 * un perfil de nutrientes aceptable y ser NOVA 4. Por eso se puntuan aparte y
 * nunca se funden en una sola cifra sin dejar rastro.
 */

import type { NovaMarker, Product } from '../types.js';

export type { NovaMarker };

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

/**
 * Quita las tildes SIN cambiar la longitud del texto.
 *
 * Importa que sea uno a uno: los patrones se buscan sobre el texto sin tildes,
 * pero lo que se le enseña al usuario se recorta del ORIGINAL usando la misma
 * posicion. Con `normalize('NFD')` la cadena cambia de largo y las posiciones
 * dejarian de corresponder.
 */
const SIN_TILDE: Record<string, string> = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n',
  Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U', Ü: 'U', Ñ: 'N',
};
const deacentuar = (t: string): string => t.replace(/[áéíóúüñÁÉÍÓÚÜÑ]/g, (c) => SIN_TILDE[c]!);

/**
 * Ingredientes cuyo nombre delata procesamiento industrial.
 *
 * Se escriben SIN tildes porque se buscan sobre el texto ya normalizado: en las
 * etiquetas reales conviven «PROTEÍNA» y «proteina», y un patron acentuado
 * fallaba con el otro. Comprobado sobre un producto real: «PROTEÍNA VEGETAL»,
 * «JARABE DE MAÍZ» y «SABORIZANTE NATURAL» no casaban con ninguno.
 *
 * Incluyen el vocabulario de Latinoamerica, no solo el de Espana: alli la
 * etiqueta dice «saborizante» donde aqui dice «aroma», y «grasa vegetal» donde
 * aqui «aceite vegetal». Sin eso, media la region se quedaba sin marcadores.
 */
const ULTRA_PROCESSING_INGREDIENT_PATTERNS = [
  /jarabe de (glucosa|fructosa|maiz)/i,
  /high.fructose/i,
  /(aceite|grasa)(s)? (vegetal(es)? )?(parcialmente )?hidrogenad[oa]/i,
  /proteina(s)? [\w\s]{0,18}(aislada|hidrolizada|texturizada)/i,
  /maltodextrina/i,
  /(aroma|saborizante)(s)? (artificial|natural|identico)/i,
  /colorante(s)? artificial(es)?/i,
  /(realzador|resaltador|potenciador) de(l)? sabor/i,
  /extracto de levadura/i,
  /caseinato/i,
  /dextrosa/i,
  /almidon(es)? modificad[oa]/i,
  /suero en polvo/i,

  /*
   * Y en ingles.
   *
   * No es un extra para Estados Unidos: es el caso central de esta aplicacion.
   * Medido sobre los catalogos publicados, el 19,3% del catalogo mexicano y el
   * 13,8% del venezolano llevan prefijo GS1 estadounidense, y esos productos
   * traen la etiqueta en ingles. Con los patrones solo en espanol, de los
   * 67.550 productos estadounidenses que tienen ingredientes pero no NOVA
   * reconociamos 110; con estos, 1.523.
   *
   * Que el salto sea modesto no es culpa de la lista: el 97,6% restante trae
   * el texto de ingredientes mal leido por OCR -- «WEAT FROAR (ENICHED N FN
   * BARLEY MALT» --, que es exactamente por lo que Open Food Facts tampoco
   * pudo clasificarlos. Ninguna lista de patrones arregla eso.
   */
  /(glucose|fructose|corn) syrup/i,
  /maltodextrin\b/i,
  /modified (corn |food |potato |tapioca )?starch/i,
  /(partially )?hydrogenated (vegetable )?(oil|fat)/i,
  /(soy|whey|milk|pea) protein (isolate|concentrate|hydrolysate)/i,
  /(natural|artificial) flavor(s|ing)?/i,
  /artificial color(s|ing)?/i,
  /flavou?r enhancer/i,
  /yeast extract/i,
  /caseinate/i,
  /\bdextrose\b/i,
  /invert sugar/i,
  /soy lecithin/i,
  /mono.{0,3}and diglycerides/i,
];

export interface NovaInference {
  group: 1 | 2 | 3 | 4;
  /** true si el grupo lo determino OFF; false si lo inferimos nosotros */
  fromSource: boolean;
  reasons: string[];
  /**
   * Marcadores hallados, SIEMPRE, tambien cuando el grupo viene de Open Food
   * Facts. Son la unica explicacion concreta que podemos dar de por que este
   * producto concreto esta donde esta: la definicion del grupo es la misma para
   * todos y no dice nada de lo que tienes en la mano.
   */
  markers: NovaMarker[];
}

/** Busca todas las senales de ultraprocesamiento, sin decidir nada. */
function findMarkers(product: Product, additiveClasses: Map<string, string[]>): NovaMarker[] {
  const markers: NovaMarker[] = [];

  for (const tag of product.additiveTags) {
    const classes = additiveClasses.get(tag) ?? [];
    const additiveClass = classes.find((c) => ULTRA_PROCESSING_MARKER_CLASSES.has(c));
    if (additiveClass) markers.push({ kind: 'additive', value: tag, additiveClass });
  }

  const original = product.ingredientsText ?? '';
  const normalizado = deacentuar(original);
  for (const pattern of ULTRA_PROCESSING_INGREDIENT_PATTERNS) {
    const match = pattern.exec(normalizado);
    // Se cita el texto tal y como lo escribio el fabricante, no el normalizado:
    // ver «PROTEINA» cuando la etiqueta dice «PROTEÍNA» parece un error nuestro.
    if (match) markers.push({ kind: 'ingredient', value: original.slice(match.index, match.index + match[0].length) });
  }

  return markers;
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
  // Se buscan SIEMPRE, aunque el grupo ya venga dado: sirven para explicar, no
  // solo para decidir.
  const markers = findMarkers(product, additiveClasses);

  if (product.novaGroup) {
    return { group: product.novaGroup, fromSource: true, reasons: [], markers };
  }

  const reasons = markers.map((m) =>
    m.kind === 'additive'
      ? `Contiene ${m.value.replace('en:', '').toUpperCase()}, aditivo de uso industrial`
      : `Contiene "${m.value}", marcador de ultraprocesamiento`,
  );

  if (reasons.length > 0) return { group: 4, fromSource: false, reasons, markers };

  // Sin marcadores y sin dato de origen no se inventa un grupo.
  return undefined;
}
