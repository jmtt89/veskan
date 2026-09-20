/**
 * Evaluacion de aditivos: peligro y exposicion, que son dos cosas distintas.
 *
 *     riesgo = peligro x exposicion
 *
 * La primera version de este modulo solo miraba la segunda mitad: el **riesgo
 * de sobreexposicion** que publica EFSA, que responde «¿la gente supera la
 * IDA?». Es una buena pregunta y sigue aqui. Pero de los 683 aditivos de la
 * taxonomia, **618 no tienen esa evaluacion**, y con ellos el 79% de las
 * apariciones del catalogo caia en un unico cubo plano de 1,5 puntos donde el
 * dioxido de titanio -prohibido en la Union Europea- valia lo mismo que el
 * acido citrico.
 *
 * Peor: el amaranto (E123) puntuaba **CERO**, porque EFSA evaluo su exposicion
 * y no encontro riesgo... mientras Estados Unidos lo tiene prohibido desde
 * 1976.
 *
 * QUE SE AÑADE, de `tools/aditivos/`:
 *
 *   prohibido    prohibicion explicita en alguna jurisdiccion, con su norma
 *   nivel        naturaleza del daño, 1 (genotoxico) a 8 (local o digestivo)
 *   certeza      cuanto se sabe de ese nivel
 *   sinDosis     POR QUE no hay IDA, que no siempre significa lo mismo
 *
 * EL PELIGRO FIJA EL PELDAÑO, LA EXPOSICION ES UN RECARGO ENCIMA. No son dos
 * candidatos entre los que elegir el mayor: son las dos mitades de
 * `riesgo = peligro x exposicion`. Se recorre la escalera, gana el primer
 * peldaño que encaje, y despues se suman los recargos.
 *
 * EL UNICO CERO ES NO LLEVAR ADITIVOS. El peldaño mas bajo -«sin datos»- vale
 * 3. La version anterior le daba cero a `risk: no`, y de ahi salia el absurdo
 * del amaranto.
 *
 * La escala, los peldaños y los recargos NO se deciden aqui: estan en
 * `tools/aditivos/ALGORITMO.md`, que es donde se razonaron y se midieron. Este
 * modulo solo los aplica.
 *
 * NO SE REPLICA el tope duro de Yuka -un aditivo de riesgo alto congela el
 * producto en 49/100-, porque es opaco y produce saltos que el usuario no
 * puede entender.
 */

import type {
  AdditiveAssessment, AdditiveBan, AdditivePenaltyReason, AdditiveRisk,
} from '../types.js';

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

  // --- base de peligro, fundida por `build-taxonomies.mjs` -----------------
  /** Prohibido explicitamente en alguna jurisdiccion */
  prohibido?: boolean;
  /** Normas que lo prohiben, con la frase literal */
  normas?: { j: string; ref?: string; verbo?: string; alcance?: string }[];
  /** 1 genotoxico o carcinogenico ... 8 local o digestivo */
  nivel?: number;
  nivelDesc?: string;
  certeza?: string;
  /** Donde cae dentro de su nivel: 0 el MAS potente, 1 el menos */
  posNivel?: number;
  ida?: number;
  /** IDA derivada con factor de incertidumbre <= 1 */
  sinMargen?: boolean;
  /** Por que no hay dosis: no-necesario, margen-de-seguridad, datos-incompletos... */
  sinDosis?: string;
  iarc?: string;
  clp?: string;
  legalUe?: string;
}

export type AdditiveTaxonomy = Record<string, AdditiveTaxonomyEntry>;

