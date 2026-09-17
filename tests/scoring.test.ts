/**
 * Tests del resto del motor de puntuacion.
 *
 * Los umbrales de la OPS se comprueban justo en el borde: son criterios
 * regulatorios "igual o mayor que", y equivocar un `>` por un `>=` cambiaria el
 * veredicto de productos reales.
 */

import { describe, expect, it } from 'vitest';
import { estimateFreeSugars, evaluatePaho } from '../src/core/scoring/paho.js';
import { assessAdditives, type AdditiveTaxonomy } from '../src/core/scoring/additives.js';
import { scoreProduct, buildAdditiveClassMap } from '../src/core/scoring/engine.js';
import { assessCosmetic, parseInciList } from '../src/core/scoring/cosmetics.js';
import { hasUsableData } from '../src/core/data/repository.js';
import { inferNova } from '../src/core/scoring/nova.js';
import type { Nutriments, Product } from '../src/core/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const taxonomy = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/data/additives.json', import.meta.url)), 'utf8'),
) as AdditiveTaxonomy;

const baseProduct = (over: Partial<Product> = {}): Product => ({
  barcode: '0000000000000',
  name: 'Producto de prueba',
  brands: [],
  kind: 'food',
  additiveTags: [],
  allergenTags: [],
  labelTags: [],
  categoryTags: [],
  countryTags: [],
  nutriments: {},
  categoryFlags: {
    isBeverage: false,
    isWater: false,
    isCheese: false,
    isFatOilNutsSeeds: false,
    isRedMeat: false,
  },
  source: 'openfoodfacts',
  ...over,
});

describe('Modelo de perfil de nutrientes de la OPS', () => {
  // 100 kcal por 100 g simplifica: 1 g de grasa = 9% de la energia.
  const per100 = (n: Partial<Nutriments>): Nutriments => ({ energyKcal: 100, ...n });

  it('sodio: el criterio es 1 mg por kcal, inclusivo', () => {
    const justUnder = evaluatePaho({ nutriments: per100({ sodium: 99 }), hasSweeteners: false });
    const exact = evaluatePaho({ nutriments: per100({ sodium: 100 }), hasSweeteners: false });
    expect(justUnder.seals.find((s) => s.id === 'sodium')?.exceeded).toBe(false);
    expect(exact.seals.find((s) => s.id === 'sodium')?.exceeded).toBe(true);
  });

  it('grasas saturadas: 10% de la energia, inclusivo', () => {
    // 1.11 g x 9 kcal = 9.99% -> no excede; 1.12 g = 10.08% -> excede
    const under = evaluatePaho({ nutriments: per100({ saturatedFat: 1.11 }), hasSweeteners: false });
    const over = evaluatePaho({ nutriments: per100({ saturatedFat: 1.12 }), hasSweeteners: false });
    expect(under.seals.find((s) => s.id === 'saturated-fat')?.exceeded).toBe(false);
    expect(over.seals.find((s) => s.id === 'saturated-fat')?.exceeded).toBe(true);
  });

  it('grasas totales: el umbral es 30% de la energia', () => {
    const under = evaluatePaho({ nutriments: per100({ fat: 3.3 }), hasSweeteners: false });
    const over = evaluatePaho({ nutriments: per100({ fat: 3.4 }), hasSweeteners: false });
    expect(under.seals.find((s) => s.id === 'total-fat')?.exceeded).toBe(false);
    expect(over.seals.find((s) => s.id === 'total-fat')?.exceeded).toBe(true);
  });

  it('grasas trans: el umbral es 1% de la energia', () => {
    const over = evaluatePaho({ nutriments: per100({ transFat: 0.12 }), hasSweeteners: false });
    expect(over.seals.find((s) => s.id === 'trans-fat')?.exceeded).toBe(true);
  });

  it('cualquier edulcorante dispara el aviso', () => {
    const r = evaluatePaho({ nutriments: per100({}), hasSweeteners: true });
    expect(r.seals.find((s) => s.id === 'sweeteners')?.exceeded).toBe(true);
  });

  it('no se aplica a alimentos sin procesar (NOVA 1 y 2)', () => {
    const r = evaluatePaho({
      nutriments: per100({ saturatedFat: 20 }),
      novaGroup: 1,
      hasSweeteners: false,
    });
    expect(r.applicable).toBe(false);
    expect(r.exceededCount).toBe(0);
  });

  it('los azucares libres se estiman descontando la fruta, y queda marcado', () => {
    expect(estimateFreeSugars({ sugars: 10 })).toEqual({ value: 10, estimated: true });
    expect(estimateFreeSugars({ sugars: 10, fruitsVegetablesLegumes: 100 })).toEqual({
      value: 0,
      estimated: true,
    });
    expect(estimateFreeSugars({ sugars: 10, freeSugars: 4 })).toEqual({
      value: 4,
      estimated: false,
    });
  });
});

