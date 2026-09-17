/**
 * Tests de la clasificacion por prefijo GS1.
 *
 * Los casos con codigos reales salen de nuestros propios snapshots, para que
 * la tabla se valide contra datos que la aplicacion va a ver de verdad.
 */

import { describe, expect, it } from 'vitest';
import { classifyBarcode, isUnresolvable, snapshotPriority } from '../src/core/scanner/gs1.js';

describe('clasificacion por prefijo GS1', () => {
  it('reconoce los paises del catalogo', () => {
    expect(classifyBarcode('7590005008581').country).toBe('venezuela');
    expect(classifyBarcode('7501000111114').country).toBe('mexico');
    expect(classifyBarcode('7702001005611').country).toBe('colombia');
    expect(classifyBarcode('8410000000007').country).toBe('spain');
    expect(classifyBarcode('7801234567890').country).toBe('chile');
    expect(classifyBarcode('7790001234567').country).toBe('argentina');
    expect(classifyBarcode('7750001234567').country).toBe('peru');
  });

  it('reconoce Estados Unidos en sus tres rangos', () => {
    // Es el caso que importa: en Mexico casi 1 de cada 5 productos lleva
    // prefijo estadounidense por las importaciones.
    expect(classifyBarcode('0009800800124').country).toBe('united-states');
    expect(classifyBarcode('0300000000000').country).toBe('united-states');
    expect(classifyBarcode('0700000000000').country).toBe('united-states');
  });

  it('detecta los codigos de uso interno de tienda', () => {
    // El 16% del snapshot de Espana son de este tipo: no son unicos en el
    // mundo, asi que buscarlos en una base global no tiene sentido.
    for (const code of ['2300001234567', '2000001234567', '2999991234567']) {
      const info = classifyBarcode(code);
      expect(info.kind).toBe('store-internal');
      expect(info.note).toContain('no es único en el mundo');
    }
    expect(isUnresolvable('2300001234567')).toBe(true);
  });

  it('detecta lo que no es un producto alimenticio', () => {
    expect(classifyBarcode('9780306406157').kind).toBe('book');
    expect(classifyBarcode('9771234567003').kind).toBe('magazine');
    expect(classifyBarcode('9812345678901').kind).toBe('coupon');
    expect(classifyBarcode('9801234567890').kind).toBe('refund');
  });

  it('un producto normal es resoluble', () => {
    expect(isUnresolvable('8410000000007')).toBe(false);
    expect(isUnresolvable('0009800800124')).toBe(false);
  });

  it('prioriza el pais del usuario por delante del prefijo', () => {
    // El del usuario va primero porque es el que tiene descargado y funciona
    // sin conexion, aunque el prefijo sugiera otro.
    expect(snapshotPriority('0009800800124', 'venezuela')).toEqual([
      'venezuela',
      'united-states',
    ]);
    expect(snapshotPriority('7590005008581', 'venezuela')).toEqual(['venezuela']);
    expect(snapshotPriority('8410000000007')).toEqual(['spain']);
  });

  it('no se rompe con entradas raras', () => {
    expect(classifyBarcode('').kind).toBe('unknown');
    expect(classifyBarcode('123').kind).toBe('unknown');
    expect(classifyBarcode('96385074').kind).toBe('product'); // EAN-8
  });
});
