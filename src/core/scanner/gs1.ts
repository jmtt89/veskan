/**
 * Interpretacion del prefijo GS1 de un codigo de barras.
 *
 * ADVERTENCIA sobre el mito mas extendido de los codigos de barras: el prefijo
 * NO indica donde se fabrico el producto ni donde se vende. Indica la
 * **organizacion GS1 en la que se registro el propietario de la marca**. Una
 * empresa registrada en GS1 Mexico puede fabricar en China y vender en Espana.
 *
 * Medido sobre nuestros propios snapshots (2026-09-17), el prefijo acierta el
 * pais entre el 52% y el 79% de las veces:
 *
 *   Colombia   79,0% prefijo colombiano    8,0% estadounidense
 *   Mexico     68,0% prefijo mexicano     19,5% estadounidense
 *   Espana     55,9% prefijo espanol
 *   Venezuela  51,8% prefijo venezolano   11,1% estadounidense
 *
 * Por eso aqui se usa como PISTA para decidir que base consultar primero, nunca
 * como verdad. Si la pista falla, se recorre el resto igualmente.
 *
 * Su otro uso, mas fiable, es detectar codigos que NO son productos de consumo
 * globales: libros, revistas, cupones y sobre todo los de uso interno de tienda,
 * que no son unicos a nivel mundial.
 */

export type BarcodeKind =
  | 'product'
  /** Rango 02, 04, 2xx: cada cadena los reutiliza para sus propios articulos */
  | 'store-internal'
  | 'book'
  | 'magazine'
  | 'coupon'
  | 'refund'
  | 'unknown';

export interface BarcodeInfo {
  kind: BarcodeKind;
  /** Region probable del propietario de la marca. Es una pista, no un dato. */
  region?: string;
  /** Codigo de pais de nuestro catalogo de snapshots, si corresponde */
  country?: string;
  /** Explicacion para mostrar al usuario cuando el codigo no es resoluble */
  note?: string;
}

interface PrefixRange {
  from: number;
  to: number;
  region: string;
  /** Pais de nuestro catalogo de snapshots */
  country?: string;
  kind?: BarcodeKind;
}

/**
 * Tabla de prefijos GS1. Solo se detallan los rangos utiles para esta app:
 * los paises que tenemos en el catalogo, los grandes exportadores que aparecen
 * de verdad en los datos, y los rangos que NO son productos.
 */
const PREFIXES: PrefixRange[] = [
  // Uso interno / no globalmente unicos
  { from: 20, to: 29, region: 'uso interno de tienda', kind: 'store-internal' },
  { from: 200, to: 299, region: 'uso interno de tienda', kind: 'store-internal' },
  { from: 40, to: 49, region: 'uso interno de empresa', kind: 'store-internal' },

  // Norteamerica
  { from: 0, to: 19, region: 'Estados Unidos o Canadá', country: 'united-states' },
  { from: 30, to: 39, region: 'Estados Unidos', country: 'united-states' },
  { from: 60, to: 139, region: 'Estados Unidos', country: 'united-states' },
  { from: 754, to: 755, region: 'Canadá' },

  // Latinoamerica
  { from: 750, to: 750, region: 'México', country: 'mexico' },
  { from: 759, to: 759, region: 'Venezuela', country: 'venezuela' },
  { from: 770, to: 771, region: 'Colombia', country: 'colombia' },
  { from: 773, to: 773, region: 'Uruguay' },
  { from: 775, to: 775, region: 'Perú', country: 'peru' },
  { from: 777, to: 777, region: 'Bolivia' },
  { from: 778, to: 779, region: 'Argentina', country: 'argentina' },
  { from: 780, to: 780, region: 'Chile', country: 'chile' },
  { from: 784, to: 784, region: 'Paraguay' },
  { from: 786, to: 786, region: 'Ecuador' },
  { from: 789, to: 790, region: 'Brasil' },
  { from: 740, to: 745, region: 'Centroamérica' },

  // Europa
  { from: 840, to: 849, region: 'España', country: 'spain' },
  { from: 300, to: 379, region: 'Francia' },
  { from: 400, to: 440, region: 'Alemania' },
  { from: 500, to: 509, region: 'Reino Unido' },
  { from: 560, to: 560, region: 'Portugal' },
  { from: 800, to: 839, region: 'Italia' },
  { from: 870, to: 879, region: 'Países Bajos' },
  { from: 900, to: 919, region: 'Austria' },

  // Asia
  { from: 450, to: 459, region: 'Japón' },
  { from: 490, to: 499, region: 'Japón' },
  { from: 690, to: 699, region: 'China' },
  { from: 880, to: 880, region: 'Corea del Sur' },
  { from: 890, to: 890, region: 'India' },

  // No son productos de consumo
  { from: 977, to: 977, region: 'publicación periódica', kind: 'magazine' },
  { from: 978, to: 979, region: 'libro', kind: 'book' },
  { from: 980, to: 980, region: 'recibo de devolución', kind: 'refund' },
  { from: 981, to: 984, region: 'cupón', kind: 'coupon' },
  { from: 990, to: 999, region: 'cupón', kind: 'coupon' },
];

const NOTES: Partial<Record<BarcodeKind, string>> = {
  'store-internal':
    'Este código es de uso interno de una cadena de tiendas, no es único en el mundo: el mismo número identifica productos distintos en cada comercio. Suele usarse en productos pesados en tienda y en marcas blancas, y por eso no se puede buscar en una base global.',
  book: 'Este código corresponde a un libro (ISBN), no a un producto alimenticio.',
  magazine:
    'Este código corresponde a una publicación periódica (ISSN), no a un producto alimenticio.',
  coupon: 'Este código corresponde a un cupón, no a un producto.',
  refund: 'Este código corresponde a un recibo de devolución de envases, no a un producto.',
};

/**
 * Clasifica un codigo de barras por su prefijo GS1.
 *
 * Acepta EAN-13, EAN-8 y UPC-A ya normalizado a 13 digitos.
 */
export function classifyBarcode(barcode: string): BarcodeInfo {
  const digits = barcode.replace(/\D/g, '');
  if (digits.length < 8) return { kind: 'unknown' };

  // EAN-8 no lleva prefijo de organizacion utilizable de la misma forma.
  if (digits.length === 8) return { kind: 'product' };

  const three = Number.parseInt(digits.slice(0, 3), 10);
  const two = Number.parseInt(digits.slice(0, 2), 10);

  for (const range of PREFIXES) {
    // Los rangos de dos digitos (uso interno) se comprueban con dos digitos.
    const value = range.to <= 99 ? two : three;
    if (value >= range.from && value <= range.to) {
      const kind = range.kind ?? 'product';
      return {
        kind,
        region: range.region,
        country: range.country,
        note: NOTES[kind],
      };
    }
  }

  return { kind: 'product', region: undefined };
}

/**
 * Orden en el que conviene consultar los snapshots para un codigo dado.
 *
 * El pais del usuario va primero porque es el que probablemente tiene
 * descargado y funciona sin conexion. Despues el que sugiere el prefijo. El
 * resto queda para la consulta en vivo.
 */
export function snapshotPriority(barcode: string, userCountry?: string): string[] {
  const info = classifyBarcode(barcode);
  const order: string[] = [];
  if (userCountry) order.push(userCountry);
  if (info.country && !order.includes(info.country)) order.push(info.country);
  return order;
}

/** true si el codigo no puede resolverse en ninguna base global. */
export function isUnresolvable(barcode: string): boolean {
  const kind = classifyBarcode(barcode).kind;
  return kind === 'store-internal' || kind === 'coupon' || kind === 'refund';
}
