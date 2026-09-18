/**
 * Escalas propias de las bebidas alcoholicas.
 *
 * Ninguna dice si la bebida es buena: el alcohol es carcinogeno del Grupo 1 y
 * eso ya esta resuelto. Estas escalas CLASIFICAN, que es otra cosa, y son las
 * unicas del mundo del alcohol que cumplen a la vez tres condiciones: tener
 * definicion publicada, ser numericas y poder calcularse con lo que tenemos.
 *
 * Se descartaron por eso las puntuaciones tipo Parker o Wine Spectator -juicio
 * de un catador, no comprobable- y las escalas tecnicas de la cerveza -IBU,
 * SRM/EBC, grados Plato-, que estan bien definidas pero Open Food Facts no las
 * recoge: medido sobre las 1.815 bebidas con grado declarado, ni una las trae.
 */

/** Densidad del etanol a 20 C, en g/ml. */
const DENSIDAD_ETANOL = 0.789;

/**
 * Gramos de etanol que lleva el envase.
 *
 * Es lo que Irlanda exigira declarar desde mayo de 2026, y responde algo que el
 * «por 100 ml» no dice: cuanto alcohol hay en lo que tienes en la mano.
 */
export function gramosDeEtanol(gradoPorCiento, volumenMl) {
  if (!(gradoPorCiento > 0) || !(volumenMl > 0)) return null;
  return (volumenMl * gradoPorCiento) / 100 * DENSIDAD_ETANOL;
}

/**
 * Bebidas estandar segun cada pais.
 *
 * No hay una sola definicion: van de 8 a 20 g de etanol. La de la OMS (10 g),
 * que usa su test AUDIT, es la mas adoptada, y por eso es la que se muestra.
 * Las demas se guardan para poder decir de donde sale cada cifra.
 */
export const BEBIDA_ESTANDAR_G = {
  oms: 10, reinoUnido: 8, estadosUnidos: 14, canada: 13.6, austria: 20,
};

export function bebidasEstandar(gramosEtanol, gramosPorUnidad = BEBIDA_ESTANDAR_G.oms) {
  if (!(gramosEtanol > 0)) return null;
  return gramosEtanol / gramosPorUnidad;
}

/**
 * Dulzor de un vino espumoso, por azucar residual.
 *
 * Reglamento (CE) 607/2009: siete categorias por gramos por litro, con
 * tolerancia de +-3 g/L, y es OBLIGATORIO declararlo en la etiqueta. Los rangos
 * se solapan a proposito en la norma -un vino con 5 g/L puede etiquetarse Extra
 * Brut o Brut-, asi que se devuelve la categoria mas seca que lo admite, que es
 * la interpretacion conservadora.
 */
const DULZOR_ESPUMOSO = [
  { hasta: 3, nombre: 'Brut Nature', nota: 'sin azúcar añadido' },
  { hasta: 6, nombre: 'Extra Brut', nota: null },
  { hasta: 12, nombre: 'Brut', nota: 'el estilo más común' },
  { hasta: 17, nombre: 'Extra Seco', nota: null },
  { hasta: 32, nombre: 'Seco', nota: null },
  { hasta: 50, nombre: 'Semiseco', nota: null },
  { hasta: Infinity, nombre: 'Dulce', nota: null },
];

/** `azucaresPor100ml` en g. Devuelve `null` si no hay dato. */
export function dulzorEspumoso(azucaresPor100ml) {
  if (azucaresPor100ml === null || azucaresPor100ml === undefined || azucaresPor100ml < 0) return null;
  const gPorLitro = azucaresPor100ml * 10;
  const cat = DULZOR_ESPUMOSO.find((c) => gPorLitro <= c.hasta);
  return { categoria: cat.nombre, gPorLitro, nota: cat.nota };
}

/**
 * Tipo de bebida alcoholica, deducido de las categorias de Open Food Facts.
 *
 * Hace falta para saber que escala aplica: el dulzor del Reglamento 607/2009 es
 * de espumosos, y ponerselo a una cerveza seria usar una norma fuera de su
 * alcance, que es justo lo que venimos evitando.
 */
export function tipoDeBebida(tags) {
  if (!Array.isArray(tags) || !tags.length) return null;
  const hay = (...t) => t.some((x) => tags.some((c) => String(c).includes(x)));
  // El orden importa: un cava es espumoso antes que vino.
  if (hay('sparkling-wines', 'champagnes', 'cava', 'cremant', 'prosecco', 'espumosos')) return 'espumoso';
  if (hay('wines', 'vinos', 'vins')) return 'vino';
  if (hay('beers', 'cervezas', 'bieres', 'biere')) return 'cerveza';
  if (hay('ciders', 'sidras', 'cidres')) return 'sidra';
  if (hay('spirits', 'whisky', 'whiskies', 'vodka', 'rum', 'gin', 'tequila', 'licores', 'liqueurs')) return 'destilado';
  return null;
}
