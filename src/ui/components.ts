/**
 * Componentes de presentacion. Funciones puras de datos a HTML: sin estado,
 * sin efectos, faciles de probar.
 */

import { ariaBool, html, raw, type SafeHtml } from './render.js';
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
import { BAND_LABELS } from '../core/scoring/engine.js';
import { ADDITIVE_CLASS_LABELS, POPULATION_GROUP_LABELS } from '../core/scoring/additives.js';
import { PAHO_SEAL_LABELS } from '../core/scoring/paho.js';
import { NOVA_DESCRIPTIONS } from '../core/scoring/nova.js';

/**
 * Logotipo oficial Nutri-Score.
 *
 * Es el archivo de Sante publique France **tal cual**, sin recolorear ni
 * recomponer: su carta grafica (ANEXO 2 del reglamento de uso) no admite
 * reinterpretaciones, y los colores reales del logotipo ni siquiera coinciden
 * con los que se citan en los articulos divulgativos -- el verde de la A es
 * #00803D, no el #038141 que suele repetirse.
 *
 * Es la version neutra (240x130), sin la banda «NEW CALCULATION» que lleva la
 * variante de transicion: esa banda va en ingles y no existe traducida al
 * espanol. Que version del algoritmo se ha usado ya se dice al lado, en
 * castellano, y ahi si se entiende.
 *
 * Se sirve desde la propia aplicacion para que funcione sin conexion y para no
 * entregar la IP del usuario a un tercero en cada visita.
 */
function nutriscoreLogo(grade: string, size: 'sm' | 'md' = 'md'): SafeHtml {
  const g = grade.toLowerCase();
  return html`<img
    class="ns-logo ${size}"
    src="nutriscore/${g}.svg"
    alt="Nutri-Score ${grade.toUpperCase()}"
    width="240"
    height="130"
    loading="lazy"
  />`;
}

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
  high: 'Confianza alta',
  medium: 'Confianza media',
  low: 'Confianza baja',
  insufficient: 'Datos insuficientes',
};

/** Cuantas de las tres barras se encienden. Nunca es solo color: hay texto. */
const CONFIDENCE_BARS: Record<Confidence['level'], number> = {
  high: 3,
  medium: 2,
  low: 1,
  insufficient: 0,
};

/**
 * Como se nombra cada origen dentro de la frase «Datos de ...».
 *
 * No todas encajan igual: «Datos de guardado en este dispositivo» no es
 * castellano, asi que las que no son un nombre propio llevan su propia
 * redaccion.
 */
const SOURCE_SENTENCE: Record<Product['source'], string> = {
  cache: 'Datos <strong>guardados en este dispositivo</strong>',
  snapshot: 'Datos del <strong>catálogo descargado</strong>, de Open Food Facts',
  openfoodfacts: 'Datos de <strong>Open Food Facts</strong>',
  openbeautyfacts: 'Datos de <strong>Open Beauty Facts</strong>',
  user: 'Datos <strong>aportados por ti</strong>',
};


// ---------------------------------------------------------------------------
// Capa 1 · Veredicto
// ---------------------------------------------------------------------------

/**
 * Anillo de puntuacion.
 *
 * Dos arcos, no uno. El exterior translucido marca el RANGO en el que puede
 * estar la nota cuando faltan datos; el interior, la nota calculada. Sin el,
 * un 76 con el 15% de los datos ausentes se veria igual que un 76 completo, y
 * eso seria fingir una precision que no se tiene.
 *
 * El numero lleva «≈» delante en ese caso: el color por si solo no comunica
 * nada a quien no lo distingue.
 */
export function scoreDial(score: HealthScore): SafeHtml {
  const { value, band, range } = score;
  const incierto = Boolean(range);
  const rangoTexto = range ? `, entre ${range.min} y ${range.max}` : '';
  const aria = `Puntuación ${value} sobre 100, ${BAND_LABELS[band]}${rangoTexto}`;

  const anchoRango = range ? range.max - range.min : 0;

  return html`
    <div class="dial band-${band}" role="img" aria-label="${aria}">
      <svg viewBox="0 0 124 124" aria-hidden="true">
        <circle class="dial-track" cx="62" cy="62" r="54" pathLength="100" />
        ${range
          ? html`<circle
              class="dial-range"
              cx="62"
              cy="62"
              r="54"
              pathLength="100"
              stroke-dasharray="${anchoRango} ${100 - anchoRango}"
              stroke-dashoffset="${-range.min}"
            />`
          : raw('')}
        <circle
          class="dial-value"
          cx="62"
          cy="62"
          r="54"
          pathLength="100"
          stroke-dasharray="${value} ${100 - value}"
        />
      </svg>
      <div class="dial-inner">
        <div class="dial-score">${incierto ? raw('<span aria-hidden="true">≈</span>') : raw('')}${value}</div>
        <div class="dial-of">DE 100</div>
      </div>
    </div>
  `;
}

