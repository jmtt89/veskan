/**
 * Tipos del dominio. Este archivo, como todo `src/core/`, no depende de
 * ningun framework de UI: se puede reutilizar tal cual desde Angular, React,
 * Node o un Worker.
 */

export type Barcode = string;

/** De donde salio el dato del producto. Se muestra al usuario. */
export type DataSource = 'cache' | 'snapshot' | 'openfoodfacts' | 'openbeautyfacts' | 'user';

export type ProductKind = 'food' | 'beverage' | 'cosmetic' | 'petfood' | 'other';

/**
 * Nutrientes por 100 g o 100 ml. Unidades fijadas para evitar la clase de
 * error mas cara de esta app: mezclar mg con g.
 */
/**
 * Un nutriente que consta en Open Food Facts con un valor fisicamente
 * imposible. Se conserva a proposito: decir "consta 19.200 kJ/100 g, imposible,
 * comprueba el envase" informa mas que dejar el hueco vacio.
 */
export interface ImplausibleNutriment {
  /** Clave del nutriente, tal como la nombra la escalera (`energy_kj`, `salt`...). */
  key: string;
  /** Valor registrado, ya por 100 g y en unidad normalizada. */
  value: number;
  unit: string;
  /** `max`: supera el maximo fisico. `racion`: el escalado por racion no cuadra. */
  reason: 'max' | 'racion';
  /** Peldano que si dio un valor utilizable, si alguno lo hizo. */
  replacedBy?: string;
}

/**
 * Como es el valor de un nutriente cuando NO viene de la etiqueta.
 *
 *   estimate  Open Food Facts lo dedujo de la lista de ingredientes
 *   computed  el sistema lo derivo de otros valores
 *   approx    Open Food Facts lo marca como aproximado
 *
 * No se descarta ninguno: se usan igual, pero la ficha lo dice. Medido sobre el
 * volcado completo, el porcentaje de frutas y verduras es estimado el 100% de
 * las veces, la sal esta calculada en el 87,9% y la energia va marcada como
 * aproximada en el 83,1%.
 */
export type OrigenValor = 'estimate' | 'computed' | 'approx';

export interface Nutriments {
  /** kJ / 100 g */
  energyKj?: number;
  /** kcal / 100 g */
  energyKcal?: number;
  /** g / 100 g */
  fat?: number;
  saturatedFat?: number;
  transFat?: number;
  carbohydrates?: number;
  sugars?: number;
  /** Azucares libres segun OMS. Rara vez declarado; se estima si falta. */
  freeSugars?: number;
  fiber?: number;
  proteins?: number;
  /** g / 100 g (no mg) */
  salt?: number;
  /** mg / 100 g (no g) */
  sodium?: number;
  /** % de frutas, verduras, legumbres y frutos secos */
  fruitsVegetablesLegumes?: number;
  /**
   * Grado alcoholico, en % vol.
   *
   * Por encima de 1,2% el Nutri-Score NO es aplicable, segun el FAQ oficial de
   * Sante publique France, y el modelo de perfil de nutrientes de la OPS excluye
   * las bebidas alcoholicas de forma explicita. NOVA y los aditivos si aplican.
   */
  alcohol?: number;
}

