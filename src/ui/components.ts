/**
 * Componentes de presentacion. Funciones puras de datos a HTML: sin estado,
 * sin efectos, faciles de probar.
 */

import { html, raw, type SafeHtml } from './render.js';
import type {
  AdditiveAssessment,
  Assessment,
  Confidence,
  CosmeticAssessment,
  HealthScore,
  NutriscoreResult,
  PahoResult,
  Product,
} from '../core/types.js';
import { BAND_COLORS, BAND_LABELS } from '../core/scoring/engine.js';
import {
  ADDITIVE_CLASS_LABELS,
  POPULATION_GROUP_LABELS,
  describeRisk,
} from '../core/scoring/additives.js';
import { PAHO_SEAL_LABELS } from '../core/scoring/paho.js';
import { NOVA_DESCRIPTIONS } from '../core/scoring/nova.js';

const NUTRISCORE_COLORS: Record<string, string> = {
  a: '#038141',
  b: '#85bb2f',
  c: '#fecb02',
  d: '#ee8100',
  e: '#e63e11',
};

const COMPONENT_LABELS: Record<string, string> = {
  energy: 'Energía',
  energy_from_saturated_fat: 'Energía de grasas saturadas',
  sugars: 'Azúcares',
  saturated_fat: 'Grasas saturadas',
  saturated_fat_ratio: 'Proporción de grasas saturadas',
  salt: 'Sal',
  non_nutritive_sweeteners: 'Edulcorantes no nutritivos',
  proteins: 'Proteínas',
  fiber: 'Fibra',
  fruits_vegetables_legumes: 'Frutas, verduras y legumbres',
};

const CONFIDENCE_LABELS: Record<Confidence['level'], string> = {
  high: 'Datos completos',
  medium: 'Datos suficientes',
  low: 'Datos incompletos',
  insufficient: 'Datos insuficientes',
};

const SOURCE_LABELS: Record<Product['source'], string> = {
  cache: 'guardado en este dispositivo',
  snapshot: 'copia local de la base',
  openfoodfacts: 'Open Food Facts',
  openbeautyfacts: 'Open Beauty Facts',
  user: 'aportado por ti',
};

export function scoreDial(score: HealthScore): SafeHtml {
  const color = BAND_COLORS[score.band];
  const r = 46;
  const circumference = 2 * Math.PI * r;
  const filled = (score.value / 100) * circumference;

  return html`
    <div class="score-dial" role="img" aria-label="Puntuación ${score.value} sobre 100">
      <svg viewBox="0 0 104 104" aria-hidden="true">
        <circle cx="52" cy="52" r="${r}" fill="none" stroke="var(--border)" stroke-width="8" />
        <circle
          cx="52" cy="52" r="${r}" fill="none"
          stroke="${raw(color)}" stroke-width="8" stroke-linecap="round"
          stroke-dasharray="${filled} ${circumference - filled}"
        />
      </svg>
      <div>
        <div class="value" style="color:${raw(color)}">${score.value}</div>
        <div class="max">de 100</div>
      </div>
    </div>
  `;
}

export function confidenceBar(confidence: Confidence): SafeHtml {
  return html`
    <div class="confidence ${confidence.level}">
      <strong>${CONFIDENCE_LABELS[confidence.level]}</strong>
      <div class="bar"><span style="width:${Math.round(confidence.ratio * 100)}%"></span></div>
      ${confidence.missing.length > 0
        ? html`<div>Falta: ${confidence.missing.join(', ')}.</div>`
        : ''}
      ${confidence.notes.map((n) => html`<div>${n}</div>`)}
    </div>
  `;
}