describe('Aditivos', () => {
  it('E250 sale como riesgo alto con los grupos que superan la IDA', () => {
    const r = assessAdditives(['en:e250'], taxonomy);
    const e250 = r.assessments[0]!;
    expect(e250.risk).toBe('high');
    expect(e250.ansesOfInterest).toBe(true);
    expect(e250.overexposedGroupsMean).toContain('en:children');
    expect(e250.penalty).toBeGreaterThan(25);
  });

  it('E951 (aspartamo) no tiene riesgo de sobreexposicion segun EFSA', () => {
    const r = assessAdditives(['en:e951'], taxonomy);
    expect(r.assessments[0]!.risk).toBe('none');
    expect(r.assessments[0]!.penalty).toBe(0);
  });

  it('acumular aditivos penaliza cada vez menos', () => {
    const uno = assessAdditives(['en:e250'], taxonomy).totalPenalty;
    const cinco = assessAdditives(
      ['en:e250', 'en:e250', 'en:e250', 'en:e250', 'en:e250'],
      taxonomy,
    ).totalPenalty;
    expect(cinco).toBeGreaterThan(uno);
    // Sin amortiguamiento serian 5x; con el, menos de 3x.
    expect(cinco).toBeLessThan(uno * 3);
  });

  it('un aditivo sin evaluar penaliza poco, no se le presume culpable', () => {
    const r = assessAdditives(['en:e999999'], taxonomy);
    expect(r.assessments[0]!.risk).toBe('unknown');
    expect(r.assessments[0]!.penalty).toBeLessThan(3);
  });

  it('la puntuacion del bloque nunca sale del rango 0-100', () => {
    const muchos = Array.from({ length: 40 }, () => 'en:e250');
    const r = assessAdditives(muchos, taxonomy);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('Motor combinado', () => {
  const ctx = { additiveTaxonomy: taxonomy, additiveClasses: buildAdditiveClassMap(taxonomy) };

  it('una manzana puntua mucho mas alto que un refresco azucarado', () => {
    const manzana = scoreProduct(
      baseProduct({
        name: 'Manzana',
        novaGroup: 1,
        nutriments: {
          energyKj: 218, energyKcal: 52, sugars: 10, fat: 0.2, saturatedFat: 0,
          fiber: 2.4, proteins: 0.3, salt: 0, sodium: 0, fruitsVegetablesLegumes: 100,
        },
      }),
      ctx,
    );
    const refresco = scoreProduct(
      baseProduct({
        name: 'Refresco de cola',
        novaGroup: 4,
        additiveTags: ['en:e150d', 'en:e338'],
        categoryFlags: { isBeverage: true, isWater: false, isCheese: false, isFatOilNutsSeeds: false, isRedMeat: false },
        nutriments: {
          energyKj: 180, energyKcal: 42, sugars: 10.6, fat: 0, saturatedFat: 0,
          proteins: 0, salt: 0, sodium: 0,
        },
      }),
      ctx,
    );
    expect(manzana.value).toBeGreaterThan(refresco.value);
    expect(manzana.value).toBeGreaterThan(70);
    expect(refresco.value).toBeLessThan(45);
  });

  it('la puntuacion siempre cae en 0-100', () => {
    const extremo = scoreProduct(
      baseProduct({
        novaGroup: 4,
        additiveTags: Array.from({ length: 25 }, () => 'en:e250'),
        nutriments: { energyKj: 3500, energyKcal: 836, sugars: 80, fat: 60, saturatedFat: 40, salt: 8, sodium: 3200 },
      }),
      ctx,
    );
    expect(extremo.value).toBeGreaterThanOrEqual(0);
    expect(extremo.value).toBeLessThanOrEqual(100);
  });

  it('sin datos, la confianza se declara insuficiente', () => {
    const vacio = scoreProduct(baseProduct({ nutriments: {} }), ctx);
    expect(['low', 'insufficient']).toContain(vacio.confidence.level);
    expect(vacio.confidence.missing.length).toBeGreaterThan(3);
  });

  it('los pesos de los bloques suman el 100%', () => {
    const s = scoreProduct(baseProduct({ nutriments: { energyKj: 500 } }), ctx);
    const total = s.breakdown.reduce((acc, b) => acc + b.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('no existe el tope duro de 49 que aplica Yuka', () => {
    // Un producto por lo demas excelente con un aditivo de riesgo alto debe
    // poder superar 49: la penalizacion es gradual, no un techo arbitrario.
    const s = scoreProduct(
      baseProduct({
        novaGroup: 1,
        additiveTags: ['en:e250'],
        nutriments: {
          energyKj: 400, energyKcal: 96, sugars: 1, fat: 1, saturatedFat: 0.3,
          fiber: 5, proteins: 20, salt: 0.2, sodium: 80, fruitsVegetablesLegumes: 90,
        },
      }),
      ctx,
    );
    expect(s.value).toBeGreaterThan(49);
  });
});

describe('NOVA', () => {
  const classes = buildAdditiveClassMap(taxonomy);

  it('respeta el grupo que ya trae Open Food Facts', () => {
    const r = inferNova(baseProduct({ novaGroup: 2 }), classes);
    expect(r).toEqual({ group: 2, fromSource: true, reasons: [] });
  });

  it('infiere NOVA 4 ante un marcador de ultraprocesamiento', () => {
    const r = inferNova(
      baseProduct({ ingredientsText: 'Agua, jarabe de glucosa, sal' }),
      classes,
    );
    expect(r?.group).toBe(4);
    expect(r?.fromSource).toBe(false);
    expect(r?.reasons[0]).toContain('jarabe de glucosa');
  });

  it('sin marcadores no se inventa un grupo', () => {
    expect(inferNova(baseProduct({ ingredientsText: 'Tomate, sal' }), classes)).toBeUndefined();
  });
});

describe('Cosmetica', () => {
  it('trocea una lista INCI normalizando acentos y mayusculas', () => {
    const list = parseInciList('INGREDIENTS: Aqua, Glycerin, LIMONENE, Parfum.');
    expect(list).toEqual(['aqua', 'glycerin', 'limonene', 'parfum']);
  });

  it('marca una sustancia prohibida del Anexo II', () => {
    const r = assessCosmetic(
      baseProduct({ kind: 'cosmetic', ingredientsText: 'Aqua, Butylphenyl Methylpropional, Parfum' }),
    );
    expect(r.flags.some((f) => f.severity === 'prohibited')).toBe(true);
  });

  it('detecta alergenos de fragancia de declaracion obligatoria', () => {
    const r = assessCosmetic(
      baseProduct({ kind: 'cosmetic', ingredientsText: 'Aqua, Glycerin, Limonene, Linalool' }),
    );
    expect(r.flags.filter((f) => f.severity === 'allergen')).toHaveLength(2);
  });

  it('avisa cuando no hay lista INCI, en vez de dar por buena la formula', () => {
    const r = assessCosmetic(baseProduct({ kind: 'cosmetic' }));
    expect(r.hasFullInciList).toBe(false);
    expect(r.confidence.level).toBe('insufficient');
  });
});

describe('Deteccion de productos sin datos utiles', () => {
  it('rechaza el registro fantasma real 7502219553429', () => {
    // Caso comprobado contra la API: status 1, pero todo vacio.
    const fantasma = baseProduct({ barcode: '7502219553429', name: '', nutriments: {}, novaGroup: 2 });
    expect(hasUsableData(fantasma)).toBe(false);
  });

  it('acepta un producto con nombre y nutrientes', () => {
    expect(hasUsableData(baseProduct({ name: 'Leche', nutriments: { energyKcal: 64 } }))).toBe(true);
  });

  it('acepta un producto con nombre e ingredientes aunque falte la tabla', () => {
    expect(hasUsableData(baseProduct({ name: 'Pan', ingredientsText: 'Harina, agua, sal' }))).toBe(true);
  });

  it('rechaza un producto con nutrientes pero sin nombre', () => {
    expect(hasUsableData(baseProduct({ name: undefined, nutriments: { energyKcal: 64 } }))).toBe(false);
  });
});
