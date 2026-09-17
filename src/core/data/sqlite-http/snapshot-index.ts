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

export interface SnapshotCountryEntry {
  file: string;
  products: number;
  bytes: number;
}

export interface SnapshotIndex {
  generated_at: string;
  source: string;
  license: string;
  page_size: number;
  countries: Record<string, SnapshotCountryEntry>;
}

export type SnapshotStrategy = 'download' | 'range';

/**
 * Umbral por encima del cual se consulta por rangos en vez de descargar.
 *
 * 20 MB sin comprimir son unos 6 MB por la red. Por encima de eso, una descarga
 * en datos moviles deja de ser razonable para el beneficio que da.
 */
export const DOWNLOAD_THRESHOLD_BYTES = 20 * 1024 * 1024;

export function strategyFor(entry: SnapshotCountryEntry): SnapshotStrategy {
  return entry.bytes <= DOWNLOAD_THRESHOLD_BYTES ? 'download' : 'range';
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

/**
 * Paises disponibles, ordenados por cobertura.
 * Se muestran al usuario para que elija el suyo.
 */
export function availableCountries(
  index: SnapshotIndex,
): Array<{ code: string; products: number; bytes: number; strategy: SnapshotStrategy }> {
  return Object.entries(index.countries)
    .map(([code, entry]) => ({
      code,
      products: entry.products,
      bytes: entry.bytes,
      strategy: strategyFor(entry),
    }))
    .sort((a, b) => b.products - a.products);
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

/**
 * Paises cuyo catalogo conviene tener aunque no sea el del usuario.
 *
 * En Latinoamerica los importados estadounidenses son habituales: medido sobre
 * nuestros propios snapshots, el 19,3% del catalogo mexicano y el 13,8% del
 * venezolano llevan prefijo GS1 de Estados Unidos.
 */
export const COMPLEMENTARY_COUNTRIES = ['united-states'];

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
