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
