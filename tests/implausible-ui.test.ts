/**
 * Test del aviso de valores imposibles, de punta a punta.
 *
 * Lo que importa aqui no es el marcado sino la decision: un dato imposible no
 * se puntua, pero tampoco desaparece. El usuario tiene el producto en la mano y
 * puede resolverlo mirando la etiqueta, asi que hay que decirselo.
 */

import { describe, expect, it } from 'vitest';
import { implausibleWarning } from '../src/ui/components.js';
import { scoreProduct, buildAdditiveClassMap } from '../src/core/scoring/engine.js';
import type { AdditiveTaxonomy } from '../src/core/scoring/additives.js';
import type { Product } from '../src/core/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const taxonomy = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/data/additives.json', import.meta.url)), 'utf8'),
) as AdditiveTaxonomy;
const ctx = { additiveTaxonomy: taxonomy, additiveClasses: buildAdditiveClassMap(taxonomy) };

const base: Product = {
  barcode: '0000000000001',
  name: 'Producto con dato imposible',
  brands: [],
  kind: 'food',
  additiveTags: [],
  allergenTags: [],
  labelTags: [],
  categoryTags: [],
  countryTags: [],
  nutriments: { sugars: 12, saturatedFat: 2, salt: 0.5, proteins: 5, fat: 8 },
  categoryFlags: {
    isBeverage: false, isWater: false, isCheese: false,
    isFatOilNutsSeeds: false, isRedMeat: false,
  },
  source: 'snapshot',
  fetchedAt: Date.now(),
  editUrl: 'https://world.openfoodfacts.org/cgi/product.pl?type=edit&code=0000000000001',
  implausibleNutriments: [
    { key: 'energy_kj', value: 19200, unit: 'kJ', reason: 'max' },
  ],
};

describe('aviso de valores imposibles', () => {
  it('nombra el nutriente, la cifra registrada y que hay que mirar el envase', () => {
    const h = implausibleWarning(base).toString();
    expect(h).toContain('valor energético');
    expect(h).toContain('19.200 kJ');
    expect(h).toContain('Comprueba la etiqueta');
  });

  it('no aparece si otro peldano cubrio el hueco', () => {
    const p: Product = {
      ...base,
      implausibleNutriments: [
        { key: 'energy_kj', value: 19200, unit: 'kJ', reason: 'max', replacedBy: 'nutriscore' },
      ],
    };
    expect(implausibleWarning(p).toString().trim()).toBe('');
  });

  it('no aparece cuando no hay nada que avisar', () => {
    const p: Product = { ...base, implausibleNutriments: undefined };
    expect(implausibleWarning(p).toString().trim()).toBe('');
  });

  it('el motor no puntua con el valor imposible y lo explica', () => {
    const score = scoreProduct(base, ctx);
    const nota = score.confidence.notes.find((n) => n.includes('imposible'));
    expect(nota).toBeDefined();
    expect(nota).toContain('19.200 kJ');
    expect(nota).toContain('Comprueba la etiqueta');
    // Con un dato asi no se puede declarar confianza alta.
    expect(score.confidence.level).not.toBe('high');
  });
});
