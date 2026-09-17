/**
 * Tests de la escalera de nutrientes.
 *
 * Lo que se prueba aqui es la lectura del formato de Open Food Facts, que no es
 * uno solo: el mismo nutriente puede venir en cinco variantes, y el volcado
 * nocturno suele traer justo las que NO son la preferida. Cada caso de abajo
 * sale de un producto real del volcado, no de un supuesto.
 *
 * La referencia es el esquema oficial, `docs/api/ref/schemas/product_nutrition.yaml`,
 * donde `_100g`, `_serving` y `_value` figuran como `readOnly: true` y calculados.
 */

import { describe, expect, it } from 'vitest';
import { leerNutrientes } from '../scripts/lib/nutrients.mjs';

describe('escalera de nutrientes', () => {
  it('prefiere _100g cuando existe, que es el campo normalizado', () => {
    const { valores, origenes } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { 'energy-kj_100g': 1659, 'energy-kj': 999, sugars_100g: 12.5 },
    });
    expect(valores.energy_kj).toBe(1659);
    expect(valores.sugars).toBe(12.5);
    expect(origenes.energy_kj).toBe('100g');
  });

  it('cae al campo sin sufijo cuando falta _100g y la base son 100 g', () => {
    // Caso real: 00010474, con `energy`, `salt` y `energy-kcal` pero ningun _100g.
    const { valores, origenes } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { energy: 1500, 'energy-kcal': 358, salt: 0.5, fiber_value: 2, fiber_unit: 'g' },
    });
    expect(valores.energy_kj).toBe(1500);
    expect(valores.energy_kcal).toBe(358);
    expect(valores.salt).toBe(0.5);
    expect(origenes.energy_kj).toBe('sin-sufijo');
  });

  it('el campo `energy` sin sufijo se interpreta en kJ, no en la unidad de energy_unit', () => {
    // El esquema: "energy [...] in kj". `energy_unit` describe `energy_value`.
    const { valores } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { energy: 1500, energy_unit: 'kcal' },
    });
    expect(valores.energy_kj).toBe(1500);
    expect(valores.energy_kcal).toBeCloseTo(1500 / 4.184, 6);
  });

  it('convierte _value con su _unit, incluidas grafias no latinas', () => {
    const { valores, origenes } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { sodium_value: 400, sodium_unit: 'mg', salt_value: 250, salt_unit: 'мг' },
    });
    expect(valores.sodium).toBeCloseTo(0.4, 9);
    expect(valores.salt).toBeCloseTo(0.25, 9);
    expect(origenes.sodium).toBe('value');
  });

  it('descarta unidades que no son convertibles de forma reproducible', () => {
    // `dv` (ingesta diaria recomendada) depende del nutriente y del pais.
    const { valores } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { fiber_value: 20, fiber_unit: 'dv' },
    });
    expect(valores.fiber).toBeNull();
  });

  it('usa nutriscore_data.components cuando nutriments viene vacio', () => {
    // Caso real: productos espanoles del volcado, con `nutriments: {}` pero
    // `nutriscore_data` completo.
    const { valores, origenes } = leerNutrientes({
      nutriments: {},
      nutriscore_data: {
        components: {
          negative: [
            { id: 'energy', value: 2524, unit: 'kJ', points: 10 },
            { id: 'sugars', value: 32, unit: 'g', points: 12 },
            { id: 'salt', value: 0.01, unit: 'g', points: 0 },
          ],
          positive: [{ id: 'fruits_vegetables_legumes', value: 0, unit: '%', points: 0 }],
        },
      },
    });
    expect(valores.energy_kj).toBe(2524);
    expect(valores.sugars).toBe(32);
    expect(valores.salt).toBe(0.01);
    expect(valores.fvl).toBe(0);
    expect(origenes.energy_kj).toBe('nutriscore');
  });

  it('prefiere nutriscore_data a escalar por racion, porque no exige cuentas nuestras', () => {
    const { origenes } = leerNutrientes({
      nutrition_data_per: 'serving',
      serving_quantity: 30,
      nutriments: { energy: 600 },
      nutriscore_data: { components: { negative: [{ id: 'energy', value: 2000, unit: 'kJ' }] } },
    });
    expect(origenes.energy_kj).toBe('nutriscore');
  });

  it('escala por racion cuando es lo unico que hay', () => {
    const { valores, origenes } = leerNutrientes({
      nutrition_data_per: 'serving',
      serving_quantity: 34,
      nutriments: { energy: 500, proteins: 3 },
    });
    expect(valores.energy_kj).toBeCloseTo(1470.588, 3);
    expect(valores.proteins).toBeCloseTo(8.8235, 3);
    expect(origenes.energy_kj).toBe('sin-sufijo-racion');
  });

  it('rechaza el escalado cuando sale de las cotas fisicas', () => {
    // Bolsita de te de 1 g: escalar por racion daba 117.200 kJ/100 g.
    // Que Open Food Facts no publique `_100g` -pudiendo calcularlo- es la
    // senal de que descarto el dato.
    const { valores } = leerNutrientes({
      nutrition_data_per: 'serving',
      serving_quantity: 1,
      nutriments: { energy: 1172 },
    });
    expect(valores.energy_kj).toBeNull();
  });

  it('no deja pasar mas de 100 g de un nutriente por 100 g de producto', () => {
    const { valores } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { proteins_100g: 4444, sugars_100g: 30 },
    });
    expect(valores.proteins).toBeNull();
    expect(valores.sugars).toBe(30);
  });

  it('completa sal desde sodio y energia entre kJ y kcal', () => {
    const { valores, origenes } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { sodium_100g: 0.4, 'energy-kcal_100g': 250 },
    });
    expect(valores.salt).toBeCloseTo(1, 9);
    expect(valores.energy_kj).toBeCloseTo(1046, 6);
    expect(origenes.salt).toBe('100g:sodio');
    expect(origenes.energy_kj).toBe('100g:kcal');
  });

  it('no inventa una sal disparatada a partir de un sodio disparatado', () => {
    const { valores } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { sodium_100g: 60 }, // x2.5 = 150 g de sal por 100 g
    });
    expect(valores.sodium).toBe(60);
    expect(valores.salt).toBeNull();
  });

  it('distingue la ausencia declarada de la ausencia por fallo de exportacion', () => {
    expect(leerNutrientes({ no_nutrition_data: 'on', nutriments: {} }).sinDatos).toBe(true);
    expect(leerNutrientes({ nutriments: {} }).sinDatos).toBe(false);
  });

  it('ignora los valores del producto preparado, que no es el producto tal como se vende', () => {
    const { valores } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { 'energy-kj_prepared_100g': 200, sugars_prepared_100g: 1 },
    });
    expect(valores.energy_kj).toBeNull();
    expect(valores.sugars).toBeNull();
  });

  it('no se rompe con un producto sin nutriments', () => {
    const { valores, origenes } = leerNutrientes({ code: '123' });
    expect(valores.energy_kj).toBeNull();
    expect(Object.keys(origenes)).toHaveLength(0);
  });
});

