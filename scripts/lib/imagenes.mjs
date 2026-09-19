/**
 * Imagen frontal del producto a partir del volcado.
 *
 * El volcado NO trae ninguna URL de imagen. `image_url`,
 * `image_front_small_url` y compañía son campos CALCULADOS: la API los arma y
 * los devuelve, pero en el volcado no existen -comprobado sobre la coleccion
 * completa, el campo ni siquiera esta presente-. Es el mismo caso que el
 * agujero de los nutrientes: leer el campo comodo del API y darlo por perdido
 * al no encontrarlo en el volcado.
 *
 * Lo que el volcado si trae es `images.selected.front.<idioma>`, con el numero
 * de revision, y con eso la URL se construye entera:
 *
 *   https://images.openfoodfacts.org/images/products/<ruta>/front_<idioma>.<rev>.<tam>.jpg
 *
 * Se guarda `<idioma>.<rev>` -unos 6 bytes- en vez de la URL completa -unos
 * 75-, porque el resto es deducible del codigo de barras, que ya esta en la
 * fila. Sobre el millon y medio de productos publicados eso son decenas de MB
 * de catalogo, y los catalogos se parten por tamano.
 *
 * Datos de Open Food Facts bajo licencia ODbL.
 */

/**
 * Referencia compacta de la imagen frontal, o `null` si no hay ninguna.
 *
 * Devuelve `"<idioma>.<rev>"`, p.ej. `"es.37"`.
 *
 * Se prefiere el idioma del propio producto: es el que el fabricante uso en el
 * envase que se vende ahi, y por tanto la foto que el usuario tiene delante.
 * Si no hay foto en ese idioma se coge cualquiera, porque una foto de otro
 * idioma sigue siendo el mismo producto y es mejor que un hueco.
 */
export function refImagenFrontal(p) {
  const frontales = p?.images?.selected?.front;
  if (!frontales || typeof frontales !== 'object') return null;

  const idiomas = Object.keys(frontales);
  if (idiomas.length === 0) return null;

  const preferido = [p.lang, p.lc].find((l) => l && frontales[l]);
  const idioma = preferido ?? idiomas[0];

  // `rev` viene unas veces como numero y otras como cadena: el volcado no
  // respeta el tipo de ningun campo numerico.
  const rev = frontales[idioma]?.rev;
  if (rev === undefined || rev === null || rev === '') return null;

  const revLimpia = String(rev).trim();
  // Sin esto, un `rev` raro se colaria en la URL y daria un 404 silencioso.
  if (!/^\d+$/.test(revLimpia)) return null;
  if (!/^[a-z]{2,3}$/i.test(idioma)) return null;

  return `${idioma}.${revLimpia}`;
}
