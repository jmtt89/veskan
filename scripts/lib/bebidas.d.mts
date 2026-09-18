/**
 * Tipos para `bebidas.mjs`. Escalas propias del alcohol: clasifican, no juzgan.
 * Ver alli por que se eligieron estas y se descartaron las demas.
 */
export type TipoBebida = 'espumoso' | 'vino' | 'cerveza' | 'sidra' | 'destilado';

/** Gramos de etanol del envase. Null si falta el grado o el volumen. */
export declare function gramosDeEtanol(
  gradoPorCiento: number | null | undefined,
  volumenMl: number | null | undefined,
): number | null;

/** Definiciones de bebida estandar, en gramos de etanol. Van de 8 a 20. */
export declare const BEBIDA_ESTANDAR_G: {
  oms: number; reinoUnido: number; estadosUnidos: number; canada: number; austria: number;
};

export declare function bebidasEstandar(
  gramosEtanol: number | null | undefined,
  gramosPorUnidad?: number,
): number | null;

/** Categoria de dulzor del Reglamento (CE) 607/2009, para espumosos. */
export declare function dulzorEspumoso(
  azucaresPor100ml: number | null | undefined,
): { categoria: string; gPorLitro: number; nota: string | null } | null;

export declare function tipoDeBebida(tags: unknown): TipoBebida | null;
