/**
 * Tests de las dos formas de "no lo sabemos del todo".
 *
 * El principio es informar, no eliminar: el valor se usa igual y la nota se
 * calcula con el, pero la ficha dice de que tipo es. Medido sobre el volcado
 * completo, el porcentaje de frutas y verduras es una estimacion el 100% de las
 * veces, la sal esta calculada en el 87,9% y la energia va marcada como
 * aproximada en el 83,1%: presentarlos como valores de etiqueta seria fingir
 * una precision que no tienen.
 */

import { describe, expect, it } from 'vitest';
import { leerNutrientes } from '../scripts/lib/nutrients.mjs';
import { scoreProduct, buildAdditiveClassMap } from '../src/core/scoring/engine.js';
import type { AdditiveTaxonomy } from '../src/core/scoring/additives.js';
import type { Product } from '../src/core/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const taxonomy = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/data/additives.json', import.meta.url)), 'utf8'),
) as AdditiveTaxonomy;
const ctx = { additiveTaxonomy: taxonomy, additiveClasses: buildAdditiveClassMap(taxonomy) };

const producto = (extra: Partial<Product> = {}): Product => ({
  barcode: '0000000000001', name: 'Producto', brands: [], kind: 'food',
  additiveTags: [], allergenTags: [], labelTags: [], categoryTags: [], countryTags: [],
  nutriments: { energyKj: 1490, sugars: 5, saturatedFat: 1, salt: 0.5, proteins: 7, fat: 3, fiber: 2 },
  categoryFlags: { isBeverage: false, isWater: false, isCheese: false, isFatOilNutsSeeds: false, isRedMeat: false },
  categoryFlagsSource: 'prueba',
  source: 'snapshot', fetchedAt: Date.now(),
  ...extra,
});

describe('marcas de procedencia del valor', () => {
  it('distingue estimado, calculado y aproximado', () => {
    const { estimados, valores } = leerNutrientes({
      nutriments: {},
      nutrition: { aggregated_set: { nutrients: {
        energy: { value: 1659, unit: 'kJ', source: 'packaging', modifier: '~' },
        salt: { value_computed: 0.33, unit: 'g', source: 'packaging' },
        'fruits-vegetables-legumes': { value: 12.5, unit: '%', source: 'estimate' },
        fat: { value: 4.4, unit: 'g', source: 'packaging' },
      } } },
    });
    expect(estimados).toEqual({ energy_kj: 'approx', salt: 'computed', fvl: 'estimate' });
    // Y lo importante: los valores se conservan, no se descartan.
    expect(valores.energy_kj).toBe(1659);
    expect(valores.salt).toBe(0.33);
    expect(valores.fvl).toBe(12.5);
    expect(valores.fat).toBe(4.4);
    expect(estimados).not.toHaveProperty('fat');
  });

  it('solo marca el nutriente si el valor vino de esa fuente', () => {
    // El `_100g` gana, asi que la marca de v3 no aplica a ese nutriente.
    const { origenes, estimados } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { 'energy-kj_100g': 800 },
      nutrition: { aggregated_set: { nutrients: { energy: { value: 1659, unit: 'kJ', modifier: '~' } } } },
    });
    expect(origenes.energy_kj).toBe('100g');
    expect(estimados).not.toHaveProperty('energy_kj');
  });

  it('el motor avisa de los estimados sin dejar de puntuar', () => {
    const s = scoreProduct(producto({ estimatedNutriments: { fvl: 'estimate' } }), ctx);
    expect(s.value).toBeGreaterThan(0);
    expect(s.confidence.notes.some((n) => n.includes('deduce de la lista de ingredientes'))).toBe(true);
  });

  it('el motor distingue calculado de estimado', () => {
    const s = scoreProduct(producto({ estimatedNutriments: { salt: 'computed' } }), ctx);
    expect(s.confidence.notes.some((n) => n.includes('calculado a partir de otros datos'))).toBe(true);
  });
});

describe('banderas de categoria desconocidas', () => {
  it('avisa cuando no se sabe la categoria, y sigue puntuando', () => {
    const p = producto();
    delete (p as { categoryFlagsSource?: string }).categoryFlagsSource;
    const s = scoreProduct(p, ctx);
    expect(s.value).toBeGreaterThan(0);
    expect(s.confidence.notes.some((n) => n.includes('categoria del producto'))).toBe(true);
    expect(s.confidence.level).not.toBe('high');
  });

  it('no avisa cuando si se sabe', () => {
    const s = scoreProduct(producto(), ctx);
    expect(s.confidence.notes.some((n) => n.includes('categoria del producto'))).toBe(false);
  });
});
