/**
 * Banderas de categoria de un producto de Open Food Facts.
 *
 * Son las que necesita el Nutri-Score, y no son un detalle: `isBeverage` cambia
 * la escala ENTERA del calculo, y las demas cambian que componente se usa. En
 * una medicion sobre el catalogo publicado de Espana, su ausencia movia la nota
 * 11,67 puntos de media, cuatro veces mas que cualquier otro dato.
 *
 * Open Food Facts las publica en tres sitios, con coberturas muy distintas
 * medidas sobre los 4.753.871 productos del volcado:
 *
 *   nutriscore["2023"].data    99,1%   <- la estructura v3
 *   categories_tags            43,5%   <- heuristica sobre nombres de categoria
 *   nutriscore_data            29,6%   <- el formato anterior
 *
 * La aplicacion leia de `categories_tags` y la tuberia de `nutriscore_data`, asi
 * que el MISMO producto podia puntuar distinto segun viniera del catalogo o de
 * la API. Por eso esto vive en un modulo compartido y no duplicado a cada lado.
 *
 * `categories_tags` queda de ultimo recurso: buscar «beverages» o «bebidas»
 * dentro del nombre de una categoria es adivinar, mientras que las otras dos son
 * la bandera que Open Food Facts ya calculo.
 */

const cierto = (v) => v === true || v === 1 || v === '1' || v === 'on';

/** Las cinco banderas de un objeto que las lleve, o null si no las lleva. */
function deObjeto(o) {
  if (!o || typeof o !== 'object' || o.is_beverage === undefined) return null;
  return {
    isBeverage: cierto(o.is_beverage),
    isWater: cierto(o.is_water),
    isCheese: cierto(o.is_cheese),
    isFatOilNutsSeeds: cierto(o.is_fat_oil_nuts_seeds),
    isRedMeat: cierto(o.is_red_meat_product ?? o.is_red_meat),
  };
}

/** Ultimo recurso: deducirlas del nombre de las categorias. */
function deCategorias(tags) {
  if (!Array.isArray(tags) || !tags.length) return null;
  const hay = (...trozos) => trozos.some((t) => tags.some((c) => String(c).includes(t)));
  return {
    isBeverage: hay('beverages', 'drinks', 'bebidas', 'boissons', 'getranke'),
    isWater: hay('waters', 'en:water', 'aguas', 'eaux'),
    isCheese: hay('cheese', 'quesos', 'fromages', 'kase'),
    isFatOilNutsSeeds: hay('vegetable-oils', 'olive-oils', 'nuts', 'seeds', 'fats', 'butters', 'aceites'),
    isRedMeat: hay('beef', 'pork', 'lamb', 'veal', 'red-meat', 'carnes-rojas'),
  };
}

/**
 * Devuelve las banderas y de donde salieron.
 * `origen` permite medir despues que fuente esta aportando, sin recargar nada.
 */
export function banderasDe(p) {
  for (const [origen, obj] of [
    ['nutriscore_2023', p?.nutriscore?.['2023']?.data],
    ['nutriscore_2021', p?.nutriscore?.['2021']?.data],
    ['nutriscore_data', p?.nutriscore_data],
  ]) {
    const b = deObjeto(obj);
    if (b) return { ...b, origen };
  }
  const b = deCategorias(p?.categories_tags);
  if (b) return { ...b, origen: 'categories_tags' };
  return {
    isBeverage: false, isWater: false, isCheese: false,
    isFatOilNutsSeeds: false, isRedMeat: false, origen: null,
  };
}
