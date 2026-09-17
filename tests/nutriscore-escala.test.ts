/**
 * La escala que se muestra en la evidencia.
 *
 * Enseñar la escala equivocada sería peor que no enseñar ninguna: el usuario
 * concluiría que su producto cae en una letra que no le corresponde. Los cortes
 * de las bebidas y los de grasas, aceites, frutos secos y semillas NO son los
 * generales.
 */

import { describe, expect, it } from 'vitest';
import { gradeScale } from '../src/ui/components.js';
import { computeGrade2023 } from '../src/core/scoring/nutriscore2023.js';

const BASE = {
  isBeverage: false,
  isWater: false,
  isCheese: false,
  isFatOilNutsSeeds: false,
  isRedMeat: false,
};

describe('escala mostrada por categoría', () => {
  it('elige la general por defecto', () => {
    const e = gradeScale(BASE);
    expect(e.titulo).toContain('general');
    expect(e.filas[0]).toEqual(['A', '−17 a 0']);
  });

  it('las bebidas tienen la suya, y en ellas la A es solo del agua', () => {
    const e = gradeScale({ ...BASE, isBeverage: true });
    expect(e.titulo).toContain('bebidas');
    expect(e.filas[0]![1]).toBe('solo el agua');
  });

  it('grasas y frutos secos llegan a la A con score negativo', () => {
    const e = gradeScale({ ...BASE, isFatOilNutsSeeds: true });
    expect(e.titulo).toContain('grasas');
    expect(e.filas[0]).toEqual(['A', '−17 a −6']);
  });

  /**
   * El contrato de verdad: los limites que se DIBUJAN se leen de la propia
   * tabla y se comprueban contra la funcion de cortes. Si alguien toca uno de
   * los dos y no el otro, esto salta. Comprobar contra numeros escritos a mano
   * aqui no habria servido: seria una tercera copia que tambien puede quedarse
   * vieja.
   */
  it('cada límite dibujado cae en la letra que dice la tabla', () => {
    const variantes = [{}, { isBeverage: true }, { isFatOilNutsSeeds: true }];
    let comprobados = 0;

    for (const v of variantes) {
      const flags = { ...BASE, ...v };
      for (const [letra, rango] of gradeScale(flags).filas) {
        // El signo menos es el tipografico (U+2212), no el guion del teclado.
        const nums = [...rango.matchAll(/\u2212?\d+/g)].map((m) =>
          Number(m[0].replace('\u2212', '-')),
        );
        if (nums.length !== 2) continue; // «solo el agua» no tiene rango numerico
        for (const limite of nums) {
          expect(
            computeGrade2023(limite, flags).toUpperCase(),
            `${JSON.stringify(v)} · score ${limite} debería ser ${letra}`,
          ).toBe(letra);
          comprobados++;
        }
        // Y justo fuera del rango NO puede seguir siendo la misma letra.
        const [, alto] = nums as [number, number];
        if (letra !== 'E') {
          expect(computeGrade2023(alto + 1, flags).toUpperCase()).not.toBe(letra);
        }
      }
    }
    expect(comprobados).toBeGreaterThan(20);
  });
});
