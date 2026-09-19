/**
 * Modo disparo: el bucle no corre y decide el usuario.
 *
 * Se prueba la eleccion de imagen, que es donde esta el valor: `takePhoto()`
 * entrega la resolucion fotografica de la camara, que puede superar a la del
 * video, y sobre una imagen nitida eso es justo lo que le falta a una webcam
 * de foco fijo. Si no hay `ImageCapture` -Safari- hay que seguir funcionando
 * con el fotograma del video.
 */

import { describe, expect, it } from 'vitest';

/** Misma eleccion que `tomarImagen()`: el mayor modo foto que declare la camara. */
function opcionesDeFoto(caps?: { imageWidth?: { max?: number }; imageHeight?: { max?: number } }) {
  return caps?.imageWidth?.max && caps?.imageHeight?.max
    ? { imageWidth: caps.imageWidth.max, imageHeight: caps.imageHeight.max }
    : undefined;
}

describe('a que resolucion se pide la foto', () => {
  it('pide el mayor modo fotografico que la camara declare', () => {
    expect(opcionesDeFoto({ imageWidth: { max: 2592 }, imageHeight: { max: 1944 } })).toEqual({
      imageWidth: 2592,
      imageHeight: 1944,
    });
  });

  it('no impone tamano si la camara no declara maximos', () => {
    expect(opcionesDeFoto({})).toBeUndefined();
    expect(opcionesDeFoto(undefined)).toBeUndefined();
  });

  it('no impone tamano si solo declara una dimension', () => {
    // Pedir ancho sin alto deja a la camara elegir una relacion cualquiera.
    expect(opcionesDeFoto({ imageWidth: { max: 2592 } })).toBeUndefined();
  });
});
