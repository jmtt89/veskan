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
  // Las muestras fijan las banderas a mano, asi que su origen es conocido. Sin
  // esto el motor avisaria -con razon- de que no sabe si el producto es una
  // bebida, y el Nutri-Score usa umbrales distintos segun la categoria.
  categoryFlagsSource: 'prueba',
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
  });

  it('el unico cero es no llevar aditivos', () => {
    // Un aditivo evaluado y sin problemas penaliza POCO, pero penaliza:
    // llevarlo no es lo mismo que no llevarlo. La version anterior le daba
    // cero a `risk: none`, y por eso el amaranto -prohibido en Estados Unidos
    // desde 1976- puntuaba 0.
    expect(assessAdditives([], taxonomy).totalPenalty).toBe(0);
    expect(assessAdditives([], taxonomy).score).toBe(100);
    for (const tag of ['en:e951', 'en:e330', 'en:e300', 'en:e999999']) {
      const r = assessAdditives([tag], taxonomy);
      expect(r.totalPenalty).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(100);
    }
  });

  it('un aditivo prohibido pesa mas que cualquier otra senal', () => {
    // Que este prohibido en alguna jurisdiccion no se modula por region: una
    // prohibicion no se decreta sin expediente detras.
    const prohibido = assessAdditives(['en:e171'], taxonomy).assessments[0]!;
    const altoRiesgo = assessAdditives(['en:e250'], taxonomy).assessments[0]!;
    expect(prohibido.banned).toBe(true);
    expect(prohibido.penaltyReason).toBe('banned');
    expect(prohibido.bans.length).toBeGreaterThan(0);
    expect(prohibido.penalty).toBeGreaterThan(altoRiesgo.penalty);
  });

  it('el peligro fija el peldaño y la exposicion es un recargo encima', () => {
    // `riesgo = peligro x exposicion`. No son dos candidatos entre los que
    // elegir: el peligro dice a que peldaño va y la exposicion dice si la
    // gente llega de verdad a esa dosis.
    //
    // La carragenina lo enseña: nivel 5 de peligro (7 puntos, modulado por su
    // posicion dentro del nivel) MAS 10 por sobreexposicion alta MAS 5 por
    // grupos vulnerables.
    const e407 = assessAdditives(['en:e407'], taxonomy).assessments[0]!;
    expect(e407.risk).toBe('high');
    expect(e407.hazardLevel).toBe(5);
    expect(e407.penaltyReason).toBe('hazard');
    expect(e407.penalty).toBeGreaterThan(10 + 5);
  });

  it('dos aditivos igual de potentes acaban en extremos opuestos', () => {
    // El caso que justifica que la exposicion sea un eje aparte: amaranto y
    // nitrito tienen IDA casi identica (0,15 y 0,1) y EFSA concluye «sin
    // riesgo» para uno y «riesgo alto» para el otro, porque uno casi no se usa
    // y el otro esta en todo.
    const e123 = assessAdditives(['en:e123'], taxonomy).assessments[0]!;
    const e250 = assessAdditives(['en:e250'], taxonomy).assessments[0]!;
    expect(e123.risk).toBe('none');
    expect(e250.risk).toBe('high');
    // Aun asi el amaranto no sale barato: esta prohibido en Estados Unidos.
    expect(e123.banned).toBe(true);
  });

  it('el peldaño «sin datos» no cambia de valor por saber por que faltan', () => {
    // El motivo de no tener dosis NO mueve la penalizacion: el peldaño es el
    // mismo. Lo que cambia es lo que se le puede decir al usuario, y eso vive
    // en la explicacion, no en el numero.
    const sinEvaluar = assessAdditives(['en:e999999'], taxonomy).assessments[0]!;
    expect(sinEvaluar.penaltyReason).toBe('no-data');
    expect(sinEvaluar.penalty).toBe(3);
  });

  it('la posicion dentro del nivel modula la potencia', () => {
    // Entre dos sustancias del mismo nivel pesa mas la de dosis menor: x1,25
    // la mas potente del nivel, x0,75 la menos.
    const conNivel = Object.entries(taxonomy)
      .filter(([, e]) => e.nivel !== undefined && e.posNivel !== undefined && !e.prohibido)
      .map(([t]) => assessAdditives([t], taxonomy).assessments[0]!)
      .filter((a) => a.penaltyReason === 'hazard');
    if (conNivel.length === 0) return;
    for (const a of conNivel) expect(a.penalty).toBeGreaterThan(0);
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
    // El peldaño mas bajo de la escala, muy por debajo de un nivel 8 (4).
    expect(r.assessments[0]!.penalty).toBeLessThanOrEqual(3);
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
    expect(r).toEqual({ group: 2, fromSource: true, reasons: [], markers: [] });
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

describe('rango de la nota cuando faltan datos', () => {
  /**
   * El rango es lo que sostiene el anillo punteado de la interfaz. Si se
   * calculara mal, la aplicacion estaria afirmando una incertidumbre falsa,
   * que es tan malo como fingir precision.
   */
  const ctx = { additiveTaxonomy: {}, additiveClasses: new Map() } as never;
  const base = (extra: Record<string, unknown> = {}, more: Record<string, unknown> = {}) =>
    ({
      barcode: '1', name: 'X', source: 'off', additiveTags: [], categoryTags: [],
      categoryFlags: { isBeverage: false, isWater: false, isCheese: false, isFatOilNutsSeeds: false, isRedMeat: false },
      // El origen es conocido: las banderas se fijan aqui. Sin declararlo, el
      // motor avisaria de que no sabe la categoria, y con razon.
      categoryFlagsSource: 'prueba',
      nutriments: { energyKj: 1490, sugars: 0.5, saturatedFat: 0.5, salt: 0, proteins: 7, fat: 1.5, ...extra },
      ingredientsText: 'harina de maiz', ...more,
    }) as never;

  it('no inventa rango cuando no falta nada', () => {
    const s = scoreProduct(
      base({ fiber: 6, fruitsVegetablesLegumes: 0 }, { novaGroup: 3 }),
      ctx,
    );
    expect(s.range).toBeUndefined();
    expect(s.confidence.level).toBe('high');
  });

  it('acota hacia arriba lo que solo puede sumar', () => {
    // Sin el % de frutas y verduras, hoy se cuenta como 0: la nota real solo
    // puede ser igual o mejor, nunca peor.
    const s = scoreProduct(base({ fiber: 6 }, { novaGroup: 3 }), ctx);
    expect(s.range).toBeDefined();
    expect(s.range!.min).toBe(s.value);
    expect(s.range!.max).toBeGreaterThan(s.value);
  });

  it('acota en los dos sentidos lo que se sustituyo por un valor neutro', () => {
    // Sin NOVA se aplica un neutro de 55, que puede quedarse corto por arriba
    // (alimento sin procesar) y por abajo (ultraprocesado).
    const s = scoreProduct(base({ fiber: 6, fruitsVegetablesLegumes: 0 }), ctx);
    expect(s.range!.min).toBeLessThan(s.value);
    expect(s.range!.max).toBeGreaterThan(s.value);
  });

  it('el rango siempre contiene la nota', () => {
    for (const nov of [undefined, 1, 4]) {
      for (const fib of [undefined, 6]) {
        const s = scoreProduct(base({ fiber: fib }, { novaGroup: nov }), ctx);
        if (!s.range) continue;
        expect(s.range.min).toBeLessThanOrEqual(s.value);
        expect(s.range.max).toBeGreaterThanOrEqual(s.value);
      }
    }
  });

  it('baja la confianza a media cuando algo no se ha contado', () => {
    // Decir "confianza alta" con un aporte positivo sin contar seria mentir.
    const s = scoreProduct(base({ fiber: 6 }, { novaGroup: 3 }), ctx);
    expect(s.confidence.level).toBe('medium');
    expect(s.confidence.notes.join(' ')).toContain('frutas');
  });
});

describe('NOVA: de dónde sale el grupo y qué lo delata', () => {
  /**
   * Los marcadores existen para EXPLICAR, no solo para decidir. Antes solo se
   * recogían cuando había que deducir el grupo, así que un producto
   * clasificado por Open Food Facts se quedaba sin explicación ninguna y la
   * interfaz caía en la definición del grupo, igual para todos.
   */
  const classes = new Map<string, string[]>([
    ['en:e150d', ['en:colour']],
    ['en:e322', ['en:emulsifier']],
    ['en:e330', ['en:acidity-regulator']],
  ]);

  const producto = (extra: Record<string, unknown> = {}) =>
    ({
      barcode: '1',
      name: 'X',
      source: 'off',
      additiveTags: [],
      categoryTags: [],
      allergenTags: [],
      labelTags: [],
      countryTags: [],
      kind: 'food',
      categoryFlags: {
        isBeverage: false,
        isWater: false,
        isCheese: false,
        isFatOilNutsSeeds: false,
        isRedMeat: false,
      },
      nutriments: {},
      ...extra,
    }) as never;

  it('también recoge marcadores cuando el grupo lo da Open Food Facts', () => {
    const r = inferNova(producto({ novaGroup: 4, additiveTags: ['en:e150d'] }), classes);
    expect(r?.fromSource).toBe(true);
    expect(r?.markers).toHaveLength(1);
    expect(r?.markers[0]).toMatchObject({ kind: 'additive', value: 'en:e150d', additiveClass: 'en:colour' });
  });

  it('recoge TODOS los marcadores, no solo el primero', () => {
    // Antes cortaba en el primero de cada tipo: con dos aditivos industriales
    // solo se podía enseñar uno, y la explicación quedaba coja.
    const r = inferNova(
      producto({
        additiveTags: ['en:e150d', 'en:e322', 'en:e330'],
        ingredientsText: 'Harina, jarabe de glucosa, maltodextrina',
      }),
      classes,
    );
    expect(r?.markers.filter((m) => m.kind === 'additive')).toHaveLength(2); // e330 no es marcador
    expect(r?.markers.filter((m) => m.kind === 'ingredient').length).toBeGreaterThanOrEqual(2);
  });

  it('un aditivo que no delata procesamiento industrial no cuenta', () => {
    const r = inferNova(producto({ novaGroup: 1, additiveTags: ['en:e330'] }), classes);
    expect(r?.markers).toHaveLength(0);
  });

  it('sigue sin inventar un grupo cuando no hay ni dato ni marcadores', () => {
    expect(inferNova(producto({ ingredientsText: 'Tomate, sal' }), classes)).toBeUndefined();
  });

  it('deducirlo nunca afirma que algo esté sin procesar', () => {
    // Solo eleva a 4; jamás concluye NOVA 1, que sería mucho más engañoso.
    const r = inferNova(producto({ ingredientsText: 'Maltodextrina' }), classes);
    expect(r?.group).toBe(4);
    expect(r?.fromSource).toBe(false);
  });
});

describe('NOVA: etiquetas reales, con tildes y en español de América', () => {
  const classes = new Map<string, string[]>();
  const conIngredientes = (ingredientsText: string) =>
    ({
      barcode: '1', name: 'X', source: 'off', additiveTags: [], categoryTags: [],
      allergenTags: [], labelTags: [], countryTags: [], kind: 'food',
      categoryFlags: { isBeverage: false, isWater: false, isCheese: false, isFatOilNutsSeeds: false, isRedMeat: false },
      nutriments: {}, ingredientsText,
    }) as never;

  /**
   * Caso real que destapó esto: un pan de Bimbo con «PROTEÍNA VEGETAL» y
   * «SABORIZANTE NATURAL» no producía NI UN marcador. Los patrones iban sin
   * tildes y con vocabulario solo de España.
   */
  it('las tildes ya no impiden el reconocimiento', () => {
    for (const texto of [
      'HARINA DE TRIGO, PROTEÍNA VEGETAL AISLADA',
      'Agua, jarabe de maíz, sal',
      'Almidón modificado de maíz',
    ]) {
      expect(inferNova(conIngredientes(texto), classes)?.markers.length, texto).toBeGreaterThan(0);
    }
  });

  it('reconoce el vocabulario de Latinoamérica', () => {
    for (const texto of [
      'Harina, SABORIZANTE NATURAL',
      'Grasa vegetal hidrogenada',
      'Resaltador de sabor, sal',
      'Colorantes artificiales',
    ]) {
      expect(inferNova(conIngredientes(texto), classes)?.markers.length, texto).toBeGreaterThan(0);
    }
  });

  it('cita el texto tal y como lo escribió el fabricante', () => {
    // Enseñar «PROTEINA» cuando la etiqueta dice «PROTEÍNA» parecería un fallo
    // nuestro, así que se recorta del original, no del normalizado.
    const r = inferNova(conIngredientes('HARINA, PROTEÍNA VEGETAL AISLADA, SAL'), classes);
    const m = r?.markers.find((x) => x.kind === 'ingredient');
    expect(m?.value).toContain('PROTEÍNA');
  });

  it('reconoce las etiquetas en inglés', () => {
    // No es un extra para Estados Unidos: el 19,3% del catálogo mexicano lleva
    // prefijo GS1 estadounidense, y esos productos traen la etiqueta en inglés.
    for (const texto of [
      'SUGAR, HIGH FRUCTOSE CORN SYRUP, SALT',
      'Wheat flour, maltodextrin, salt',
      'Modified corn starch, water',
      'Partially hydrogenated vegetable oil',
      'Soy protein isolate, water',
      'Sugar, natural flavors, citric acid',
      'Cocoa butter, soy lecithin',
      'Mono- and diglycerides of fatty acids',
      'Yeast extract, salt',
    ]) {
      expect(inferNova(conIngredientes(texto), classes)?.markers.length, texto).toBeGreaterThan(0);
    }
  });

  it('no marca comida sin procesar por estar en inglés', () => {
    for (const texto of [
      'Tomatoes, water, salt',
      'Organic rolled oats',
      'Pasteurized milk, live cultures',
    ]) {
      expect(inferNova(conIngredientes(texto), classes), texto).toBeUndefined();
    }
  });

  it('no marca un alimento sin procesar por llevar tildes', () => {
    expect(inferNova(conIngredientes('Tomate, sal, aceite de oliva virgen'), classes)).toBeUndefined();
    expect(inferNova(conIngredientes('Leche pasteurizada, fermentos lácticos'), classes)).toBeUndefined();
  });
});
