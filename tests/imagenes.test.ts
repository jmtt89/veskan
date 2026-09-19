/**
 * Construccion de las URLs de foto de Open Food Facts.
 *
 * El volcado no trae ninguna URL: `image_url` y `image_front_small_url` son
 * campos calculados que solo existen en la API, y por eso el catalogo salio
 * durante semanas con la columna vacia en el 100% de las filas. Lo que si trae
 * es `images.selected.front.<idioma>`, y con eso la URL se arma entera.
 *
 * Las dos formas de ruta estan comprobadas contra el servidor de imagenes.
 */

import { describe, expect, it } from 'vitest';
import { rutaDeCodigo, urlImagenFrontal } from '../src/core/data/off-images.js';

describe('troceado del codigo en la ruta', () => {
  it('parte los codigos largos en grupos de tres y deja el resto', () => {
    // Comprobado: responde 200 con la foto de La Lechera.
    expect(rutaDeCodigo('7506475104722')).toBe('750/647/510/4722');
  });

  it('deja los codigos de ocho o menos tal cual', () => {
    // Comprobado: .../00000000/... responde 200 y .../000/000/00/... da 404.
    expect(rutaDeCodigo('00000000')).toBe('00000000');
    expect(rutaDeCodigo('1234567')).toBe('1234567');
  });

  it('no deja barra final en un codigo de nueve digitos', () => {
    expect(rutaDeCodigo('123456789')).toBe('123/456/789');
  });
});

describe('URL de la foto frontal', () => {
  it('arma la URL a partir de la referencia compacta', () => {
    expect(urlImagenFrontal('7506475104722', 'es.37', 200)).toBe(
      'https://images.openfoodfacts.org/images/products/750/647/510/4722/front_es.37.200.jpg',
    );
  });

  it('respeta el tamano pedido', () => {
    expect(urlImagenFrontal('7506475104722', 'es.37', 400)).toContain('.37.400.jpg');
    expect(urlImagenFrontal('7506475104722', 'es.37', 'full')).toContain('.37.full.jpg');
  });

  it('no inventa nada si el producto no tiene foto', () => {
    expect(urlImagenFrontal('7506475104722', null)).toBeUndefined();
    expect(urlImagenFrontal('7506475104722', '')).toBeUndefined();
  });

  it('rechaza una referencia mal formada en vez de dar una URL rota', () => {
    // Un 404 deja un hueco roto en la interfaz; no mostrar foto es mejor.
    for (const malo of ['es', '37', 'es.', '.37', 'es.abc', 'demasiadolargo.3']) {
      expect(urlImagenFrontal('7506475104722', malo)).toBeUndefined();
    }
  });
});
