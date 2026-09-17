/**
 * Tipos para `nombres.mjs`, que elige el texto de un producto entre sus
 * variantes por idioma. En JavaScript plano porque lo comparten la aplicacion
 * (TypeScript) y la tuberia de datos (Node sin compilar).
 */

/** Idioma preferido, como codigo ISO corto (`es`, `fr`, `pt_br`). */
export type Idioma = string;

export declare function textoPorIdioma(
  producto: unknown,
  base: string,
  idioma?: Idioma,
): string | null;

/** Nombre del producto; cae a `generic_name` antes de rendirse. */
export declare function nombreDe(producto: unknown, idioma?: Idioma): string | null;

/** Lista de ingredientes. */
export declare function ingredientesDe(producto: unknown, idioma?: Idioma): string | null;