/** Cabecera del veredicto: nota, banda, nombre y marca. */
export function verdict(product: Product, score: HealthScore): SafeHtml {
  const marca = product.brands?.join(', ');
  const sub = [marca, product.quantity].filter(Boolean).join(' · ');
  return html`
    <section class="verdict" aria-label="Veredicto">
      ${scoreDial(score)}
      <div class="verdict-text">
        <span class="band-pill band-${score.band}">${BAND_LABELS[score.band]}</span>
        <h2>${product.name ?? 'Producto sin nombre'}</h2>
        ${sub ? html`<div class="verdict-sub">${sub}</div>` : raw('')}
      </div>
    </section>
  `;
}

/**
 * Fila de certeza, plegable.
 *
 * Va inmediatamente bajo la nota y no enterrada al final: si el numero lleva
 * un «≈», el usuario tiene que poder saber por que sin buscarlo.
 */
export function confidenceRow(score: HealthScore, open: boolean): SafeHtml {
  const c = score.confidence;
  const encendidas = CONFIDENCE_BARS[c.level];
  const corto = c.missing.length
    ? `falta ${c.missing.slice(0, 2).join(' y ')}`
    : c.notes.length
      ? c.notes[0]!.replace(/^No consta (el |la )?/, 'falta ').replace(/[:.].*$/, '')
      : 'todos los datos que necesita el algoritmo';

  const largo = [
    score.range
      ? `La nota real estaría entre ${score.range.min} y ${score.range.max}.`
      : '',
    ...c.notes,
  ]
    .filter(Boolean)
    .join(' ');

  return html`
    <button
      class="confidence conf-${c.level}"
      data-action="toggle-confidence"
      aria-expanded="${ariaBool(open)}"
      ${raw(open ? 'aria-controls="confidence-detail"' : '')}
    >
      <span class="conf-bars" aria-hidden="true">
        ${[1, 2, 3].map(
          (n) => html`<span class="${n <= encendidas ? 'on' : ''}"></span>`,
        )}
      </span>
      <span class="conf-text"><strong>${CONFIDENCE_LABELS[c.level]}</strong> · ${corto}</span>
      <span class="chevron ${open ? 'open' : ''}" aria-hidden="true">▾</span>
    </button>
    ${open
      ? html`<div class="confidence-detail" id="confidence-detail">
          ${largo || 'Todos los datos que necesita el algoritmo están declarados y registrados.'}
        </div>`
      : raw('')}
  `;
}

// ---------------------------------------------------------------------------
// Capa 2 · Razones (bento)
// ---------------------------------------------------------------------------

/** Lo que se ve en grande dentro de cada bloque: el hecho, no el porcentaje. */
function blockFact(id: string, score: HealthScore): { fact: string; sub: string; grade?: string } {
  if (id === 'nutrition' && score.nutriscore) {
    const ns = score.nutriscore;
    // Sin el numero crudo: el logotipo ya dice la letra, y «-1 pts» en el
    // titular hace dudar de que el calculo este bien incluso a quien conoce el
    // algoritmo. El score y su escala viven en la evidencia, que es donde se
    // pueden explicar.
    return {
      fact: '',
      sub: `Nutri-Score 2023 · ${ns.negativePoints} puntos negativos frente a ${ns.positivePoints} positivos`,
      grade: ns.grade.toUpperCase(),
    };
  }
  if (id === 'processing') {
    return score.nova
      ? { fact: `NOVA ${score.nova.group}`, sub: score.nova.label }
      : { fact: 'Sin dato', sub: 'Se aplica un valor neutro, ni premia ni castiga' };
  }
  if (id === 'additives') {
    const n = score.additives.length;
    const riesgo = score.additives.filter((a) => a.risk === 'high' || a.risk === 'moderate').length;
    return {
      fact: String(n),
      sub: n === 0 ? 'Ninguno declarado' : riesgo ? `${riesgo} con riesgo de sobreexposición` : 'Ninguno con riesgo',
    };
  }
  const p = score.paho;
  if (!p?.applicable) return { fact: 'No aplica', sub: 'El modelo OPS cubre procesados y ultraprocesados' };
  return p.exceededCount === 0
    ? { fact: 'Sin sellos', sub: 'Ningún exceso según el perfil de nutrientes' }
    : {
        fact: `${p.exceededCount} ${p.exceededCount === 1 ? 'sello' : 'sellos'}`,
        sub: p.seals.filter((s) => s.exceeded).map((s) => PAHO_SEAL_LABELS[s.id]).join(', '),
      };
}

