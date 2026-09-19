/**
 * URLs de las fotos de producto de Open Food Facts.
 *
 * El catalogo no guarda la URL entera sino una referencia compacta,
 * `"<idioma>.<rev>"` -p.ej. `"es.37"`-, porque el resto es deducible del codigo
 * de barras, que ya esta en la fila. Son unos 6 bytes por producto en vez de
 * unos 75: sobre el millon y medio de productos publicados, decenas de MB de
 * catalogo que ademas se parte por tamano.
 *
 * El volcado de Open Food Facts NO trae ninguna URL de imagen: `image_url` y
 * `image_front_small_url` son campos calculados que solo existen en la API.
 * Ver `scripts/lib/imagenes.mjs`.
 *
 * Datos e imagenes de Open Food Facts bajo licencia ODbL.
 */

const BASE = 'https://images.openfoodfacts.org/images/products';

/** Tamanos que Open Food Facts genera para cada foto. */
export type TamanoImagen = 100 | 200 | 400 | 'full';

/**
 * Troceado del codigo de barras en la ruta.
 *
 * Open Food Facts parte los codigos de MAS de ocho caracteres en grupos de
 * tres y deja el resto al final; los de ocho o menos van tal cual.
 * Comprobado contra el servidor: `.../00000000/front_de.290.200.jpg` responde
 * 200 y `.../000/000/00/...` responde 404.
 */
export function rutaDeCodigo(barcode: string): string {
  const c = barcode.trim();
  if (c.length <= 8) return c;
  const m = /^(\d{3})(\d{3})(\d{3})(.*)$/.exec(c);
  if (!m) return c;
  // El cuarto grupo esta vacio en un codigo de exactamente nueve digitos, y
  // dejarlo produciria una barra final que no corresponde a ninguna ruta.
  return [m[1], m[2], m[3], m[4]].filter(Boolean).join('/');
}

/**
 * URL de la foto frontal, o `undefined` si el producto no tiene ninguna.
 *
 * `ref` es lo que guarda la columna `image_ref` del catalogo. Se valida antes
 * de construir nada: una referencia mal formada daria una URL que responde 404
 * y dejaria un hueco roto en la interfaz, que es peor que no mostrar foto.
 */
export function urlImagenFrontal(
  barcode: string,
  ref: string | null | undefined,
  tamano: TamanoImagen = 200,
): string | undefined {
  if (!ref) return undefined;
  const m = /^([a-z]{2,3})\.(\d+)$/i.exec(ref.trim());
  if (!m) return undefined;
  const idioma = m[1]!.toLowerCase();
  const rev = m[2]!;
  if (!barcode.trim()) return undefined;
  return `${BASE}/${rutaDeCodigo(barcode)}/front_${idioma}.${rev}.${tamano}.jpg`;
}
