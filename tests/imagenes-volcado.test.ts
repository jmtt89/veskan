/**
 * Extraccion de la referencia de imagen desde un producto del volcado.
 *
 * La forma de `images.selected.front` esta tomada de un documento real de la
 * coleccion, no inventada.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- modulo .mjs del pipeline, sin tipos
import { refImagenFrontal } from '../scripts/lib/imagenes.mjs';

const conFrontales = (front: unknown, extra: Record<string, unknown> = {}) => ({
  code: '7506475104722',
  ...extra,
  images: { uploaded: {}, selected: { front } },
});

describe('referencia de la foto frontal en el volcado', () => {
  it('la saca de images.selected.front', () => {
    expect(refImagenFrontal(conFrontales({ es: { rev: 37, imgid: '9' } }))).toBe('es.37');
  });

  it('prefiere el idioma del propio producto', () => {
    // Es el del envase que se vende ahi, y por tanto la foto que el usuario
    // tiene delante.
    const p = conFrontales({ en: { rev: 12 }, es: { rev: 37 } }, { lang: 'es' });
    expect(refImagenFrontal(p)).toBe('es.37');
  });

  it('acepta cualquier idioma si no hay foto en el del producto', () => {
    const p = conFrontales({ de: { rev: 290 } }, { lang: 'es' });
    expect(refImagenFrontal(p)).toBe('de.290');
  });

  it('tolera el rev como cadena, que el volcado mezcla los tipos', () => {
    expect(refImagenFrontal(conFrontales({ en: { rev: '17' } }))).toBe('en.17');
  });

  it('devuelve null cuando no hay foto frontal', () => {
    expect(refImagenFrontal(conFrontales({}))).toBeNull();
    expect(refImagenFrontal({ code: '1' })).toBeNull();
    expect(refImagenFrontal({ code: '1', images: { uploaded: {} } })).toBeNull();
  });

  it('descarta un rev que no sea numerico en vez de dar una URL rota', () => {
    expect(refImagenFrontal(conFrontales({ es: { rev: 'x7' } }))).toBeNull();
    expect(refImagenFrontal(conFrontales({ es: {} }))).toBeNull();
  });
});
