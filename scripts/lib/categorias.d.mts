/** Tipos para `categorias.mjs`. Ver alli el porque del orden de fuentes. */
export interface BanderasCategoria {
  isBeverage: boolean;
  isWater: boolean;
  isCheese: boolean;
  isFatOilNutsSeeds: boolean;
  isRedMeat: boolean;
  /** De que fuente salieron, o null si de ninguna. */
  origen: 'nutriscore_2023' | 'nutriscore_2021' | 'nutriscore_data' | 'categories_tags' | null;
}
export declare function banderasDe(producto: unknown): BanderasCategoria;