describe('respaldos del porcentaje de frutas y verduras', () => {
  it('prefiere el campo de legumbres, que es el del Nutri-Score de 2023', () => {
    const { valores } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: {
        'fruits-vegetables-legumes-estimate-from-ingredients_100g': 40,
        'fruits-vegetables-nuts-estimate-from-ingredients_100g': 12,
      },
    });
    expect(valores.fvl).toBe(40);
  });

  it('cae al campo de 2021 cuando el de 2023 no esta', () => {
    const { valores } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { 'fruits-vegetables-nuts-estimate-from-ingredients_100g': 12 },
    });
    expect(valores.fvl).toBe(12);
  });
});

describe('coherencia del escalado por racion', () => {
  it('si el factor da una energia imposible, no se usa para NINGUN nutriente', () => {
    // Bolsita de te de 1 g: 1172 kJ por racion -> 117.200 kJ/100 g, y a la vez
    // 0,75 g de sal -> 75 g/100 g. La sal cabe en la cota fisica, pero viene
    // del mismo factor equivocado, asi que tampoco vale.
    const { valores } = leerNutrientes({
      nutrition_data_per: 'serving',
      serving_quantity: 1,
      nutriments: { energy: 1172, salt: 0.75, proteins: 2 },
    });
    expect(valores.energy_kj).toBeNull();
    expect(valores.salt).toBeNull();
    expect(valores.proteins).toBeNull();
  });

  it('si el factor da una energia posible, se usa con normalidad', () => {
    const { valores } = leerNutrientes({
      nutrition_data_per: 'serving',
      serving_quantity: 34,
      nutriments: { energy: 500, salt: 0.2 },
    });
    expect(valores.energy_kj).toBeCloseTo(1470.588, 3);
    expect(valores.salt).toBeCloseTo(0.588, 3);
  });

  it('sin energia con que contrastar, se escala igualmente', () => {
    const { valores } = leerNutrientes({
      nutrition_data_per: 'serving',
      serving_quantity: 50,
      nutriments: { proteins: 4 },
    });
    expect(valores.proteins).toBe(8);
  });
});

describe('los valores imposibles no se descartan, se marcan', () => {
  it('la escalera sigue bajando y anota lo que rechazo', () => {
    // `_100g` imposible, pero `nutriscore_data` tiene el valor bueno.
    const { valores, origenes, imposibles } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { 'energy-kj_100g': 19200 },
      nutriscore_data: { components: { negative: [{ id: 'energy', value: 1941, unit: 'kJ' }] } },
    });
    expect(valores.energy_kj).toBe(1941);
    expect(origenes.energy_kj).toBe('nutriscore');
    expect(imposibles).toHaveLength(1);
    expect(imposibles[0]).toMatchObject({
      nutriente: 'energy_kj',
      valor: 19200,
      motivo: 'supera-maximo-fisico',
      sustituido: 'nutriscore',
    });
  });

  it('cuando ningun peldano lo salva, queda sin sustituto', () => {
    const { valores, imposibles } = leerNutrientes({
      nutrition_data_per: '100g',
      nutriments: { 'energy-kj_100g': 19200 },
    });
    expect(valores.energy_kj).toBeNull();
    expect(imposibles[0]).toMatchObject({ valor: 19200, sustituido: null });
  });

  it('registra el valor imposible de cada nutriente afectado por una racion mala', () => {
    const { imposibles } = leerNutrientes({
      nutrition_data_per: 'serving',
      serving_quantity: 1,
      nutriments: { energy: 1172, salt: 0.75 },
    });
    const claves = imposibles.map((x) => x.nutriente).sort();
    expect(claves).toEqual(['energy_kj', 'salt']);
    expect(imposibles.find((x) => x.nutriente === 'salt')).toMatchObject({
      valor: 75,
      motivo: 'racion-incoherente',
    });
  });
});