export function nutriscoreCard(ns: NutriscoreResult): SafeHtml {
  const letters = ['a', 'b', 'c', 'd', 'e'];
  return html`
    <div class="card">
      <h2>Calidad nutricional · Nutri-Score 2023</h2>
      <div class="nutriscore-scale">
        ${letters.map(
          (l) => html`<span
            style="background:${raw(NUTRISCORE_COLORS[l] ?? '#888')}"
            data-active="${l === ns.grade}"
            >${l.toUpperCase()}</span
          >`,
        )}
      </div>
      <details style="margin-top:12px">
        <summary>Cómo se ha calculado (${ns.score} puntos)</summary>
        <table class="nutrient-table" style="margin-top:8px">
          <tbody>
            <tr>
              <td colspan="2"><strong>Penalizan (${ns.negativePoints} pts)</strong></td>
            </tr>
            ${ns.components.negative.map(
              (c) => html`<tr>
                <td>${COMPONENT_LABELS[c.id] ?? c.id}${c.value !== undefined
                  ? html` <span style="color:var(--text-dim)">${c.value} ${c.unit}</span>`
                  : ''}</td>
                <td>${c.points} / ${c.pointsMax}</td>
              </tr>`,
            )}
            <tr>
              <td colspan="2" style="padding-top:12px">
                <strong>Compensan (${ns.positivePoints} pts)</strong>
              </td>
            </tr>
            ${ns.components.positive.map(
              (c) => html`<tr>
                <td>${COMPONENT_LABELS[c.id] ?? c.id}${c.value !== undefined
                  ? html` <span style="color:var(--text-dim)">${c.value} ${c.unit}</span>`
                  : ''}</td>
                <td>${c.points} / ${c.pointsMax}</td>
              </tr>`,
            )}
          </tbody>
        </table>
        ${!ns.countProteins
          ? html`<p class="source-note">
              Las proteínas no suman en este producto:
              ${ns.countProteinsReason === 'negative_points_greater_than_or_equal_to_11'
                ? 'acumula 11 o más puntos negativos, y la regla de 2023 impide compensarlos con proteína.'
                : 'acumula 7 o más puntos negativos en la categoría de grasas y aceites.'}
            </p>`
          : ''}
        ${ns.proteinsLimitedReason === 'red_meat_product'
          ? html`<p class="source-note">
              Al ser carne roja, los puntos por proteína se limitan a 2 (revisión de 2023).
            </p>`
          : ''}
      </details>
    </div>
  `;
}

export function pahoCard(paho: PahoResult): SafeHtml {
  if (!paho.applicable) return raw('');
  const exceeded = paho.seals.filter((s) => s.exceeded);
  if (exceeded.length === 0) {
    return html`
      <div class="card">
        <h2>Advertencias OPS/OMS</h2>
        <p style="margin:0">
          Sin sellos de exceso según el modelo de perfil de nutrientes de la OPS.
        </p>
      </div>
    `;
  }
  return html`
    <div class="card">
      <h2>Advertencias OPS/OMS</h2>
      <div class="seals">
        ${exceeded.map((s) => html`<div class="seal">${PAHO_SEAL_LABELS[s.id]}</div>`)}
      </div>
      <table class="nutrient-table" style="margin-top:14px">
        <tbody>
          ${exceeded.map(
            (s) => html`<tr>
              <td>
                ${PAHO_SEAL_LABELS[s.id]}${s.estimated
                  ? html` <span style="color:var(--text-dim)">(estimado)</span>`
                  : ''}
              </td>
              <td>
                ${s.actual !== undefined ? html`${s.actual} ${s.unit}` : 'presente'}
                <span style="color:var(--text-dim)">
                  ≥ ${s.threshold}${s.unit === 'presencia' ? '' : ` ${s.unit}`}</span
                >
              </td>
            </tr>`,
          )}
        </tbody>
      </table>
      <p class="source-note">
        Criterios del Modelo de Perfil de Nutrientes de la OPS (2016), base de los sellos
        octogonales de Chile, Perú, México y Uruguay.
      </p>
    </div>
  `;
}