/**
 * Los cuatro bloques, con el area proporcional al peso.
 *
 * Que el bloque nutricional ocupe el ancho entero y el de advertencias sea una
 * franja baja no es estetica: es la unica forma de que la jerarquia visual
 * coincida con la del algoritmo (55 · 20 · 20 · 5). Con cuatro tarjetas
 * iguales, el usuario deduce que pesan lo mismo.
 */
export function reasonsBento(score: HealthScore): SafeHtml {
  return html`
    <section class="reasons" aria-labelledby="reasons-h">
      <div class="section-head">
        <h3 id="reasons-h">Por qué ${score.value}</h3>
        <span class="mono">pesos 55 · 20 · 20 · 5</span>
      </div>
      <div class="bento">
        ${score.breakdown.map((b) => {
          // `weight` es la fraccion del algoritmo (0,55), y `contribution` ya
          // viene multiplicada por ella. Para la interfaz hacen falta los dos
          // en la misma escala: 28 de 55, no 28 de 0,55.
          const tope = Math.round(b.weight * 100);
          const puntos = Math.round(b.contribution);
          const relleno = tope ? Math.max(0, Math.min(100, Math.round((puntos / tope) * 100))) : 0;
          const { fact, sub, grade } = blockFact(b.id, score);
          const ancho = b.id === 'nutrition' || b.id === 'regulatory' ? 'wide' : '';
          const bajo = b.id === 'regulatory' ? 'short' : '';
          const nivel = relleno >= 75 ? 'good' : relleno >= 40 ? 'mid' : 'bad';
          return html`
            <button class="tile ${ancho} ${bajo}" data-action="open-evidence" data-ev="${b.id}">
              <span class="tile-head">
                <span class="tile-label">${b.label}</span>
                <span class="mono tile-pts">${puntos}<span class="of">/${tope}</span></span>
              </span>
              <span class="tile-body">
                ${grade ? nutriscoreLogo(grade) : raw('')}
                <span class="tile-facts">
                  ${fact ? html`<span class="tile-fact">${fact}</span>` : raw('')}
                  <span class="tile-sub">${sub}</span>
                </span>
              </span>
              <span class="tile-bar ${nivel}" aria-hidden="true"
                ><span style="width:${relleno}%"></span
              ></span>
            </button>
          `;
        })}
      </div>
      ${sealsRow(score.paho)}
    </section>
  `;
}

/**
 * Sellos octogonales del modelo OPS.
 *
 * Se dibujan con la forma real del envase: es el unico lenguaje visual de esta
 * pantalla que el usuario ya conoce de antes de abrir la aplicacion.
 */