export interface Product {
  barcode: Barcode;
  name?: string;
  brands?: string[];
  kind: ProductKind;
  quantity?: string;
  imageUrl?: string;
  imageThumbUrl?: string;
  ingredientsText?: string;
  /** Tags canonicos de OFF, p.ej. `en:e250` */
  additiveTags: string[];
  allergenTags: string[];
  labelTags: string[];
  categoryTags: string[];
  countryTags: string[];
  nutriments: Nutriments;
  /** Grupo NOVA 1-4 si OFF lo pudo determinar */
  novaGroup?: 1 | 2 | 3 | 4;
  /** Nutri-Score ya calculado por OFF, para contraste con el nuestro */
  offNutriscoreGrade?: NutriscoreGrade;
  offNutriscoreScore?: number;
  /** Banderas de categoria que Nutri-Score necesita y OFF ya resuelve */
  categoryFlags: CategoryFlags;
  /**
   * Nutrientes con un valor imposible en Open Food Facts. Vacio o ausente en
   * el caso normal. Ver `ImplausibleNutriment`.
   */
  /** Contenido del envase en ml, para calcular las bebidas estandar. */
  quantityMl?: number;
  /** Tipo de bebida alcoholica: decide que escalas le aplican. */
  drinkType?: 'espumoso' | 'vino' | 'cerveza' | 'sidra' | 'destilado';
  implausibleNutriments?: ImplausibleNutriment[];
  /** Nutrientes cuyo valor no viene de la etiqueta. Se usan igual; se avisa. */
  estimatedNutriments?: Partial<Record<string, OrigenValor>>;
  /**
   * De donde salieron las banderas de categoria, o `undefined` si no se
   * pudieron resolver. Sin esto, «no es una bebida» y «no sabemos si lo es» son
   * indistinguibles, y el Nutri-Score aplica escalas distintas a cada caso.
   */
  categoryFlagsSource?: string;
  source: DataSource;
  /** Epoch ms de la ultima edicion conocida del dato */
  lastModified?: number;
  /** Epoch ms en que nosotros lo guardamos */
  fetchedAt?: number;
  /** URL para que el usuario corrija el dato en el origen */
  editUrl?: string;
}

/**
 * Nutri-Score aplica reglas distintas segun la categoria. OFF ya resuelve
 * estas banderas desde la taxonomia de categorias, asi que las consumimos en
 * vez de reimplementar la clasificacion (que es un arbol de miles de nodos).
 */
export interface CategoryFlags {
  isBeverage: boolean;
  isWater: boolean;
  isCheese: boolean;
  isFatOilNutsSeeds: boolean;
  isRedMeat: boolean;
}

export const NO_CATEGORY_FLAGS: CategoryFlags = {
  isBeverage: false,
  isWater: false,
  isCheese: false,
  isFatOilNutsSeeds: false,
  isRedMeat: false,
};

export type NutriscoreGrade = 'a' | 'b' | 'c' | 'd' | 'e';

// ---------------------------------------------------------------------------
// Resultados de puntuacion
// ---------------------------------------------------------------------------

/** Un componente del calculo Nutri-Score, para poder explicarlo entero. */
export interface NutriscoreComponent {
  id: string;
  /** Valor del nutriente tal como entro al calculo */
  value?: number;
  unit: string;
  points: number;
  pointsMax: number;
}

export interface NutriscoreResult {
  score: number;
  grade: NutriscoreGrade;
  negativePoints: number;
  negativePointsMax: number;
  positivePoints: number;
  positivePointsMax: number;
  components: {
    negative: NutriscoreComponent[];
    positive: NutriscoreComponent[];
  };
  countProteins: boolean;
  countProteinsReason: string;
  proteinsLimitedReason?: string;
  /** Nutrientes obligatorios que faltaban y se contaron como 0 */
  missingInputs: string[];
}

/** Nivel de riesgo de un aditivo, derivado de la evaluacion de EFSA. */
export type AdditiveRisk = 'high' | 'moderate' | 'low' | 'none' | 'unknown';

export interface AdditiveAssessment {
  tag: string;
  eNumber?: string;
  name: string;
  classes: string[];
  risk: AdditiveRisk;
  /** Grupos poblacionales que superan la IDA en consumo medio */
  overexposedGroupsMean: string[];
  /** Grupos poblacionales que superan la IDA en el percentil 95 */
  overexposedGroupsP95: string[];
  /** Marcado por ANSES como aditivo de interes (vigilancia reforzada) */
  ansesOfInterest: boolean;
  isSweetener: boolean;
  isNonNutritiveSweetener: boolean;
  efsaEvaluationUrl?: string;
  efsaEvaluationDate?: string;
  description?: string;
  /** Penalizacion aplicada al score global, en puntos de 0-100 */
  penalty: number;
}

export type PahoSealId =
  | 'sodium'
  | 'free-sugars'
  | 'total-fat'
  | 'saturated-fat'
  | 'trans-fat'
  | 'sweeteners';

export interface PahoSeal {
  id: PahoSealId;
  /** true si el producto excede el criterio */
  exceeded: boolean;
  /** Valor calculado (p.ej. % de energia procedente de azucares libres) */
  actual?: number;
  /** Umbral del modelo OPS */
  threshold: number;
  unit: string;
  /** El valor de azucares libres fue estimado, no declarado */
  estimated?: boolean;
}

