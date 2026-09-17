/**
 * Test de conformidad del motor Nutri-Score 2023.
 *
 * No comprueba "que no explote": comprueba que para productos reales nuestro
 * score y nuestro grado coinciden EXACTAMENTE con los que publica Open Food
 * Facts, que es quien ejecuta la implementacion de referencia.
 *
 * El fixture se genero con `scripts/fetch-fixture.mjs` contra la API real.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeGrade2023, computeNutriscore2023 } from '../src/core/scoring/nutriscore2023.js';
import { offProductToNutriscoreInput } from '../src/core/data/off.js';
import type { CategoryFlags } from '../src/core/types.js';

const fixturePath = fileURLToPath(new URL('./fixtures/off-products.json', import.meta.url));
const products = JSON.parse(readFileSync(fixturePath, 'utf8')) as OffFixtureProduct[];

interface OffFixtureProduct {
  code: string;
  product_name?: string;
  nutriscore_data: {
    score: number;
    grade: string;
    negative_points: number;
    positive_points: number;
    is_beverage?: number;
    is_water?: number;
    is_cheese?: number;
    is_fat_oil_nuts_seeds?: number;
    is_red_meat_product?: number;
    count_proteins?: number | boolean;
    components?: {
      negative?: Array<{ id: string; value: number | null; points: number }>;
      positive?: Array<{ id: string; value: number | null; points: number }>;
    };
  };
  [k: string]: unknown;
}

describe('Nutri-Score 2023: conformidad con la implementacion de referencia', () => {
  it('el fixture tiene productos de sobra para ser significativo', () => {
    expect(products.length).toBeGreaterThan(20);
  });

  describe.each(products.map((p) => [p.code, p.product_name ?? '(sin nombre)', p] as const))(
    '%s — %s',
    (_code, _name, product) => {
      const expected = product.nutriscore_data;
      const input = offProductToNutriscoreInput(product as never);
      const actual = computeNutriscore2023(input);

      it('reproduce los puntos negativos', () => {
        expect(actual.negativePoints).toBe(expected.negative_points);
      });

      it('reproduce los puntos positivos', () => {
        expect(actual.positivePoints).toBe(expected.positive_points);
      });

      it('reproduce el score final', () => {
        expect(actual.score).toBe(expected.score);
      });

      it('reproduce el grado', () => {
        expect(actual.grade).toBe(expected.grade);
      });
    },
  );
});

describe('computeGrade2023: cortes exactos por categoria', () => {
  const food: Pick<CategoryFlags, 'isBeverage' | 'isWater' | 'isFatOilNutsSeeds'> = {
    isBeverage: false,
    isWater: false,
    isFatOilNutsSeeds: false,
  };

  it('alimentos generales usa cortes inclusivos <=0 <=2 <=10 <=18', () => {
    expect(computeGrade2023(-20, food)).toBe('a');
    expect(computeGrade2023(0, food)).toBe('a');
    expect(computeGrade2023(1, food)).toBe('b');
    expect(computeGrade2023(2, food)).toBe('b');
    expect(computeGrade2023(3, food)).toBe('c');
    expect(computeGrade2023(10, food)).toBe('c');
    expect(computeGrade2023(11, food)).toBe('d');
    expect(computeGrade2023(18, food)).toBe('d');
    expect(computeGrade2023(19, food)).toBe('e');
  });

  it('el agua siempre es A, sea cual sea el score', () => {
    expect(computeGrade2023(50, { isBeverage: true, isWater: true, isFatOilNutsSeeds: false })).toBe(
      'a',
    );
  });

  it('una bebida que no es agua nunca puede ser A', () => {
    const bev = { isBeverage: true, isWater: false, isFatOilNutsSeeds: false };
    for (let s = -20; s <= 40; s++) {
      expect(computeGrade2023(s, bev)).not.toBe('a');
    }
  });

  it('grasas y aceites tienen un corte A mas exigente (<=-6)', () => {
    const fat = { isBeverage: false, isWater: false, isFatOilNutsSeeds: true };
    expect(computeGrade2023(-6, fat)).toBe('a');
    expect(computeGrade2023(-5, fat)).toBe('b');
  });
});

describe('reglas especiales del algoritmo', () => {
  const flags: CategoryFlags = {
    isBeverage: false,
    isWater: false,
    isCheese: false,
    isFatOilNutsSeeds: false,
    isRedMeat: false,
  };

  it('la carne roja limita los puntos de proteina a 2', () => {
    const base = { energy: 500, sugars: 1, saturatedFat: 2, salt: 0.5, proteins: 25, flags };
    const normal = computeNutriscore2023(base);
    const redMeat = computeNutriscore2023({ ...base, flags: { ...flags, isRedMeat: true } });
    expect(normal.components.positive.find((c) => c.id === 'proteins')?.points).toBe(7);
    expect(redMeat.components.positive.find((c) => c.id === 'proteins')?.points).toBe(2);
    expect(redMeat.proteinsLimitedReason).toBe('red_meat_product');
  });

  it('con 11 o mas puntos negativos la proteina deja de contar', () => {
    // Producto muy salado y graso: supera los 11 puntos negativos.
    const heavy = computeNutriscore2023({
      energy: 2500,
      sugars: 30,
      saturatedFat: 10,
      salt: 3,
      proteins: 20,
      flags,
    });
    expect(heavy.negativePoints).toBeGreaterThanOrEqual(11);
    expect(heavy.countProteins).toBe(false);
    expect(heavy.components.positive.map((c) => c.id)).not.toContain('proteins');
  });

  it('en quesos la proteina cuenta aunque haya muchos puntos negativos', () => {
    const cheese = computeNutriscore2023({
      energy: 1600,
      sugars: 1,
      saturatedFat: 20,
      salt: 2,
      proteins: 25,
      flags: { ...flags, isCheese: true },
    });
    expect(cheese.negativePoints).toBeGreaterThanOrEqual(11);
    expect(cheese.countProteins).toBe(true);
    expect(cheese.countProteinsReason).toBe('cheese');
  });

  it('las bebidas con edulcorante no nutritivo reciben 4 puntos negativos', () => {
    const bevFlags = { ...flags, isBeverage: true };
    const plain = computeNutriscore2023({ energy: 100, sugars: 2, salt: 0, flags: bevFlags });
    const sweetened = computeNutriscore2023({
      energy: 100,
      sugars: 2,
      salt: 0,
      nonNutritiveSweeteners: true,
      flags: bevFlags,
    });
    expect(sweetened.negativePoints - plain.negativePoints).toBe(4);
  });

  it('el ratio de grasa saturada compara con >= y no con >', () => {
    const fatFlags = { ...flags, isFatOilNutsSeeds: true };
    // 10 es exactamente el primer umbral: con >= debe dar 1 punto.
    const exact = computeNutriscore2023({
      energyFromSaturatedFat: 0,
      sugars: 0,
      saturatedFatRatio: 10,
      salt: 0,
      flags: fatFlags,
    });
    expect(exact.components.negative.find((c) => c.id === 'saturated_fat_ratio')?.points).toBe(1);
  });

  it('los nutrientes ausentes se cuentan como cero y quedan registrados', () => {
    const sparse = computeNutriscore2023({ energy: 1000, flags });
    expect(sparse.missingInputs).toContain('sugars');
    expect(sparse.missingInputs).toContain('salt');
    expect(sparse.negativePoints).toBe(2); // solo energia
  });
});