export function additivesCard(additives: AdditiveAssessment[]): SafeHtml {
  if (additives.length === 0) {
    return html`
      <div class="card">
        <h2>Aditivos</h2>
        <p style="margin:0">No se han declarado aditivos en este producto.</p>
      </div>
    `;
  }

  return html`
    <div class="card">
      <h2>Aditivos (${additives.length})</h2>
      ${additives.map((a) => {
        const groups = a.overexposedGroupsMean.length ? a.overexposedGroupsMean : a.overexposedGroupsP95;
        return html`
          <div class="additive">
            <div class="head">
              <strong>${a.name}</strong>
              <span class="risk-chip risk-${a.risk}">${describeRiskShort(a)}</span>
              ${a.classes.map(
                (c) =>
                  html`<span style="font-size:.74rem;color:var(--text-dim)"
                    >${ADDITIVE_CLASS_LABELS[c] ?? c.replace('en:', '')}</span
                  >`,
              )}
            </div>
            ${a.description ? html`<p style="margin:5px 0;font-size:.85rem">${a.description}</p>` : ''}
            <p style="margin:4px 0 0;font-size:.83rem;color:var(--text-dim)">
              ${describeRisk(a.risk)}${groups.length > 0
                ? html`. Supera la ingesta diaria admisible en:
                  ${groups.map((g) => POPULATION_GROUP_LABELS[g] ?? g.replace('en:', '')).join(', ')}`
                : ''}${a.ansesOfInterest ? '. Bajo vigilancia reforzada de ANSES' : ''}.
            </p>
            ${a.efsaEvaluationUrl
              ? html`<p style="margin:4px 0 0">
                  <a
                    href="${a.efsaEvaluationUrl}"
                    target="_blank"
                    rel="noopener noreferrer"
                    style="font-size:.78rem"
                    >Evaluación de EFSA${a.efsaEvaluationDate ? ` (${a.efsaEvaluationDate})` : ''}</a
                  >
                </p>`
              : ''}
          </div>
        `;
      })}
      <p class="source-note">
        Se valora el <strong>riesgo de sobreexposición evaluado por EFSA</strong>, no el peligro
        teórico del aditivo. El programa de reevaluación de EFSA sigue en curso: la mayoría de los
        aditivos aún no tiene una evaluación de sobreexposición publicada, y en esos casos la
        penalización aplicada es mínima.
      </p>
    </div>
  `;
}

function describeRiskShort(a: AdditiveAssessment): string {
  switch (a.risk) {
    case 'high':
      return 'riesgo alto';
    case 'moderate':
      return 'riesgo moderado';
    case 'none':
      return 'sin riesgo';
    default:
      return 'sin evaluar';
  }
}

export function breakdownCard(score: HealthScore): SafeHtml {
  return html`
    <div class="card">
      <h2>De dónde sale la puntuación</h2>
      ${score.breakdown.map(
        (b) => html`
          <div class="breakdown-row">
            <div class="label">${b.label}</div>
            <div class="points">
              ${Math.round(b.contribution)} <span style="color:var(--text-dim)">/ ${Math.round(b.weight * 100)}</span>
            </div>
            <div class="detail">${b.detail}</div>
          </div>
        `,
      )}
      <p class="source-note">
        Algoritmo versión ${score.algorithmVersion}. Cada bloque y su peso están documentados y son
        auditables; no hay ajustes ocultos.
      </p>
    </div>
  `;
}

export function novaCard(score: HealthScore): SafeHtml {
  if (!score.nova) return raw('');
  return html`
    <div class="card">
      <h2>Grado de procesamiento · NOVA ${score.nova.group}</h2>
      <p style="margin:0 0 6px"><strong>${score.nova.label}</strong></p>
      <p style="margin:0;font-size:.86rem;color:var(--text-dim)">
        ${NOVA_DESCRIPTIONS[score.nova.group]}
      </p>
    </div>
  `;
}