/**
 * LOS PELDAÑOS, en orden: gana el primero que encaje.
 *
 * Sale de `tools/aditivos/ALGORITMO.md`, donde se decidio y se midio. Sobre
 * 100 dentro del bloque de aditivos, que pesa el 20% de la nota.
 *
 *   1  no autorizado en alimentos          60
 *   2  CMR del Anexo VI, o IARC 1/2A/2B    nivel 1
 *   3  sin IDA por genotoxicidad           nivel 1
 *   4  efecto critico                      niveles 2-8
 *   5  sin datos                            3
 *
 * LA ESCALA ES DISCONTINUA A PROPOSITO. De las 753 sustancias evaluadas, 667
 * tienen efecto critico: el 89%. No es excepcional, es COMO SE DERIVA
 * cualquier IDA. «Efecto critico: developmental» no dice que el aditivo sea
 * peligroso, dice que efecto aparecio antes al subir la dosis. En cambio IARC
 * grupo 1 o CLP `Carc. 1B` SI son veredictos: alguien evaluo y concluyo que
 * puede causar cancer. Un degradado suave del 1 al 8 trataria las dos cosas
 * como si fueran la misma, y por eso el salto del nivel 1 al 2 es de 20 a 12.
 *
 * NINGUN PELDAÑO VALE 0. El 0 es no llevar aditivos.
 */
const BANNED_PENALTY = 60;

/** Nivel 1 segun cuanto se sabe. No es un multiplicador: son tres peldaños. */
const LEVEL_1_BY_CERTAINTY: Record<string, number> = {
  confirmada: 40,
  probable: 30,
  posible: 20,
};
const LEVEL_1_DEFAULT = 20;

/** Niveles 2 a 8, por naturaleza del daño. */
const LEVEL_PENALTY: Record<number, number> = {
  2: 12, // afecta al desarrollo o la reproduccion
  3: 10, // endocrino
  4: 8, // neurotoxico
  5: 7, // daño a organo diana
  6: 6, // inmunotoxico o hematopoyetico
  7: 5, // sistemico reversible
  8: 4, // local o digestivo
};

/** Sin ninguna evaluacion. No se presume culpable, pero tampoco inocente. */
const NO_DATA_PENALTY = 3;

/**
 * Dentro del nivel manda la potencia: entre dos teratogenos pesa mas el de
 * dosis menor.
 *
 *   E523 alumbre amonico   IDA 0,14   el mas potente del nivel 2
 *   E123 amaranto          IDA 0,15
 *   E100 curcumina         IDA 3      20 veces menos potente
 *
 * Tratar el colorante del curry igual que el alumbre seria un error de
 * categoria, asi que se modula.
 *
 * OJO CON EL SENTIDO: `posNivel` es **0 el mas potente del nivel y 1 el
 * menos** -es la posicion de su IDA ordenada de menor a mayor-, asi que va al
 * reves de lo que sugiere el nombre. Invertirlo penalizaba MAS a los menos
 * potentes: la curcumina salia 17,8 en vez de 9.
 */
const POSITION_MIN = 0.75;
const POSITION_MAX = 1.25;

/**
 * RECARGOS, que son el eje de exposicion y SE SUMAN al peldaño.
 *
 * `riesgo = peligro x exposicion`. El peligro fija el peldaño; la exposicion
 * dice si la gente llega de verdad a esa dosis. Son ortogonales, y hay tres
 * casos que lo demuestran:
 *
 *   E123 amaranto     teratogeno, IDA 0,15   casi no se usa  -> EFSA: sin riesgo
 *   E250 nitrito      reversible,  IDA 0,1   muy consumido   -> EFSA: alto
 *   E407 carragenato  leve,        IDA 75    esta en todo    -> EFSA: alto
 *
 * Amaranto y nitrito son igual de potentes y acaban en extremos opuestos.
 */
const OVEREXPOSURE_SURCHARGE: Record<AdditiveRisk, number> = {
  high: 10,
  moderate: 5,
  low: 0,
  none: 0,
  unknown: 0,
};

/** Recargo si ANSES lo marca como aditivo de interes (vigilancia reforzada). */
const ANSES_SURCHARGE = 4;

/** Recargo por grupo poblacional vulnerable que ya supera la IDA de media. */
const VULNERABLE_GROUPS = new Set(['en:infants', 'en:toddlers', 'en:children']);
const VULNERABLE_SURCHARGE = 5;

/**
 * IDA derivada sin margen de seguridad. Lo habitual es dividir el NOAEL por un
 * factor de incertidumbre de 100; un factor de 1 significa que la dosis segura
 * es la dosis a la que ya se vio algo.
 */
