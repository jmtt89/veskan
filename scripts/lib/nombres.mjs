/**
 * Eleccion de nombre e ingredientes entre los idiomas de un producto.
 *
 * Open Food Facts guarda los textos por idioma: `product_name` (el principal) y
 * `product_name_fr`, `product_name_es`, `product_name_ja`... segun quien lo haya
 * rellenado. Un producto puede tener SOLO la variante de su idioma y ningun
 * `product_name`.
 *
 * Aqui se prefirio durante un tiempo el castellano de forma fija. Eso hacia dos
 * cosas malas a la vez: a un usuario frances le mostraba el nombre en castellano
 * cuando existian ambos, y -peor- DESCARTABA productos enteros, porque el
 * constructor exige nombre y un producto con solo `product_name_fr` se quedaba
 * sin el. Veskan no es una aplicacion para un pais.
 *
 * El orden es: el idioma que se pida (si se pide), luego el campo principal,
 * luego el idioma propio del producto, y por ultimo cualquier variante que
 * exista, en orden alfabetico de codigo de idioma para que dos construcciones
 * del mismo volcado den siempre lo mismo.
 */

const vacio = (v) => typeof v !== 'string' || v.trim() === '';

/**
 * Recorre las variantes de `base` en un producto y devuelve la primera util.
 * `idioma` es opcional: cuando se sabe en que idioma quiere leer el usuario.
 */
export function textoPorIdioma(p, base, idioma) {
  if (!p || typeof p !== 'object') return null;

  const candidatos = [];
  if (idioma) candidatos.push(`${base}_${idioma}`);
  candidatos.push(base);
  // `lang` es el idioma principal que Open Food Facts asigna al producto.
  if (typeof p.lang === 'string' && p.lang) candidatos.push(`${base}_${p.lang}`);

  for (const clave of candidatos) {
    if (!vacio(p[clave])) return p[clave].trim();
  }

  // Cualquier otra variante. Orden alfabetico para que sea reproducible: sin
  // esto, dos construcciones del mismo volcado podrian elegir idiomas distintos
  // segun el orden de las claves del objeto.
  const prefijo = `${base}_`;
  const restantes = Object.keys(p)
    .filter((k) => k.startsWith(prefijo) && !vacio(p[k]))
    .sort();
  for (const k of restantes) {
    // `_debug_tags` y similares no son idiomas: un codigo de idioma son 2 o 3
    // letras, con posible sufijo de region (`pt_br`).
    const sufijo = k.slice(prefijo.length);
    if (/^[a-z]{2,3}(_[a-z]{2,4})?$/i.test(sufijo)) return p[k].trim();
  }
  return null;
}

/** Nombre del producto. Cae a `generic_name` antes de rendirse. */
export function nombreDe(p, idioma) {
  return textoPorIdioma(p, 'product_name', idioma) ?? textoPorIdioma(p, 'generic_name', idioma);
}

/** Lista de ingredientes. */
export function ingredientesDe(p, idioma) {
  return textoPorIdioma(p, 'ingredients_text', idioma);
}
