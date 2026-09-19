/**
 * Los dos motores deben leer LO MISMO.
 *
 * Divergieron una vez y costo caro: el respaldo llevaba ITF y el nativo no,
 * asi que el mismo producto se escaneaba bien en el movil y era imposible en
 * un portatil. Un fallo asi no se ve en ningun test de logica, solo con la
 * camara en la mano, asi que la equivalencia se fija aqui.
 */

import { describe, expect, it } from 'vitest';
import { NATIVE_FORMATS, ZXING_FORMATS } from '../src/core/scanner/barcode.js';

/** `ean_13` y `EAN-13` son el mismo formato escrito a la manera de cada motor. */
const canonico = (f: string) => f.toLowerCase().replace(/[-_]/g, '');

describe('formatos que acepta cada motor', () => {
  it('el respaldo lee exactamente lo mismo que el nativo', () => {
    expect(ZXING_FORMATS.map(canonico).sort()).toEqual(NATIVE_FORMATS.map(canonico).sort());
  });

  it('ninguno acepta ITF', () => {
    // Continuo, sin inicio/fin unico y sin digito de control: cualquier serie
    // de franjas paralelas decodifica como un ITF «valido» y el codigo bueno
    // se pierde entre el ruido.
    for (const f of [...NATIVE_FORMATS, ...ZXING_FORMATS]) {
      expect(canonico(f)).not.toBe('itf');
    }
  });
});