const NO_MARGIN_SURCHARGE = 3;

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
  const banned = entry?.prohibido ?? false;

  // PELDAÑOS EN ORDEN: gana el primero que encaje. No se combinan porque no
  // son ejes paralelos sino una jerarquia: estar prohibido ya dice mas que
  // cualquier nivel, y un veredicto de IARC dice mas que un efecto critico.
  const level = entry?.nivel;
  let base: number;
  let penaltyReason: AdditivePenaltyReason;

  if (banned) {
    base = BANNED_PENALTY;
    penaltyReason = 'banned';
  } else if (level === 1) {
    base = entry?.certeza
      ? (LEVEL_1_BY_CERTAINTY[entry.certeza] ?? LEVEL_1_DEFAULT)
      : LEVEL_1_DEFAULT;
    penaltyReason = 'hazard';
  } else if (level !== undefined && LEVEL_PENALTY[level] !== undefined) {
    base = LEVEL_PENALTY[level]!;
    penaltyReason = 'hazard';
  } else {
    base = NO_DATA_PENALTY;
    penaltyReason = 'no-data';
  }

  // Dentro del nivel manda la potencia. Sin dato de posicion no se modula.
  // `posNivel` 0 es el MAS potente, asi que va restando, no sumando.
  const pos = entry?.posNivel;
  if (penaltyReason === 'hazard' && pos !== undefined) {
    base *= POSITION_MAX - (POSITION_MAX - POSITION_MIN) * pos;
  }

  // RECARGOS: el eje de exposicion, que se suma al peldaño.
  let penalty = base;
  penalty += OVEREXPOSURE_SURCHARGE[risk];
  if (anses) penalty += ANSES_SURCHARGE;
  if (meanOver.some((g) => VULNERABLE_GROUPS.has(g))) penalty += VULNERABLE_SURCHARGE;
  if (entry?.sinMargen) penalty += NO_MARGIN_SURCHARGE;

  const bans: AdditiveBan[] = (entry?.normas ?? []).map((n) => ({
    jurisdiction: n.j,
    reference: n.ref,
    verb: n.verbo,
    partial: n.alcance === 'parcial' || undefined,
  }));

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
    banned,
    bans,
    hazardLevel: level,
    hazardDescription: entry?.nivelDesc,
    hazardCertainty: entry?.certeza,
    adi: entry?.ida,
    noDoseReason: entry?.sinDosis,
    iarcGroup: entry?.iarc,
    clpWorst: entry?.clp,
    penaltyReason,
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
  /** Cuantos estan prohibidos en alguna jurisdiccion */
  bannedCount: number;
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
    bannedCount: assessments.filter((a) => a.banned).length,
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

/** Por que penaliza lo que penaliza. Sin esto la ficha no puede explicarse. */
export function describePenaltyReason(a: AdditiveAssessment): string {
  switch (a.penaltyReason) {
    case 'banned': {
      const j = a.bans.map((b) => b.jurisdiction).join(', ');
      return j ? `Prohibido en ${j}` : 'Prohibido en alguna jurisdiccion';
    }
    case 'hazard':
      return a.hazardDescription
        ? `Peligro ${a.hazardCertainty ?? ''}: ${a.hazardDescription}`.replace('  ', ' ')
        : 'Peligro identificado';
    case 'no-data':
      return NO_DOSE_LABELS[a.noDoseReason ?? ''] ?? 'Sin datos de peligro disponibles';
    default:
      return 'Sin evaluacion disponible';
  }
}

export const NO_DOSE_LABELS: Record<string, string> = {
  'no-necesario': 'Evaluado: no hizo falta fijarle una dosis maxima',
  'margen-de-seguridad': 'Hay margen entre el uso y el efecto observado',
  'datos-incompletos': 'No se pudo evaluar: faltan datos toxicologicos',
  'sin-estudio-critico': 'No se identifico el estudio que fijaria la dosis',
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
      return 'Evaluado por EFSA: no se supera la ingesta diaria admisible';
    default:
      return 'Sin evaluacion de sobreexposicion disponible';
  }
}