function sealsRow(paho?: PahoResult): SafeHtml {
  const excedidos = paho?.seals.filter((s) => s.exceeded) ?? [];
  if (excedidos.length === 0) return raw('');
  return html`
    <div class="seals" aria-label="Sellos de exceso del modelo OPS">
      ${excedidos.map(
        (s) => html`<div class="seal">${PAHO_SEAL_LABELS[s.id].toUpperCase()}</div>`,
      )}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Capa 3 · Evidencia
// ---------------------------------------------------------------------------

/** Una seccion plegable de evidencia. Cerrada por defecto: es la capa 3. */
function evidenceItem(
  id: string,
  title: string,
  meta: string,
  open: boolean,
  body: SafeHtml,
): SafeHtml {
  return html`
    <div class="ev" id="ev-${id}">
      <button data-action="toggle-evidence" data-ev="${id}" aria-expanded="${ariaBool(open)}">
        <span class="ev-title">${title}</span>
        ${meta ? html`<span class="ev-meta">${meta}</span>` : raw('')}
        <span class="chevron ${open ? 'open' : ''}" aria-hidden="true">▾</span>
      </button>
      ${open ? html`<div class="ev-body">${body}</div>` : raw('')}
    </div>
  `;
}

const evRow = (k: string, v: string, tone = ''): SafeHtml =>
  html`<div class="ev-row ${tone}"><span>${k}</span><span class="mono">${v}</span></div>`;

/** Nutri-Score punto por punto, que es lo que hace auditable la nota. */
/**
 * Escala de la categoria a la que pertenece el producto.
 *
 * Los cortes no son los mismos para todo: las bebidas tienen su propia escala
 * -- y en ellas la A esta reservada al agua -- y las grasas, aceites, frutos
 * secos y semillas otra. Medidos sobre esta misma implementacion, los extremos
 * posibles del score son -17 a 55 (general y grasas) y -18 a 50 (bebidas).
 */
export function gradeScale(flags: Product['categoryFlags']): {
  titulo: string;
  filas: Array<[grado: string, rango: string]>;
} {
  if (flags.isBeverage) {
    return {
      titulo: 'Escala de bebidas',
      filas: [
        ['A', 'solo el agua'],
        ['B', '−18 a 2'],
        ['C', '3 a 6'],
        ['D', '7 a 9'],
        ['E', '10 a 50'],
      ],
    };
  }
  if (flags.isFatOilNutsSeeds) {
    return {
      titulo: 'Escala de grasas, aceites, frutos secos y semillas',
      filas: [
        ['A', '−17 a −6'],
        ['B', '−5 a 2'],
        ['C', '3 a 10'],
        ['D', '11 a 18'],
        ['E', '19 a 55'],
      ],
    };
  }
  return {
    titulo: 'Escala general',
    filas: [
      ['A', '−17 a 0'],
      ['B', '1 a 2'],
      ['C', '3 a 10'],
      ['D', '11 a 18'],
      ['E', '19 a 55'],
    ],
  };
}

function nutriscoreEvidence(ns: NutriscoreResult, flags: Product['categoryFlags']): SafeHtml {
  // El logotipo tambien aqui: es el lenguaje que el usuario reconoce del
  // envase, y encabezar con el el desglose ata el numero a la letra.
  const fila = (c: NutriscoreResult['components']['negative'][number], max: number) =>
    evRow(
      `${COMPONENT_LABELS[c.id] ?? c.id}${
        c.value !== undefined ? ` · ${formatNum(c.value)}${c.unit ? ` ${c.unit}` : ''}` : ''
      }`,
      `${c.points} / ${max}`,
    );
  const esc = gradeScale(flags);
  const activa = ns.grade.toUpperCase();

  return html`
    <div class="ns-evidence-head">
      ${nutriscoreLogo(ns.grade, 'sm')}
      <span>Se suma lo que penaliza, se le resta lo que compensa, y el resultado da la letra.</span>
    </div>

    <div class="ev-group">Penalizan</div>
    ${ns.components.negative.map((c) => fila(c, c.pointsMax ?? 10))}

    <div class="ev-group">Compensan</div>
    ${ns.components.positive.map((c) => fila(c, c.pointsMax ?? 5))}
    ${!ns.countProteins
      ? html`<p class="ev-note">Las proteínas no cuentan aquí: ${ns.countProteinsReason}</p>`
      : raw('')}

    <!-- La operacion, escrita. Es lo que despeja la duda de si el numero esta
         bien: se ve de donde sale cada cifra y como se combinan. -->
    <div
      class="ns-formula"
      role="img"
      aria-label="${ns.negativePoints} puntos que penalizan menos ${ns.positivePoints} que compensan
        son ${ns.score}, que corresponde a la letra ${activa}"
    >
      <span class="term"><span class="n">${ns.negativePoints}</span><span class="l">penalizan</span></span>
      <span class="op" aria-hidden="true">−</span>
      <span class="term"><span class="n">${ns.positivePoints}</span><span class="l">compensan</span></span>
      <span class="op" aria-hidden="true">=</span>
      <span class="term res"><span class="n">${signed(ns.score)}</span><span class="l">puntuación</span></span>
      <span class="op" aria-hidden="true">→</span>
      <span class="term res"><span class="n">${activa}</span><span class="l">letra</span></span>
    </div>

    <div class="ns-scale" aria-label="${esc.titulo}: dónde cae este producto">
      <div class="ns-scale-head">${esc.titulo}</div>
      ${esc.filas.map(
        ([g, rango]) => html`
          <div class="ns-scale-row ${g === activa ? 'on' : ''}">
            <span class="g">${g}</span>
            <span class="r">${rango}</span>
            <span class="m">${g === activa ? 'este producto' : ''}</span>
          </div>
        `,
      )}
    </div>
    <p class="ev-note">
      Cuantos menos puntos, mejor: la puntuación es lo que penaliza menos lo que compensa, así que
      <strong>puede ser negativa</strong>, y una puntuación negativa es buena.
    </p>
    ${ns.missingInputs.length
      ? html`<p class="ev-note">
          Se contaron como 0 por no constar: ${ns.missingInputs.join(', ')}.
        </p>`
      : raw('')}
    <p class="ev-note">
      Algoritmo 2023 portado de la implementación de referencia de Open Food Facts, con 923
      aserciones contra productos reales.
    </p>
  `;
}

/** Signo menos tipografico (U+2212), no el guion del teclado. */
const signed = (n: number): string => (n < 0 ? `\u2212${Math.abs(n)}` : `+${n}`);

function formatNum(v: number): string {
  return new Intl.NumberFormat('es', { maximumFractionDigits: 2 }).format(v);
}

/**
 * El matiz que separa a Veskan de las aplicaciones que puntuan aditivos: se
 * mide el RIESGO de sobreexposicion real de la poblacion, no el PELIGRO
 * teorico de la sustancia al margen de la dosis.
 */
const RISK_EXPLANATION: Record<AdditiveAssessment['risk'], string> = {
  high: 'EFSA calcula si la exposición real de la población supera la ingesta diaria admisible (IDA). Aquí la supera incluso en consumo medio: penaliza de forma gradual, sin congelar la nota.',
  moderate:
    'EFSA calcula si la exposición real de la población supera la ingesta diaria admisible (IDA). Aquí la supera en el consumo alto de algunos grupos: penaliza de forma gradual, sin congelar la nota.',
  low: 'EFSA ha evaluado la exposición y el margen es holgado. La penalización es mínima.',
  none: 'EFSA ha evaluado la exposición y ningún grupo supera la ingesta diaria admisible. No penaliza.',
  unknown:
    'EFSA aún no ha publicado su reevaluación de sobreexposición para este aditivo. Se aplica la penalización mínima y se dice que no se sabe, en vez de suponerlo seguro.',
};

/**
 * El numero E, con su prefijo.
 *
 * La taxonomia lo guarda sin la «E» (`133`) pero el nombre si la lleva
 * (`E133 - Azul brillante FCF`), asi que mostrarlos juntos lo repetia.
 */
const eNumberOf = (a: AdditiveAssessment) => (a.eNumber ? `E${a.eNumber}` : '');

/** El nombre sin el numero E delante, que ya va en su propia columna. */
const additiveName = (a: AdditiveAssessment) =>
  a.name.replace(/^E\d+[a-z]?\s*[-–—]\s*/i, '');

const RISK_CHIP: Record<AdditiveAssessment['risk'], { label: string; glyph: string; cls: string }> = {
  high: { label: 'Riesgo alto', glyph: '▲', cls: 'risk-high' },
  moderate: { label: 'Riesgo moderado', glyph: '▲', cls: 'risk-moderate' },
  low: { label: 'Riesgo bajo', glyph: '●', cls: 'risk-low' },
  none: { label: 'Sin riesgo', glyph: '●', cls: 'risk-none' },
  unknown: { label: 'Sin evaluar', glyph: '○', cls: 'risk-unknown' },
};

/** Lista de aditivos. Cada uno abre su hoja con la evaluacion completa. */
function additivesEvidence(additives: AdditiveAssessment[]): SafeHtml {
  if (additives.length === 0) {
    return html`<p class="ev-text">No se han declarado aditivos en este producto.</p>`;
  }
  return html`
    ${additives.map((a) => {
      const chip = RISK_CHIP[a.risk];
      return html`
        <button class="add-row" data-action="open-additive" data-tag="${a.tag}">
          <span class="mono add-e">${eNumberOf(a)}</span>
          <span class="add-name">${additiveName(a)}</span>
          <span class="chip ${chip.cls}"><span aria-hidden="true">${chip.glyph}</span> ${chip.label}</span>
          <span class="chevron-right" aria-hidden="true">›</span>
        </button>
      `;
    })}
    <p class="ev-note">
      Se valora el riesgo de sobreexposición que evalúa EFSA, no el peligro teórico al margen de
      la dosis. Toca cada aditivo para ver su evaluación.
    </p>
  `;
}

/** Hoja de detalle de un aditivo. Es donde vive el matiz riesgo/peligro. */
export function additiveSheet(a: AdditiveAssessment): SafeHtml {
  const chip = RISK_CHIP[a.risk];
  const grupos = [...new Set([...a.overexposedGroupsMean, ...a.overexposedGroupsP95])]
    .map((g) => POPULATION_GROUP_LABELS[g] ?? g)
    .join(', ');
  return html`
    <div class="sheet-grip" aria-hidden="true"></div>
    <div class="add-head">
      <span class="mono">${eNumberOf(a)}</span>
      <span class="chip ${chip.cls}"><span aria-hidden="true">${chip.glyph}</span> ${chip.label}</span>
    </div>
    <h2>${additiveName(a)}</h2>
    <div class="add-classes">
      ${a.classes.map((c) => ADDITIVE_CLASS_LABELS[c] ?? c).join(' · ') || 'Aditivo alimentario'}
    </div>
    ${a.description ? html`<p class="add-desc">${a.description}</p>` : raw('')}
    <div class="add-what"><strong>Qué mide esto.</strong> ${RISK_EXPLANATION[a.risk]}</div>
    ${grupos
      ? html`<p class="add-groups">
          <strong>Supera la ingesta diaria admisible en:</strong> ${grupos}.
        </p>`
      : raw('')}
    <div class="add-foot">
      <span
        >Penalización aplicada:
        <strong class="mono">−${formatNum(Math.round(a.penalty * 10) / 10)} pts</strong></span
      >
      ${a.efsaEvaluationUrl
        ? html`<a href="${a.efsaEvaluationUrl}" target="_blank" rel="noopener"
            >Evaluación EFSA${a.efsaEvaluationDate ? ` (${a.efsaEvaluationDate})` : ''} ↗</a
          >`
        : raw('')}
    </div>
  `;
}

/**
 * Evidencia de NOVA.
 *
 * NOVA no es una formula: es una clasificacion publicada (Monteiro et al.) que
 * se asigna mirando los ingredientes. De donde sale el grupo cambia lo que
 * podemos afirmar, asi que se dice:
 *
 *   - si lo clasifico Open Food Facts, o lo dedujimos nosotros;
 *   - que marcadores concretos hay en ESTE producto.
 *
 * Antes solo se mostraba la definicion del grupo, que es la misma para todos
 * los productos y no dice nada del que el usuario tiene en la mano.
 */
function novaEvidence(score: HealthScore): SafeHtml {
  const nova = score.nova;
  if (!nova) {
    return html`<p class="ev-text">
      Open Food Facts no ha podido determinar el grado de procesamiento, y tampoco se ha podido
      deducir de los ingredientes declarados. Se aplica un valor neutro: ni premia ni castiga.
    </p>`;
  }

  // Los aditivos ya evaluados traen su nombre; el marcador solo el tag.
  const nombreDe = (tag: string): string =>
    score.additives.find((a) => a.tag === tag)?.name.replace(/^E\d+[a-z]?\s*[-–—]\s*/i, '') ??
    tag.replace('en:', '').toUpperCase();

  return html`
    <div class="origin">
      <span class="origin-tag">${nova.fromSource ? 'Open Food Facts' : 'Deducido por Veskan'}</span>
      <span
        >${nova.fromSource
          ? 'El grupo lo asigna la base de datos a partir de los ingredientes declarados.'
          : 'La base no traía el grupo. Lo deducimos de los ingredientes, y solo hacia arriba: nunca afirmamos que algo esté sin procesar si no consta.'}</span
      >
    </div>

    ${nova.markers.length
      ? html`
          <div class="ev-group">Marcadores de ultraprocesamiento en este producto</div>
          ${nova.markers.map((m) =>
            m.kind === 'additive'
              ? evRow(
                  nombreDe(m.value),
                  m.additiveClass ? (ADDITIVE_CLASS_LABELS[m.additiveClass] ?? 'aditivo industrial') : 'aditivo industrial',
                  'plain',
                )
              : evRow(`«${m.value}»`, 'en los ingredientes', 'plain'),
          )}
        `
      : html`<p class="ev-note">
          No se han encontrado marcadores de ultraprocesamiento en los ingredientes declarados.
        </p>`}

    <p class="ev-text" style="margin-top:12px">
      <strong>NOVA ${nova.group}.</strong> ${NOVA_DESCRIPTIONS[nova.group]}
    </p>
    <p class="ev-note">
      Clasificación NOVA (Monteiro et al., Universidad de São Paulo). No es una fórmula: agrupa los
      alimentos por cuánto se han transformado, no por sus nutrientes. Por eso se puntúa aparte del
      Nutri-Score y nunca se funden en una sola cifra.
    </p>
  `;
}

/** Tabla nutricional por 100 g, tal cual la declara el envase. */
function nutrientsEvidence(product: Product): SafeHtml {
  const n = product.nutriments;
  const filas: Array<[string, number | undefined, string]> = [
    ['Energía', n.energyKcal, ' kcal'],
    ['Grasas', n.fat, ' g'],
    ['  de las cuales saturadas', n.saturatedFat, ' g'],
    ['Hidratos de carbono', n.carbohydrates, ' g'],
    ['  de los cuales azúcares', n.sugars, ' g'],
    ['Fibra', n.fiber, ' g'],
    ['Proteínas', n.proteins, ' g'],
    ['Sal', n.salt, ' g'],
  ];
  const presentes = filas.filter(([, v]) => v !== undefined);
  if (presentes.length === 0) {
    return html`<p class="ev-text">Este producto no tiene tabla nutricional registrada.</p>`;
  }
  return html`${presentes.map(([k, v, u]) => evRow(k, `${formatNum(v!)}${u}`, 'plain'))}`;
}

/** El bloque de evidencia entero. `open` dice cuales estan desplegadas. */
export function evidence(product: Product, score: HealthScore, open: Set<string>): SafeHtml {
  const secciones: Array<[string, string, string, SafeHtml] | null> = [
    score.nutriscore
      ? [
          'nutrition',
          'Nutri-Score, punto por punto',
          `${signed(score.nutriscore.score)} · ${score.nutriscore.grade.toUpperCase()}`,
          nutriscoreEvidence(score.nutriscore, product.categoryFlags),
        ]
      : null,
    [
      'processing',
      'Procesamiento · NOVA',
      score.nova ? `NOVA ${score.nova.group}` : 'sin dato',
      novaEvidence(score),
    ],
    [
      'additives',
      'Aditivos',
      score.additives.length ? String(score.additives.length) : 'ninguno',
      additivesEvidence(score.additives),
    ],
    [
      'regulatory',
      'Advertencias OPS/OMS',
      score.paho?.applicable
        ? score.paho.exceededCount
          ? `${score.paho.exceededCount} ${score.paho.exceededCount === 1 ? 'sello' : 'sellos'}`
          : 'sin sellos'
        : 'no aplica',
      pahoEvidence(score.paho),
    ],
    ['nutrients', 'Tabla nutricional · 100 g', '', nutrientsEvidence(product)],
    product.ingredientsText
      ? [
          'ingredients',
          'Ingredientes y alérgenos',
          '',
          html`<p class="ev-text">${product.ingredientsText}</p>
            <p class="ev-note">
              Alérgenos:
              ${product.allergenTags.length
                ? product.allergenTags.map((t) => t.replace(/^[a-z]{2}:/, '')).join(', ')
                : 'ninguno declarado'}.
            </p>`,
        ]
      : null,
  ];

  return html`
    <section class="evidence" aria-labelledby="evidence-h">
      <h3 id="evidence-h">Evidencia</h3>
      <div class="ev-list">
        ${secciones
          .filter((s): s is [string, string, string, SafeHtml] => s !== null)
          .map(([id, t, m, body]) => evidenceItem(id, t, m, open.has(id), body))}
      </div>
      ${sourceNote(product)}
      <p class="fineprint">
        Algoritmo ${score.algorithmVersion}, publicado y verificable. Esta aplicación es
        informativa y no sustituye el consejo de un profesional sanitario.
      </p>
    </section>
  `;
}

function pahoEvidence(paho?: PahoResult): SafeHtml {
  if (!paho?.applicable) {
    return html`<p class="ev-text">
      El modelo de perfil de nutrientes de la OPS solo se aplica a productos procesados y
      ultraprocesados (NOVA 3 y 4). Este no lo es.
    </p>`;
  }
  return html`
    ${paho.seals.map((s) =>
      evRow(
        `${PAHO_SEAL_LABELS[s.id]}${s.actual !== undefined ? ` · ${formatNum(s.actual)} ${s.unit}` : ''}`,
        `${s.exceeded ? '≥' : '<'} ${formatNum(s.threshold)} ${s.unit}`,
        s.exceeded ? 'exceeded' : '',
      ),
    )}
    ${paho.seals.some((s) => s.estimated)
      ? html`<p class="ev-note">
          Los azúcares libres se han estimado a partir de los azúcares totales: el envase no los
          declara por separado.
        </p>`
      : raw('')}
    <p class="ev-note">
      Modelo base de los sellos octogonales de Chile, Perú, México y Uruguay.
    </p>
  `;
}

/** De donde salen los datos y como corregirlos. Va al pie de la evidencia. */
export function sourceNote(product: Product): SafeHtml {
  const fecha = product.lastModified
    ? new Date(product.lastModified).toLocaleDateString('es')
    : undefined;
  return html`
    <p class="fineprint">
      ${raw(SOURCE_SENTENCE[product.source])}${fecha ? `, editados el ${fecha}` : ''}. Base
      colaborativa bajo licencia ODbL.
      ${product.editUrl
        ? html`<a href="${product.editUrl}" target="_blank" rel="noopener"
            >¿Ves algo mal? Corrígelo.</a
          >`
        : raw('')}
    </p>
  `;
}

// ---------------------------------------------------------------------------
// Cosmetica: banderas, sin nota
// ---------------------------------------------------------------------------

const SEVERITY: Record<
  CosmeticAssessment['flags'][number]['severity'],
  { label: string; glyph: string; cls: string }
> = {
  prohibited: { label: 'Prohibido', glyph: '■', cls: 'sev-prohibited' },
  restricted: { label: 'Restringido', glyph: '▲', cls: 'sev-restricted' },
  allergen: { label: 'Alérgeno', glyph: '●', cls: 'sev-allergen' },
  info: { label: 'Info', glyph: '○', cls: 'sev-info' },
};

/**
 * Vista de cosmetica.
 *
 * El hueco donde iria la nota dice «SIN NOTA, a proposito» y se explica al
 * lado. Dejarlo vacio pareceria un fallo de carga; poner un numero seria peor:
 * una cifra tipo EWG confunde peligro con riesgo, ignora la dosis, la via de
 * exposicion y si el producto se aclara.
 */
export function cosmeticView(product: Product, a: CosmeticAssessment): SafeHtml {
  const marca = product.brands?.join(', ');
  const sub = [marca, product.quantity].filter(Boolean).join(' · ');
  const porSeveridad = (s: keyof typeof SEVERITY) => a.flags.filter((f) => f.severity === s).length;

  return html`
    <section class="verdict" aria-label="Producto de cosmética">
      <div class="dial dial-none" role="img" aria-label="Sin puntuación: es un producto de cosmética">
        <div class="dial-inner">
          <div class="dial-nonum">SIN NOTA</div>
          <div class="dial-of">a propósito</div>
        </div>
      </div>
      <div class="verdict-text">
        <span class="band-pill band-neutral">Cosmética</span>
        <h2>${product.name ?? 'Producto sin nombre'}</h2>
        ${sub ? html`<div class="verdict-sub">${sub}</div>` : raw('')}
      </div>
    </section>

    <div class="explain">
      <strong>Por qué no hay número.</strong> Una cifra tipo EWG confunde peligro con riesgo:
      ignora la dosis, la vía y si el producto se enjuaga. Mostramos lo verificable: situación
      regulatoria (Reglamento CE 1223/2009) y alérgenos de declaración obligatoria.
    </div>

    ${a.hasFullInciList
      ? html`
          <section class="reasons">
            <div class="section-head">
              <h3>Banderas de la fórmula</h3>
              <span class="mono">${a.flags.length} de ${a.totalIngredients} ingredientes</span>
            </div>
            <div class="sev-counts">
              ${(['prohibited', 'restricted', 'allergen', 'info'] as const).map(
                (s) => html`
                  <div class="sev-count">
                    <div class="sev-n ${porSeveridad(s) ? SEVERITY[s].cls : ''}">${porSeveridad(s)}</div>
                    <div class="sev-l">${SEVERITY[s].label}</div>
                  </div>
                `,
              )}
            </div>
            ${a.flags.length
              ? html`<div class="flag-list">
                  ${a.flags.map(
                    (f) => html`
                      <div class="flag">
                        <div class="flag-head">
                          <strong>${f.ingredient}</strong>
                          <span class="chip ${SEVERITY[f.severity].cls}"
                            ><span aria-hidden="true">${SEVERITY[f.severity].glyph}</span>
                            ${SEVERITY[f.severity].label}</span
                          >
                        </div>
                        <p>${f.message}</p>
                        ${f.reference ? html`<p class="flag-ref">${f.reference}</p>` : raw('')}
                      </div>
                    `,
                  )}
                </div>`
              : html`<p class="ev-text">
                  Ningún ingrediente de la fórmula está prohibido, restringido ni es un alérgeno de
                  declaración obligatoria.
                </p>`}
            <div class="confidence conf-high" role="note">
              <span class="conf-bars" aria-hidden="true"
                ><span class="on"></span><span class="on"></span><span class="on"></span
              ></span>
              <span class="conf-text"
                ><strong>Fórmula completa</strong> · ${a.recognizedIngredients}/${a.totalIngredients}
                ingredientes INCI reconocidos</span
              >
            </div>
          </section>
        `
      : html`
          <section class="empty-block">
            <span class="conf-bars warn" aria-hidden="true"
              ><span class="on"></span><span></span><span></span
            ></span>
            <div class="empty-title">Fórmula no declarada</div>
            <p>
              No hay lista INCI en la base. Sin ella no podemos comprobar nada: eso es un problema
              de transparencia del registro, no una nota negativa del producto.
            </p>
          </section>
        `}
    ${sourceNote(product)}
  `;
}

// ---------------------------------------------------------------------------
// Composicion
// ---------------------------------------------------------------------------

export interface ResultUi {
  /** Secciones de evidencia desplegadas */
  evidenceOpen: Set<string>;
  /** La fila de certeza esta abierta */
  confidenceOpen: boolean;
}

/** Arma el resultado completo: veredicto, razones y evidencia, en ese orden. */
export function assessmentView(assessment: Assessment, ui: ResultUi): SafeHtml {
  if (assessment.kind === 'cosmetic') {
    return cosmeticView(assessment.product, assessment.assessment);
  }
  const { product, score } = assessment;
  return html`
    ${verdict(product, score)} ${confidenceRow(score, ui.confidenceOpen)}
    ${reasonsBento(score)} ${evidence(product, score, ui.evidenceOpen)}
  `;
}
