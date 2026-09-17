/**
 * Tests de la actualizacion incremental.
 *
 * `planSync` es pura a proposito: decide si basta con deltas o hay que volver a
 * descargar el catalogo entero, y esa decision no deberia necesitar ni red ni
 * navegador para probarse.
 */

import { describe, expect, it } from 'vitest';
import {
  UMBRAL_DELTA,
  parseDelta,
  planSync,
  syncCost,
} from '../src/core/data/sqlite-http/delta-sync.js';
import type { SnapshotCountryEntry } from '../src/core/data/sqlite-http/snapshot-index.js';

const MB = 1024 * 1024;

/** Catalogo con una cadena de `dias` deltas consecutivos, uno por dia. */
const entrada = (dias: number, bytesPorDelta = 25_000): SnapshotCountryEntry => ({
  file: 'spain.sqlite3',
  products: 339_562,
  bytes: 76 * MB,
  version: `v${dias}`,
  deltas: Array.from({ length: dias }, (_, i) => ({
    from: `v${i}`,
    to: `v${i + 1}`,
    file: `deltas/spain/v${i + 1}.jsonl.gz`,
    bytes: bytesPorDelta,
    upserts: 315,
    deletes: 4,
  })),
});

describe('planSync', () => {
  it('no hace nada si la copia local ya es la publicada', () => {
    expect(planSync('v3', entrada(3))).toEqual({ kind: 'up-to-date' });
  });

  it('encadena los deltas que faltan, en orden', () => {
    const plan = planSync('v1', entrada(4));
    expect(plan.kind).toBe('deltas');
    if (plan.kind !== 'deltas') return;
    expect(plan.chain.map((d) => d.to)).toEqual(['v2', 'v3', 'v4']);
    expect(plan.bytes).toBe(75_000);
  });

  it('descarga entero si falta un eslabon', () => {
    const e = entrada(4);
    // Se cae el delta del dia 3: la cadena de v1 a v4 ya no se puede recorrer.
    e.deltas = e.deltas!.filter((d) => d.to !== 'v3');
    expect(planSync('v1', e)).toEqual({ kind: 'full', reason: 'cadena-rota' });
  });

  it('descarga entero si la copia local es mas vieja que el historial', () => {
    // El pipeline solo guarda 14 dias: quien no abre la aplicacion en tres
    // semanas no tiene por donde empezar la cadena.
    expect(planSync('v0', entrada(14)).kind).toBe('deltas');
    expect(planSync('vantigua', entrada(14))).toEqual({ kind: 'full', reason: 'cadena-rota' });
  });

  it('descarga entero cuando los deltas acumulados ya no compensan', () => {
    // 14 dias a 2 MB son 28 MB frente a 76 MB de catalogo: mas del umbral.
    const plan = planSync('v0', entrada(14, 2 * MB));
    expect(plan).toEqual({ kind: 'full', reason: 'delta-demasiado-grande' });
    // Justo por debajo del umbral si se aplican menos dias.
    expect(planSync('v10', entrada(14, 2 * MB)).kind).toBe('deltas');
  });

  it('el umbral se mide sobre el tamano del catalogo, no en absoluto', () => {
    const grande = entrada(1, 30 * MB);
    expect(planSync('v0', grande).kind).toBe('full');
    const pequeno: SnapshotCountryEntry = { ...grande, bytes: 200 * MB };
    expect(planSync('v0', pequeno).kind).toBe('deltas');
    expect(UMBRAL_DELTA).toBeGreaterThan(0);
  });

  it('sin version en algun lado, no hay cadena posible', () => {
    expect(planSync(undefined, entrada(3))).toEqual({ kind: 'full', reason: 'sin-version-local' });
    const sinVersion: SnapshotCountryEntry = { file: 'x.sqlite3', products: 1, bytes: 100 };
    expect(planSync('v1', sinVersion)).toEqual({ kind: 'full', reason: 'sin-version-publicada' });
  });

  it('no se queda dando vueltas si el indice trae un ciclo', () => {
    const e = entrada(2);
    // Un indice mal publicado que vuelve sobre si mismo.
    e.deltas = [
      { from: 'v1', to: 'v2', file: 'a', bytes: 10, upserts: 1, deletes: 0 },
      { from: 'v2', to: 'v1', file: 'b', bytes: 10, upserts: 1, deletes: 0 },
    ];
    e.version = 'v9';
    expect(planSync('v1', e)).toEqual({ kind: 'full', reason: 'cadena-rota' });
  });
});

describe('syncCost', () => {
  it('dice los kilobytes del delta, no los megas del catálogo', () => {
    const e = entrada(1);
    expect(syncCost(planSync('v0', e), e)).toContain('kB');
  });

  it('avisa de que la descarga completa es otra cosa', () => {
    const e = entrada(1);
    expect(syncCost({ kind: 'full', reason: 'cadena-rota' }, e)).toContain('entero');
  });

  it('cuenta los días cuando hay varios acumulados', () => {
    const e = entrada(3);
    expect(syncCost(planSync('v0', e), e)).toContain('3 días');
  });
});

describe('parseDelta', () => {
  const cabecera = {
    format: 1,
    country: 'venezuela',
    from: 'v1',
    to: 'v2',
    upserts: 2,
    deletes: 1,
    columns: ['barcode', 'name', 'brands'],
  };
  const archivo = [
    JSON.stringify(cabecera),
    JSON.stringify({ op: 'u', fts: 1, barcode: '1', name: 'Uno', brands: 'A' }),
    JSON.stringify({ op: 'u', fts: 0, barcode: '2', name: 'Dos', brands: 'B' }),
    JSON.stringify({ op: 'd', barcode: '3' }),
  ].join('\n');

  it('separa altas y bajas', () => {
    const d = parseDelta(archivo);
    expect(d.upserts).toHaveLength(2);
    expect(d.deletes).toEqual(['3']);
    expect(d.upserts[0]!.fts).toBe(1);
  });

  it('rechaza un archivo que llegó a medias', () => {
    // Aplicar medio delta dejaria la base en una version que no existe, y la
    // siguiente comparacion la creeria al dia.
    const cortado = archivo.split('\n').slice(0, 3).join('\n');
    expect(() => parseDelta(cortado)).toThrow(/incompleto/);
  });

  it('rechaza un formato que no conoce en vez de adivinar', () => {
    const futuro = JSON.stringify({ ...cabecera, format: 2 });
    expect(() => parseDelta(futuro)).toThrow(/actualizar la aplicación/);
  });
});
