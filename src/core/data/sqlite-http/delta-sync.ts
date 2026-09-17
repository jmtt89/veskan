/**
 * Actualizacion incremental de los catalogos descargados.
 *
 * Un catalogo guardado se queda viejo en cuanto el pipeline reconstruye. Volver
 * a bajarlo entero cuesta 76,6 MB en el caso de Espana; el delta de un dia son
 * **25,0 kB medidos** sobre un cambio real de 315 productos y 4 bajas: 3.100
 * veces menos. Por eso esta capa existe.
 *
 * Los deltas NO son los que publica Open Food Facts. Los suyos vienen sin el
 * campo `nutriments` -- comprobado, 0 de 5.734 registros lo traen con valores,
 * frente al 62% en el volcado completo -- asi que aplicarlos borraria energia,
 * azucares y sal de cada producto actualizado. Los nuestros los calcula
 * `scripts/build-delta.mjs` comparando dos generaciones del snapshot, y por
 * construccion cumplen: catalogo anterior + delta == catalogo nuevo.
 */

import type { SnapshotCountryEntry, SnapshotDelta } from './snapshot-index.js';

/** Una fila del delta: alta o modificacion. */
export interface DeltaUpsert {
  op: 'u';
  /** 1 si cambiaron `name` o `brands` y hay que rehacer su entrada en el indice */
  fts: 0 | 1;
  barcode: string;
  [column: string]: unknown;
}

/** Una baja: el producto desaparecio del catalogo. */
export interface DeltaDelete {
  op: 'd';
  barcode: string;
}

export interface DeltaHeader {
  format: number;
  country: string;
  from: string;
  to: string;
  upserts: number;
  deletes: number;
  /** Columnas que trae cada fila, para no depender de la version del cliente */
  columns: string[];
}

export interface DeltaFile {
  header: DeltaHeader;
  upserts: DeltaUpsert[];
  deletes: string[];
}

export type SyncPlan =
  /** La copia local ya coincide con lo publicado */
  | { kind: 'up-to-date' }
  /** Hay cadena completa: se aplican estos deltas en orden */
  | { kind: 'deltas'; chain: SnapshotDelta[]; bytes: number }
  /** No hay cadena util: toca bajar el catalogo entero */
  | { kind: 'full'; reason: FullReason };

export type FullReason =
  /** La base local no dice de que version es */
  | 'sin-version-local'
  /** El indice publicado no dice de que version es */
  | 'sin-version-publicada'
  /** Falta algun eslabon entre la version local y la publicada */
  | 'cadena-rota'
  /** La cadena existe pero pesa tanto que no compensa */
  | 'delta-demasiado-grande';

/**
 * Por encima de esta fraccion del catalogo, bajarlo entero sale mejor.
 *
 * Aplicar un delta no es gratis: cada fila se escribe en la base Y obliga a
 * rehacer su entrada en el indice de texto. Con muchos dias acumulados el
 * trabajo se acerca al de una descarga limpia, que ademas deja el archivo
 * compacto en vez de fragmentado.
 */
export const UMBRAL_DELTA = 0.35;

/**
 * Decide como ponerse al dia. Funcion pura a proposito: es donde esta la
 * decision, y no deberia hacer falta ni red ni navegador para probarla.
 */
export function planSync(localVersion: string | undefined, entry: SnapshotCountryEntry): SyncPlan {
  if (!localVersion) return { kind: 'full', reason: 'sin-version-local' };
  if (!entry.version) return { kind: 'full', reason: 'sin-version-publicada' };
  if (localVersion === entry.version) return { kind: 'up-to-date' };

  // Se sigue la cadena desde la version local hacia delante. Cada delta declara
  // a que version se aplica y cual produce, asi que encadenar es seguir `to`.
  const porOrigen = new Map((entry.deltas ?? []).map((d) => [d.from, d]));
  const chain: SnapshotDelta[] = [];
  let actual = localVersion;
  const vistos = new Set<string>([actual]);

  while (actual !== entry.version) {
    const paso = porOrigen.get(actual);
    // Sin eslabon, o si la cadena se muerde la cola por un indice mal
    // publicado, se para aqui en vez de dar vueltas.
    if (!paso || vistos.has(paso.to)) return { kind: 'full', reason: 'cadena-rota' };
    chain.push(paso);
    vistos.add(paso.to);
    actual = paso.to;
  }

  const bytes = chain.reduce((t, d) => t + d.bytes, 0);
  if (entry.bytes > 0 && bytes > entry.bytes * UMBRAL_DELTA) {
    return { kind: 'full', reason: 'delta-demasiado-grande' };
  }
  return { kind: 'deltas', chain, bytes };
}

/** Texto para el usuario: cuanto le va a costar ponerse al dia. */
export function syncCost(plan: SyncPlan, entry: SnapshotCountryEntry): string | undefined {
  const mb = (b: number) =>
    b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} kB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (plan.kind === 'up-to-date') return undefined;
  if (plan.kind === 'deltas') {
    const dias = plan.chain.length;
    return `Actualización disponible: ${mb(plan.bytes)}${dias > 1 ? ` (${dias} días)` : ''}.`;
  }
  return `Actualización disponible: ${mb(entry.bytes)}, hay que volver a descargarlo entero.`;
}

/**
 * Descarga y parsea un delta.
 *
 * Se descomprime con `DecompressionStream` y no dejando que lo haga el
 * navegador: `raw.githubusercontent.com` sirve los `.gz` como
 * `application/octet-stream` sin `Content-Encoding`, asi que llegan comprimidos
 * tal cual.
 */
export async function fetchDelta(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<DeltaFile> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`No se ha podido descargar el delta (HTTP ${res.status})`);
  if (!res.body) throw new Error('El delta ha llegado vacío');

  const texto = await new Response(
    res.body.pipeThrough(new DecompressionStream('gzip')),
  ).text();

  return parseDelta(texto);
}

/** Separado de la descarga para poder probarlo sin red. */
export function parseDelta(texto: string): DeltaFile {
  const lineas = texto.split('\n').filter((l) => l.trim());
  if (lineas.length === 0) throw new Error('El delta está vacío');

  const header = JSON.parse(lineas[0]!) as DeltaHeader;
  if (header.format !== 1) {
    throw new Error(`Formato de delta desconocido (${header.format}): hace falta actualizar la aplicación`);
  }

  const upserts: DeltaUpsert[] = [];
  const deletes: string[] = [];
  for (const linea of lineas.slice(1)) {
    const fila = JSON.parse(linea) as DeltaUpsert | DeltaDelete;
    if (fila.op === 'd') deletes.push(fila.barcode);
    else upserts.push(fila);
  }

  // La cabecera declara cuantos cambios trae. Si no cuadra, el archivo llego a
  // medias: aplicarlo dejaria la base en un estado que no corresponde a
  // ninguna version, y la siguiente comparacion la creeria al dia.
  if (upserts.length !== header.upserts || deletes.length !== header.deletes) {
    throw new Error(
      `El delta llegó incompleto: ${upserts.length}/${header.upserts} cambios y ` +
        `${deletes.length}/${header.deletes} bajas`,
    );
  }
  return { header, upserts, deletes };
}
