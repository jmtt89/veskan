/**
 * Tests de la eleccion de idioma.
 *
 * Esto existe porque durante un tiempo se prefirio el castellano de forma fija,
 * y eso no solo mostraba el nombre equivocado a quien no lee castellano: como
 * el constructor exige nombre, DESCARTABA productos enteros que solo tenian el
 * suyo. Veskan tiene que funcionar para todos los paises.
 */

import { describe, expect, it } from 'vitest';
import { ingredientesDe, nombreDe, textoPorIdioma } from '../scripts/lib/nombres.mjs';

describe('eleccion de nombre entre idiomas', () => {
  it('no pierde un producto que solo tiene el nombre en su idioma', () => {
    expect(nombreDe({ product_name_fr: 'Pâte à tartiner' })).toBe('Pâte à tartiner');
    expect(nombreDe({ product_name_ja: 'ヌテラ' })).toBe('ヌテラ');
    expect(nombreDe({ product_name_pt_br: 'Creme de avelã' })).toBe('Creme de avelã');
  });

  it('el campo principal gana cuando no se pide idioma', () => {
    expect(nombreDe({ product_name: 'Nutella', product_name_es: 'Crema' })).toBe('Nutella');
  });

  it('el idioma pedido gana sobre el principal', () => {
    expect(nombreDe({ product_name: 'Nutella', product_name_es: 'Crema' }, 'es')).toBe('Crema');
  });

  it('si el idioma pedido no esta, no deja el producto sin nombre', () => {
    expect(nombreDe({ product_name_fr: 'Confiture' }, 'es')).toBe('Confiture');
  });

  it('usa el idioma propio del producto antes que uno cualquiera', () => {
    expect(nombreDe({ lang: 'ja', product_name_ja: 'ヌテラ', product_name_de: 'Nuss' })).toBe('ヌテラ');
  });

  it('elige de forma reproducible cuando hay varias variantes y ninguna manda', () => {
    const p = { product_name_pt: 'Creme', product_name_de: 'Creme DE', product_name_it: 'Crema' };
    // Orden alfabetico de codigo: de, it, pt.
    expect(nombreDe(p)).toBe('Creme DE');
    expect(nombreDe({ ...p })).toBe(nombreDe(p));
  });

  it('no confunde sufijos que no son idiomas con idiomas', () => {
    expect(nombreDe({ product_name_debug_tags: 'no vale' })).toBeNull();
  });

  it('ignora cadenas vacias o de solo espacios', () => {
    expect(nombreDe({ product_name: '   ', product_name_fr: 'Miel' })).toBe('Miel');
  });

  it('cae a generic_name antes de rendirse', () => {
    expect(nombreDe({ generic_name_fr: 'Biscuit' })).toBe('Biscuit');
  });

  it('devuelve null cuando de verdad no hay nada', () => {
    expect(nombreDe({ code: '123' })).toBeNull();
    expect(nombreDe(null)).toBeNull();
  });

  it('los ingredientes siguen la misma regla', () => {
    expect(ingredientesDe({ ingredients_text_pt_br: 'açúcar, cacau' })).toBe('açúcar, cacau');
    expect(ingredientesDe({ ingredients_text: 'sugar', ingredients_text_fr: 'sucre' }, 'fr')).toBe('sucre');
  });

  it('textoPorIdioma sirve para cualquier campo con variantes', () => {
    expect(textoPorIdioma({ conservation_conditions_de: 'Kühl lagern' }, 'conservation_conditions'))
      .toBe('Kühl lagern');
  });
});