export function nutrientsCard(product: Product): SafeHtml {
  const n = product.nutriments;
  const rows: Array<[string, number | undefined, string]> = [
    ['Energía', n.energyKcal !== undefined ? Math.round(n.energyKcal) : undefined, 'kcal'],
    ['Grasas', n.fat, 'g'],
    ['  de las cuales saturadas', n.saturatedFat, 'g'],
    ['Hidratos de carbono', n.carbohydrates, 'g'],
    ['  de los cuales azúcares', n.sugars, 'g'],
    ['Fibra', n.fiber, 'g'],
    ['Proteínas', n.proteins, 'g'],
    ['Sal', n.salt, 'g'],
  ];
  const present = rows.filter(([, v]) => v !== undefined);
  if (present.length === 0) return raw('');

  return html`
    <div class="card">
      <h2>Información nutricional (por 100 g/ml)</h2>
      <table class="nutrient-table">
        <tbody>
          ${present.map(
            ([label, value, unit]) => html`<tr>
              <td>${label}</td>
              <td>${typeof value === 'number' ? value.toFixed(value < 10 ? 1 : 0) : ''} ${unit}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
  `;
}

export function ingredientsCard(product: Product): SafeHtml {
  if (!product.ingredientsText) return raw('');
  return html`
    <div class="card">
      <h2>Ingredientes</h2>
      <p style="margin:0;font-size:.89rem">${product.ingredientsText}</p>
      ${product.allergenTags.length > 0
        ? html`<p style="margin:10px 0 0;font-size:.85rem">
            <strong>Alérgenos:</strong>
            ${product.allergenTags.map((a) => a.replace(/^[a-z]{2}:/, '')).join(', ')}
          </p>`
        : ''}
    </div>
  `;
}

export function cosmeticCard(assessment: CosmeticAssessment): SafeHtml {
  const severityLabel = {
    prohibited: 'Prohibido en la UE',
    restricted: 'Uso restringido',
    allergen: 'Alérgeno declarable',
    info: 'Información',
  } as const;
  const severityClass = {
    prohibited: 'risk-high',
    restricted: 'risk-moderate',
    allergen: 'risk-unknown',
    info: 'risk-unknown',
  } as const;

  return html`
    <div class="notice info">
      Para cosmética no damos una puntuación de 0 a 100. Las puntuaciones de "peligro" habituales
      en el sector ignoran la concentración, la vía de exposición y si el producto se enjuaga, así
      que informamos de lo que sí es verificable: situación regulatoria y alérgenos declarados.
    </div>
    <div class="card">
      <h2>Análisis de la fórmula</h2>
      ${assessment.flags.length === 0
        ? html`<p style="margin:0">
            No se han detectado sustancias prohibidas, restringidas ni alérgenos de declaración
            obligatoria entre los ${assessment.totalIngredients} ingredientes analizados.
          </p>`
        : assessment.flags.map(
            (f) => html`
              <div class="additive">
                <div class="head">
                  ${f.ingredient ? html`<strong>${f.ingredient}</strong>` : ''}
                  <span class="risk-chip ${severityClass[f.severity]}">${severityLabel[f.severity]}</span>
                </div>
                <p style="margin:5px 0 0;font-size:.85rem">${f.message}</p>
                ${f.reference
                  ? html`<p style="margin:3px 0 0;font-size:.76rem;color:var(--text-dim)">
                      ${f.reference}
                    </p>`
                  : ''}
              </div>
            `,
          )}
    </div>
    ${confidenceBar(assessment.confidence)}
  `;
}

export function sourceNote(product: Product): SafeHtml {
  const date = product.lastModified ? new Date(product.lastModified).toLocaleDateString('es') : null;
  return html`
    <p class="source-note">
      Datos de <strong>${SOURCE_LABELS[product.source]}</strong>${date
        ? html`, última actualización ${date}`
        : ''}. Base de datos colaborativa bajo licencia ODbL: cualquiera puede corregirla.
      ${product.editUrl
        ? html`<a href="${product.editUrl}" target="_blank" rel="noopener noreferrer"
            >¿Ves algo mal? Corrígelo aquí.</a
          >`
        : ''}
    </p>
    <p class="source-note">
      Esta aplicación es informativa y no sustituye el consejo de un profesional sanitario.
    </p>
  `;
}

export function productHeader(product: Product, score?: HealthScore): SafeHtml {
  return html`
    <div class="card">
      <div class="score-hero">
        ${score ? scoreDial(score) : raw('')}
        <div class="score-meta">
          <h3>${product.name ?? `Producto ${product.barcode}`}</h3>
          ${product.brands?.length
            ? html`<p class="brand">${product.brands.join(', ')}${product.quantity
                ? ` · ${product.quantity}`
                : ''}</p>`
            : ''}
          ${score
            ? html`<span class="band" style="background:${raw(BAND_COLORS[score.band])}"
                >${BAND_LABELS[score.band]}</span
              >`
            : ''}
        </div>
      </div>
      ${score ? confidenceBar(score.confidence) : raw('')}
    </div>
  `;
}

export function assessmentView(assessment: Assessment): SafeHtml {
  if (assessment.kind === 'cosmetic') {
    return html`
      ${productHeader(assessment.product)} ${cosmeticCard(assessment.assessment)}
      ${ingredientsCard(assessment.product)} ${sourceNote(assessment.product)}
    `;
  }
  const { product, score } = assessment;
  return html`
    ${productHeader(product, score)} ${breakdownCard(score)}
    ${score.nutriscore ? nutriscoreCard(score.nutriscore) : raw('')}
    ${score.paho ? pahoCard(score.paho) : raw('')} ${novaCard(score)}
    ${additivesCard(score.additives)} ${nutrientsCard(product)} ${ingredientsCard(product)}
    ${sourceNote(product)}
  `;
}
