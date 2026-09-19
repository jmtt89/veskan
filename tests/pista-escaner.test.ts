/**
 * Cuando avisar de que la camara no va a conseguirlo.
 *
 * Una webcam de foco fijo entrega fotogramas legitimos sin nada legible: no
 * hay error que mostrar, asi que sin este aviso el usuario solo ve un contador
 * subir. Se prueba la condicion, que es la decision; el HTML no.
 */

import { describe, expect, it } from 'vitest';

const FOTOGRAMAS_SIN_SUERTE = 100;

/** Misma condicion que `pistaSinSuerte()` en `main.ts`. */
const hayQueAvisar = (d?: { framesAnalyzed: number; detections: number }) =>
  Boolean(d && d.detections === 0 && d.framesAnalyzed >= FOTOGRAMAS_SIN_SUERTE);

describe('aviso de que la camara no lo esta consiguiendo', () => {
  it('calla mientras el usuario todavia esta encuadrando', () => {
    expect(hayQueAvisar({ framesAnalyzed: 40, detections: 0 })).toBe(false);
  });

  it('avisa tras unos 20 segundos sin una sola deteccion', () => {
    expect(hayQueAvisar({ framesAnalyzed: 100, detections: 0 })).toBe(true);
  });

  it('calla si la camara SI detecta, aunque se descarte por digito de control', () => {
    // Ese es otro problema -ruido, no ceguera- y merece otra respuesta.
    expect(hayQueAvisar({ framesAnalyzed: 500, detections: 12 })).toBe(false);
  });

  it('calla si aun no hay diagnostico', () => {
    expect(hayQueAvisar(undefined)).toBe(false);
  });
});
