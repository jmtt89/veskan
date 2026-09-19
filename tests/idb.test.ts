/**
 * Tests del cache local (capa L0).
 *
 * Se prueba la DECISION de descartar una fila, no Dexie: la lectura real
 * necesita IndexedDB y eso obligaria a meter otra dependencia solo para el
 * banco de pruebas.
 */

import { describe, expect, it } from 'vitest';
import { CACHE_SCHEMA_VERSION, CACHE_TTL_MS, filaCaducada } from '../src/core/data/idb.js';

const ahora = Date.UTC(2026, 8, 19, 12, 0, 0);

describe('cuando una fila del cache deja de servir', () => {
  it('sirve la fila fresca de la version vigente', () => {
    expect(filaCaducada({ cachedAt: ahora - 1000, schema: CACHE_SCHEMA_VERSION }, ahora)).toBe(false);
  });

  it('descarta la fila fresca que escribio una version anterior del mapeo', () => {
    // El caso del 7506475104722: en el catalogo los datos estaban bien, pero
    // el navegador servia el producto tal como lo mapeabamos antes de los
    // arreglos. En incognito, sin cache, se veia correcto.
    expect(
      filaCaducada({ cachedAt: ahora - 1000, schema: CACHE_SCHEMA_VERSION - 1 }, ahora),
    ).toBe(true);
  });

  it('descarta las filas anteriores al sellado, que no llevan version', () => {
    expect(filaCaducada({ cachedAt: ahora - 1000 }, ahora)).toBe(true);
  });

  it('sigue descartando por edad aunque la version coincida', () => {
    expect(
      filaCaducada({ cachedAt: ahora - CACHE_TTL_MS - 1, schema: CACHE_SCHEMA_VERSION }, ahora),
    ).toBe(true);
  });
});
