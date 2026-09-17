/**
 * Carga de taxonomias (aditivos).
 *
 * El archivo lo genera `scripts/build-taxonomies.mjs` a partir de la taxonomia
 * ODbL de Open Food Facts y lo precachea el Service Worker, asi que tras la
 * primera visita esta disponible sin red.
 */

import type { AdditiveTaxonomy } from '../scoring/additives.js';
import { buildAdditiveClassMap } from '../scoring/engine.js';
import type { ScoringContext } from '../scoring/engine.js';

let cached: ScoringContext | undefined;
let inflight: Promise<ScoringContext> | undefined;

export async function loadScoringContext(
  url = './data/additives.json',
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<ScoringContext> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`No se pudo cargar la taxonomia de aditivos (HTTP ${res.status})`);
    const additiveTaxonomy = (await res.json()) as AdditiveTaxonomy;
    cached = {
      additiveTaxonomy,
      additiveClasses: buildAdditiveClassMap(additiveTaxonomy),
    };
    return cached;
  })();

  try {
    return await inflight;
  } finally {
    inflight = undefined;
  }
}

/** Para tests: inyecta una taxonomia sin tocar la red. */
export function setScoringContext(ctx: ScoringContext): void {
  cached = ctx;
}
