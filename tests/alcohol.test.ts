/**
 * Tests del tratamiento de las bebidas alcoholicas.
 *
 * Dos de los cuatro bloques no son aplicables, y no por decision nuestra:
 *
 *   Nutri-Score  «does not apply to alcoholic drinks containing more than 1.2%
 *                alcohol» (FAQ oficial de Sante publique France)
 *   Sellos OPS   «alcoholic drinks have been excluded from the PAHO NP model
 *                because they should be subjected to specific regulations»
 *
 * Lo que hace esto necesario y no cosmetico: si se puntuara igual, este mismo
 * motor daria 78 a una cerveza y 27 a un yogur bebible azucarado. El calculo
 * estaria bien; el instrumento, equivocado.
 */

import { describe, expect, it } from 'vitest';
import { scoreProduct, buildAdditiveClassMap } from '../src/core/scoring/engine.js';
import { alcoholView, assessmentView } from '../src/ui/components.js';
import type { AdditiveTaxonomy } from '../src/core/scoring/additives.js';
import type { Nutriments, Product } from '../src/core/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const taxonomy = JSON.parse(
  readFileSync(fileURLToPath(new URL('../public/data/additives.json', import.meta.url)), 'utf8'),
) as AdditiveTaxonomy;
const ctx = { additiveTaxonomy: taxonomy, additiveClasses: buildAdditiveClassMap(taxonomy) };

const bebida = (n: Nutriments, nova: 1 | 2 | 3 | 4 = 3): Product => ({
  barcode: '0000000000001', name: 'Bebida', brands: [], kind: 'beverage',
  additiveTags: [], allergenTags: [], labelTags: [], categoryTags: [], countryTags: [],
  nutriments: n, novaGroup: nova, ingredientsText: 'agua, cebada',
  categoryFlags: { isBeverage: true, isWater: false, isCheese: false, isFatOilNutsSeeds: false, isRedMeat: false },
  categoryFlagsSource: 'prueba', source: 'snapshot', fetchedAt: Date.now(),
});
const CERVEZA: Nutriments = { energyKj: 180, energyKcal: 43, sugars: 0, fat: 0, saturatedFat: 0, salt: 0.01, sodium: 4, proteins: 0.5, fiber: 0, alcohol: 5 };

describe('bebidas alcoholicas', () => {
  it('no calcula Nutri-Score por encima de 1,2% vol', () => {
    const s = scoreProduct(bebida(CERVEZA), ctx);
    expect(s.nutriscore).toBeUndefined();
    expect(s.alcoholic).toBeDefined();
    expect(s.alcoholic!.abv).toBe(5);
  });

  it('tampoco calcula los sellos de la OPS', () => {
    expect(scoreProduct(bebida(CERVEZA), ctx).paho).toBeUndefined();
  });

  it('pero si NOVA y aditivos, que si aplican', () => {
    const s = scoreProduct(bebida({ ...CERVEZA }, 4), ctx);
    expect(s.nova?.group).toBe(4);
    expect(s.breakdown.map((b) => b.id)).toContain('processing');
    expect(s.breakdown.map((b) => b.id)).toContain('additives');
    expect(s.breakdown.map((b) => b.id)).not.toContain('nutrition');
    expect(s.breakdown.map((b) => b.id)).not.toContain('regulatory');
  });

  it('el umbral es 1,2%: una cerveza sin alcohol se puntua con normalidad', () => {
    const s = scoreProduct(bebida({ ...CERVEZA, alcohol: 0.04 }), ctx);
    expect(s.alcoholic).toBeUndefined();
    expect(s.nutriscore).toBeDefined();
    expect(s.paho).toBeDefined();
  });

  it('sin dato de alcohol no se asume que lo lleve', () => {
    const { alcohol, ...sinAlcohol } = CERVEZA;
    void alcohol;
    expect(scoreProduct(bebida(sinAlcohol), ctx).alcoholic).toBeUndefined();
  });

  it('la ficha NO muestra la nota, y dice por que', () => {
    const p = bebida(CERVEZA);
    const s = scoreProduct(p, ctx);
    const h = assessmentView(
      { kind: 'food', product: p, score: s } as never,
      { evidenceOpen: new Set<string>(), confidenceOpen: false } as never,
    ).toString();
    // El numero renormalizado es alto y enganoso: no debe aparecer.
    // Ni el anillo ni el desglose ponderado: el numero renormalizado es alto y
    // enganoso. Pero los DATOS si estan.
    expect(h).not.toContain('score-dial');
    expect(h).not.toContain('reasons-bento');
    expect(h).toContain('Grupo 1');
    expect(h).toContain('No se muestra puntuación nutricional');
    expect(h).toContain('Tabla nutricional');
    expect(h).toContain('Procesamiento · NOVA');
    expect(h).toContain('Aditivos');
  });

  it('el aviso cita la fuente y el grado', () => {
    const p = bebida(CERVEZA);
    const h = alcoholView(p, scoreProduct(p, ctx)).toString();
    expect(h).toContain('IARC');
    expect(h).toContain('vol. 100E');
    expect(h).toContain('5% vol');
  });

  it('la confianza avisa del riesgo en vez de quejarse de nutrientes que no se usan', () => {
    const s = scoreProduct(bebida(CERVEZA), ctx);
    expect(s.confidence.notes.join(' ')).toContain('Grupo 1');
    expect(s.confidence.missing).toHaveLength(0);
  });
});

describe('alerta de composicion elevada', () => {
  /**
   * No es un sello: ninguna regulacion aplica sellos nutricionales a bebidas
   * alcoholicas. Es el criterio del semaforo britanico, citado como tal.
   */
  it('avisa del nutriente alto y dice de donde sale el umbral', () => {
    // Licor de crema: 20 g de azucar por 100 ml, muy por encima de 11,25.
    const p = bebida({ ...CERVEZA, sugars: 20, fat: 10, saturatedFat: 6, alcohol: 17 });
    const h = alcoholView(p, scoreProduct(p, ctx)).toString();
    expect(h).toContain('Contenido alto en');
    expect(h).toContain('azúcares');
    expect(h).toContain('grasas');
    expect(h).toContain('semáforo nutricional británico');
    expect(h).toContain('No es un sello regulatorio');
  });

  it('relaciona los azucares con el maximo diario de la OMS', () => {
    const p = bebida({ ...CERVEZA, sugars: 25 });
    const h = alcoholView(p, scoreProduct(p, ctx)).toString();
    // 25 g son el 50% de los 50 g diarios.
    expect(h).toContain('50%');
    expect(h).toContain('OMS');
  });

  it('no avisa de nada cuando la composicion no es alta', () => {
    const p = bebida(CERVEZA);
    const h = alcoholView(p, scoreProduct(p, ctx)).toString();
    expect(h).not.toContain('Contenido alto en');
  });

  it('usa el umbral de BEBIDA, que es la mitad que el de alimento', () => {
    // 15 g de azucar por 100 ml: alto para bebida (>11,25), no para alimento.
    const p = bebida({ ...CERVEZA, sugars: 15 });
    expect(alcoholView(p, scoreProduct(p, ctx)).toString()).toContain('Contenido alto en');
  });
});
