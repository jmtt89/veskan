/**
 * Catálogos partidos en varios SQLite.
 *
 * Un catálogo de más de 100 MB no se puede publicar en GitHub, así que se parte
 * por rango de código de barras. El enrutado tiene que ser exacto: mandar un
 * código a la parte equivocada no da un error, da un «no encontrado», que es
 * mucho peor porque parece que el producto no existe.
 */

import { describe, expect, it } from 'vitest';
import {
  partFor,
  partsOf,
  type SnapshotCountryEntry,
  type SnapshotPart,
} from '../src/core/data/sqlite-http/snapshot-index.js';
import { planSync } from '../src/core/data/sqlite-http/delta-sync.js';

/** Los cortes reales que produjo partir el catálogo español de 76,6 MB. */
const PARTES: SnapshotPart[] = [
  { file: 'spain-01.sqlite3', from: null, to: '737027708122001302', products: 113188, bytes: 26890240 },
  { file: 'spain-02.sqlite3', from: '737027708122001302', to: '8424771041116', products: 113188, bytes: 27049984 },
  { file: 'spain-03.sqlite3', from: '8424771041116', to: null, products: 113186, bytes: 26439680 },
];

describe('partsOf', () => {
  it('normaliza el catálogo de un solo archivo a una parte', () => {
    const e: SnapshotCountryEntry = { file: 'venezuela.sqlite3', products: 1516, bytes: 540672 };
    const p = partsOf(e);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ file: 'venezuela.sqlite3', from: null, to: null });
  });

  it('arrastra la cadena de deltas del catálogo entero a esa única parte', () => {
    const deltas = [{ from: 'v1', to: 'v2', file: 'd.gz', bytes: 900, upserts: 1, deletes: 0 }];
    const e: SnapshotCountryEntry = { file: 'x.sqlite3', products: 1, bytes: 1, deltas };
    expect(partsOf(e)[0]!.deltas).toBe(deltas);
  });
});

describe('partFor', () => {
  it('manda cada código a una sola parte', () => {
    // El límite pertenece a la parte de la DERECHA: [desde, hasta).
    expect(partFor(PARTES, '0000000000001')!.file).toBe('spain-01.sqlite3');
    expect(partFor(PARTES, '737027708122001301')!.file).toBe('spain-01.sqlite3');
    expect(partFor(PARTES, '737027708122001302')!.file).toBe('spain-02.sqlite3');
    expect(partFor(PARTES, '8424771041115')!.file).toBe('spain-02.sqlite3');
    expect(partFor(PARTES, '8424771041116')!.file).toBe('spain-03.sqlite3');
    expect(partFor(PARTES, '9999999999999')!.file).toBe('spain-03.sqlite3');
  });

  it('los rangos cubren todo y no se solapan', () => {
    // Cualquier código cae en exactamente una parte. Un hueco sería un producto
    // inencontrable; un solape, dos respuestas distintas para el mismo código.
    const muestras = [
      '0', '00000106', '12345670', '7501000111114', '737027708122001302',
      '8424771041116', '84', 'zzzz', '9'.repeat(18),
    ];
    for (const c of muestras) {
      const encontradas = PARTES.filter(
        (p) => (p.from === null || c >= p.from) && (p.to === null || c < p.to),
      );
      expect(encontradas, `código ${c}`).toHaveLength(1);
    }
  });

  it('compara como cadenas, igual que SQLite', () => {
    // Si se comparara como número, «9» iría después de «10» y el corte caería
    // en otro sitio que el que usó el pipeline al partir la tabla.
    expect('9' > '10').toBe(true);
    expect(partFor(PARTES, '9')!.file).toBe('spain-03.sqlite3');
    expect(partFor(PARTES, '10')!.file).toBe('spain-01.sqlite3');
  });

  it('un catálogo de una sola parte se lo queda todo', () => {
    const una = partsOf({ file: 'x.sqlite3', products: 1, bytes: 1 });
    expect(partFor(una, '7501000111114')!.file).toBe('x.sqlite3');
    expect(partFor(una, '0')!.file).toBe('x.sqlite3');
  });
});

describe('plan de actualización con varias partes', () => {
  /**
   * Cada parte lleva su propia cadena de deltas, pero la decisión es del
   * catálogo entero: las partes tienen que quedar en la MISMA versión. Si una
   * se queda atrás, un producto mostraría datos de anteayer según en qué rango
   * caiga su código, y eso es peor que no actualizar.
   */
  const conDeltas = (n: number, bytes: number) => [
    { from: 'v1', to: 'v2', file: `d${n}.gz`, bytes, upserts: 1, deletes: 0 },
  ];

  /** Reproduce lo que hace `CatalogManager.planFor`, que no es exportable. */
  const planCatalogo = (local: string | undefined, entry: SnapshotCountryEntry) => {
    const planes = partsOf(entry).map((parte) =>
      planSync(local, { ...entry, bytes: parte.bytes, deltas: parte.deltas }),
    );
    const completo = planes.find((p) => p.kind === 'full');
    if (completo) return completo;
    if (planes.every((p) => p.kind === 'up-to-date')) return { kind: 'up-to-date' as const };
    const chain = planes.flatMap((p) => (p.kind === 'deltas' ? p.chain : []));
    return { kind: 'deltas' as const, chain, bytes: chain.reduce((t, d) => t + d.bytes, 0) };
  };

  const entrada = (partes: Array<{ bytes: number; deltas?: ReturnType<typeof conDeltas> }>) =>
    ({
      products: 339562,
      bytes: partes.reduce((t, p) => t + p.bytes, 0),
      version: 'v2',
      parts: partes.map((p, i) => ({
        file: `spain-0${i + 1}.sqlite3`,
        from: null,
        to: null,
        products: 1,
        bytes: p.bytes,
        deltas: p.deltas,
      })),
    }) as SnapshotCountryEntry;

  it('suma el coste de todas las partes que cambiaron', () => {
    const e = entrada([
      { bytes: 26890240, deltas: conDeltas(1, 311) },
      { bytes: 27049984, deltas: conDeltas(2, 5446) },
      { bytes: 26439680, deltas: conDeltas(3, 314) },
    ]);
    const plan = planCatalogo('v1', e);
    expect(plan.kind).toBe('deltas');
    if (plan.kind !== 'deltas') return;
    // Los 6 kB reales que costó una noche del catálogo español partido.
    expect(plan.bytes).toBe(311 + 5446 + 314);
    expect(plan.chain).toHaveLength(3);
  });

  it('si a UNA parte le falta el eslabón, se baja el catálogo entero', () => {
    const e = entrada([
      { bytes: 26890240, deltas: conDeltas(1, 311) },
      { bytes: 27049984, deltas: [] }, // esta se quedó sin delta
      { bytes: 26439680, deltas: conDeltas(3, 314) },
    ]);
    expect(planCatalogo('v1', e).kind).toBe('full');
  });

  it('al día solo si lo están TODAS', () => {
    const e = entrada([{ bytes: 1 }, { bytes: 1 }]);
    expect(planCatalogo('v2', e).kind).toBe('up-to-date');
  });
});