export interface PahoResult {
  /** El modelo OPS solo aplica a procesados y ultraprocesados (NOVA 3 y 4) */
  applicable: boolean;
  seals: PahoSeal[];
  exceededCount: number;
}

/** Una senal concreta de ultraprocesamiento hallada en un producto. */
export interface NovaMarker {
  kind: 'additive' | 'ingredient';
  /** Tag del aditivo (`en:e150d`) o el texto que casó en los ingredientes */
  value: string;
  /** Clase del aditivo que lo delata, p.ej. `en:colour` */
  additiveClass?: string;
}

/** Cuanto podemos confiar en el numero que mostramos. */
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'insufficient';

export interface Confidence {
  level: ConfidenceLevel;
  /** 0-1 */
  ratio: number;
  missing: string[];
  notes: string[];
}

export interface ScoreBreakdownItem {
  id: string;
  label: string;
  /** Puntos que este bloque aporta al total (positivos o negativos) */
  contribution: number;
  weight: number;
  detail: string;
}

export interface HealthScore {
  /** 0-100. 100 = perfectamente saludable. */
  value: number;
  /**
   * Hasta donde podria llegar la nota si se supiera lo que falta.
   *
   * Solo aparece cuando la confianza no es alta. Se calcula volviendo a
   * puntuar con los datos desconocidos en su mejor y peor caso, no estimando.
   */
  range?: { min: number; max: number };
  band: 'excellent' | 'good' | 'mediocre' | 'poor' | 'bad';
  breakdown: ScoreBreakdownItem[];
  confidence: Confidence;
  nutriscore?: NutriscoreResult;
  nova?: {
    group: 1 | 2 | 3 | 4;
    label: string;
    /** El grupo lo dio Open Food Facts; si no, lo dedujimos nosotros */
    fromSource: boolean;
    /** Senales de ultraprocesamiento halladas en este producto concreto */
    markers: NovaMarker[];
  };
  additives: AdditiveAssessment[];
  paho?: PahoResult;
  /**
   * Presente cuando el producto es una bebida alcoholica, y explica por que no
   * hay nota nutricional.
   *
   * No es una excepcion nuestra: el Nutri-Score «does not apply to alcoholic
   * drinks containing more than 1.2% alcohol» segun el FAQ oficial de Sante
   * publique France, y el modelo de perfil de nutrientes de la OPS excluye las
   * bebidas alcoholicas «because they should be subjected to specific
   * regulations». NOVA y los aditivos si se calculan.
   */
  alcoholic?: {
    /** Grado en % vol, si se conoce. */
    abv?: number;
    /**
     * Por que se marca. IARC clasifica el consumo de alcohol, el etanol de las
     * bebidas y el acetaldehido asociado como carcinogenos del **Grupo 1**
     * -«sufficient evidence in humans»- en su monografia vol. 100E, con cancer
     * de cavidad oral, faringe, laringe, esofago, colorrecto, higado y mama.
     *
     * Se dice «el riesgo aumenta desde dosis bajas» y NO «no hay umbral
     * seguro»: lo primero lo sostiene el meta-analisis de Bagnardi (222
     * articulos), cuya propia critica publicada acepta el cancer de mama; lo
     * segundo es una posicion de la OMS que la monografia no afirma, y en
     * mortalidad global la evidencia esta en disputa.
     */
    motivo: 'iarc-grupo-1';
  };
  /** Version del algoritmo con la que se calculo, para reproducibilidad */
  algorithmVersion: string;
}

/** Resultado para cosmetica: banderas regulatorias, sin numero global. */
export interface CosmeticFlag {
  id: string;
  severity: 'prohibited' | 'restricted' | 'allergen' | 'info';
  ingredient: string;
  message: string;
  reference?: string;
}

export interface CosmeticAssessment {
  flags: CosmeticFlag[];
  /** Cuantos ingredientes INCI se pudieron identificar */
  recognizedIngredients: number;
  totalIngredients: number;
  hasFullInciList: boolean;
  confidence: Confidence;
}

export type Assessment =
  | { kind: 'food'; product: Product; score: HealthScore }
  | { kind: 'cosmetic'; product: Product; assessment: CosmeticAssessment };
