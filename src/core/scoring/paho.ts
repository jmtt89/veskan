/**
 * Modelo de Perfil de Nutrientes de la OPS/OMS (2016).
 *
 * Criterios transcritos literalmente del documento oficial
 * "Modelo de perfil de nutrientes de la Organizacion Panamericana de la Salud",
 * Panel C, consultado el 2026-09-16:
 *
 *   Sodio            1 mg de sodio por 1 kcal
 *   Azucares libres  10% del total de energia proveniente de azucares libres
 *   Otros edulcorantes  cualquier cantidad
 *   Total de grasas  30% del total de energia proveniente del total de grasas
 *   Grasas saturadas 10% del total de energia proveniente de grasas saturadas
 *   Grasas trans     1% del total de energia proveniente de grasas trans
 *
 * Es el modelo del que derivan los sellos octogonales de Chile, Peru, Mexico
 * (NOM-051) y Uruguay, y por eso es el marco que reconoce el usuario de la
 * region. El propio modelo acota su alcance a productos PROCESADOS y
 * ULTRAPROCESADOS, asi que no se aplica a NOVA 1 y 2.
 */

import type { Nutriments, PahoResult, PahoSeal } from '../types.js';

const KCAL_PER_G_FAT = 9;
const KCAL_PER_G_CARB = 4;

export interface PahoInput {
  nutriments: Nutriments;
  novaGroup?: 1 | 2 | 3 | 4;
  /** Presencia de cualquier edulcorante, calorico o no (incluye polialcoholes) */
  hasSweeteners: boolean;
}

/**
 * Estima los azucares libres cuando no estan declarados.
 *
 * Los azucares libres (OMS) excluyen los intrinsecos de frutas y lacteos
 * enteros, pero las etiquetas casi nunca los separan. Se usa el porcentaje de
 * frutas/verduras como descuento aproximado. Cualquier sello que dependa de
 * esta estimacion se marca `estimated: true` y se muestra como tal.
 */
export function estimateFreeSugars(n: Nutriments): { value?: number; estimated: boolean } {
  if (n.freeSugars !== undefined) return { value: n.freeSugars, estimated: false };
  if (n.sugars === undefined) return { value: undefined, estimated: false };
  const fvl = n.fruitsVegetablesLegumes ?? 0;
  // Con 0% de fruta, todo el azucar se considera libre; con 100%, ninguno.
  const intrinsicFraction = Math.min(Math.max(fvl, 0), 100) / 100;
  return { value: n.sugars * (1 - intrinsicFraction), estimated: true };
}

export function evaluatePaho(input: PahoInput): PahoResult {
  const { nutriments: n, novaGroup, hasSweeteners } = input;

  // El modelo OPS se define para procesados y ultraprocesados.
  const applicable = novaGroup === undefined || novaGroup >= 3;

  const kcal = n.energyKcal ?? (n.energyKj !== undefined ? n.energyKj / 4.184 : undefined);
  const seals: PahoSeal[] = [];

  const pushEnergyRatioSeal = (
    id: PahoSeal['id'],
    grams: number | undefined,
    kcalPerGram: number,
    thresholdPct: number,
    estimated = false,
  ) => {
    if (grams === undefined || kcal === undefined || kcal <= 0) {
      seals.push({ id, exceeded: false, threshold: thresholdPct, unit: '% energia', estimated });
      return;
    }
    const pct = ((grams * kcalPerGram) / kcal) * 100;
    seals.push({
      id,
      exceeded: pct >= thresholdPct,
      actual: Math.round(pct * 10) / 10,
      threshold: thresholdPct,
      unit: '% energia',
      estimated,
    });
  };

  // Sodio: razon sodio(mg) / energia(kcal) >= 1
  if (n.sodium !== undefined && kcal !== undefined && kcal > 0) {
    const ratio = n.sodium / kcal;
    seals.push({
      id: 'sodium',
      exceeded: ratio >= 1,
      actual: Math.round(ratio * 100) / 100,
      threshold: 1,
      unit: 'mg/kcal',
    });
  } else {
    seals.push({ id: 'sodium', exceeded: false, threshold: 1, unit: 'mg/kcal' });
  }

  const freeSugars = estimateFreeSugars(n);
  pushEnergyRatioSeal(
    'free-sugars',
    freeSugars.value,
    KCAL_PER_G_CARB,
    10,
    freeSugars.estimated,
  );
  pushEnergyRatioSeal('total-fat', n.fat, KCAL_PER_G_FAT, 30);
  pushEnergyRatioSeal('saturated-fat', n.saturatedFat, KCAL_PER_G_FAT, 10);
  pushEnergyRatioSeal('trans-fat', n.transFat, KCAL_PER_G_FAT, 1);

  // "Otros edulcorantes": cualquier cantidad dispara el aviso.
  seals.push({
    id: 'sweeteners',
    exceeded: hasSweeteners,
    threshold: 0,
    unit: 'presencia',
  });

  return {
    applicable,
    seals,
    exceededCount: applicable ? seals.filter((s) => s.exceeded).length : 0,
  };
}

export const PAHO_SEAL_LABELS: Record<PahoSeal['id'], string> = {
  sodium: 'EXCESO SODIO',
  'free-sugars': 'EXCESO AZUCARES',
  'total-fat': 'EXCESO GRASAS',
  'saturated-fat': 'EXCESO GRASAS SATURADAS',
  'trans-fat': 'EXCESO GRASAS TRANS',
  sweeteners: 'CONTIENE EDULCORANTES',
};
