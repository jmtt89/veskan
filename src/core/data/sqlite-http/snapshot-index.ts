/**
 * Indice de snapshots por pais.
 *
 * Lo publica el pipeline junto a las bases, y sirve para que el cliente decida
 * la estrategia de cada pais SIN cablear tamanos en el codigo, que quedarian
 * obsoletos a la primera reconstruccion.
 *
 * Dos estrategias, elegidas por tamano:
 *
 *   descarga completa  -> el archivo entero, una vez. Despues funciona SIN
 *                         CONEXION. Un SQLite comprime ~71% por la red, asi que
 *                         Venezuela son ~0,3 MB: menos que dos consultas por
 *                         rangos. Es la buena para Latinoamerica, donde ademas
 *                         la conexion es peor.
 *   rangos HTTP        -> solo las paginas que toca cada consulta. Necesaria
 *                         para paises grandes: Espana pesa ~70 MB comprimida y
 *                         no se puede descargar entera.
 */

/** Un eslabon de la cadena de actualizaciones incrementales. */
export interface SnapshotDelta {
  /** Version de la base a la que se le puede aplicar */
  from: string;
  /** Version que resulta de aplicarlo */
  to: string;
  file: string;
  bytes: number;
  upserts: number;
  deletes: number;
}

/**
 * Una parte de un catalogo partido.
 *
 * Cada parte es un SQLite COMPLETO y funcional, con su tabla de productos y su
 * indice de texto. Lo unico que la distingue es que solo contiene los codigos
 * de barras de su rango.
 */
export interface SnapshotPart {
  file: string;
  /** Primer codigo del rango, incluido. `null` en la primera parte. */
  from: string | null;
  /** Primer codigo de la parte siguiente, excluido. `null` en la ultima. */
  to: string | null;
  products: number;
  bytes: number;
  /** Cadena de deltas de ESTA parte: cada una cambia por su cuenta */
  deltas?: SnapshotDelta[];
}

export interface SnapshotCountryEntry {
  /** Solo en catalogos de un unico archivo. Los partidos usan `parts`. */
  file?: string;
  products: number;
  bytes: number;
  /**
   * Version del catalogo publicado. Falta en los indices anteriores a las
   * actualizaciones incrementales, y entonces no hay cadena que seguir.
   */
  version?: string;
  /** Cadena de deltas disponibles, del mas viejo al mas nuevo */
  deltas?: SnapshotDelta[];
  /**
   * Partes del catalogo. Siempre hay al menos una.
   *
   * Un catalogo de mas de 100 MB no se puede publicar en GitHub, asi que se
   * parte por rango de codigo de barras. El rango va en cada parte para que el
   * cliente sepa en cual buscar sin abrirlas todas, que es la operacion de cada
   * escaneo.
   */
  parts?: SnapshotPart[];
}

/**
 * Partes de un catalogo, normalizando el caso de un solo archivo.
 *
 * Asi el resto del codigo tiene un unico camino en vez de dos.
 */
export function partsOf(entry: SnapshotCountryEntry): SnapshotPart[] {
  if (entry.parts?.length) return entry.parts;
  return [
    {
      file: entry.file ?? '',
      from: null,
      to: null,
      products: entry.products,
      bytes: entry.bytes,
      deltas: entry.deltas,
    },
  ];
}

/**
 * Parte que contiene un codigo de barras.
 *
 * La comparacion es de CADENAS, no de numeros, porque es asi como ordena e
 * indexa SQLite: los cortes se calcularon con su mismo criterio. Convertir a
 * numero o rellenar con ceros daria otro orden y el codigo caeria en la parte
 * equivocada.
 */
export function partFor(parts: SnapshotPart[], barcode: string): SnapshotPart | undefined {
  return parts.find((p) => (p.from === null || barcode >= p.from) && (p.to === null || barcode < p.to));
}

export interface SnapshotIndex {
  generated_at: string;
  source: string;
  license: string;
  page_size: number;
  countries: Record<string, SnapshotCountryEntry>;
}

let cached: SnapshotIndex | undefined;

export async function loadSnapshotIndex(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<SnapshotIndex | undefined> {
  if (cached) return cached;
  try {
    const res = await fetchImpl(`${baseUrl}/index.json`, { cache: 'no-cache' });
    if (!res.ok) return undefined;
    cached = (await res.json()) as SnapshotIndex;
    return cached;
  } catch {
    // Sin indice la app sigue funcionando contra la API en vivo: la capa del
    // snapshot es un acelerador, no una dependencia.
    return undefined;
  }
}

export const COUNTRY_LABELS: Record<string, string> = {
  spain: 'España',
  mexico: 'México',
  colombia: 'Colombia',
  venezuela: 'Venezuela',
  argentina: 'Argentina',
  chile: 'Chile',
  peru: 'Perú',
  'united-states': 'Estados Unidos',
};

/** Deduce el pais a partir del idioma y la zona horaria del navegador. */
export function guessCountry(available: string[]): string | undefined {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  const byTimezone: Record<string, string> = {
    'America/Caracas': 'venezuela',
    'America/Bogota': 'colombia',
    'America/Mexico_City': 'mexico',
    'America/Santiago': 'chile',
    'America/Lima': 'peru',
    'America/Argentina/Buenos_Aires': 'argentina',
    'Europe/Madrid': 'spain',
  };
  const guess = byTimezone[tz];
  if (guess && available.includes(guess)) return guess;

  const region = new Intl.Locale(navigator.language).region?.toLowerCase();
  const byRegion: Record<string, string> = {
    ve: 'venezuela', co: 'colombia', mx: 'mexico', cl: 'chile',
    pe: 'peru', ar: 'argentina', es: 'spain',
  };
  const fromRegion = region ? byRegion[region] : undefined;
  return fromRegion && available.includes(fromRegion) ? fromRegion : undefined;
}
