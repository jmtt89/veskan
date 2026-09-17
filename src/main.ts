/**
 * Punto de entrada. Compone la aplicacion y gestiona la navegacion.
 *
 * Todo el analisis ocurre en el navegador: no hay backend propio. Las unicas
 * peticiones externas son a Open Food Facts (que permite CORS) y al snapshot
 * estatico servido por CDN.
 */

import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { html, mount, raw, type SafeHtml } from './ui/render.js';
import { additiveSheet, assessmentView } from './ui/components.js';
import { OffClient, OffRateLimitError } from './core/data/off.js';
import { hasUsableData, ProductNotFoundError, ProductRepository } from './core/data/repository.js';
import { guessCountry, loadSnapshotIndex } from './core/data/sqlite-http/snapshot-index.js';
import { CatalogManager, type CatalogView } from './core/data/catalog-manager.js';
import { loadScoringContext } from './core/data/taxonomies.js';
import {
  CameraScanner,
  isValidEan,
  normalizeBarcode,
  scanFromFile,
  type ScannerDiagnostics,
} from './core/scanner/barcode.js';
import { classifyBarcode } from './core/scanner/gs1.js';
import {
  clearHistory,
  clearRecent,
  exportContributions,
  listHistory,
  queueContribution,
  restoreHistory,
  toggleStar,
  type HistoryEntry,
} from './core/data/idb.js';
import { BAND_LABELS } from './core/scoring/engine.js';
import { FEATURES } from './core/features.js';
import type { AdditiveAssessment, Assessment } from './core/types.js';

const APP_NAME = 'Veskan';
const APP_VERSION = '0.1.0';

/**
 * Carpeta donde viven los snapshots por pais (capa L1).
 *
 * Se sirven desde `raw.githubusercontent.com` y NO desde GitHub Pages, por un
 * motivo que costo encontrar: **Pages comprime los archivos con gzip y aplica
 * los rangos HTTP al flujo comprimido**. Verificado el 2026-09-17:
 *
 *   Pages, HEAD sin Accept-Encoding  -> content-length: 1105920  (real)
 *   Pages, HEAD como un navegador    -> content-length:  317532  (comprimido)
 *   Pages, Range 4096-8191           -> content-range: .../317532 y bytes que
 *                                       no corresponden al archivo
 *
 * SQLite devolvia SQLITE_CORRUPT. Con curl no se reproducia porque curl no pide
 * compresion: solo fallaba en navegadores. jsDelivr hace lo mismo.
 *
 * `raw.githubusercontent.com` no comprime, respeta los rangos sobre los bytes
 * reales y responde `access-control-allow-origin: *`.
 *
 * Se usa `||` y no `??`: cuando una variable de GitHub Actions no esta
 * definida, la expresion se sustituye por CADENA VACIA, que `??` no atrapa.
 */
const SNAPSHOT_BASE_URL: string =
  import.meta.env.VITE_SNAPSHOT_URL ||
  'https://raw.githubusercontent.com/jmtt89/veskan-data/data';


type View = 'scan' | 'result' | 'history' | 'search' | 'more';
/** Subpantallas de «Mas». Viven aparte para que la pestana no cambie al entrar. */
type MoreView = 'index' | 'country' | 'method' | 'privacy' | 'contribute';

interface AppState {
  view: View;
  loading: boolean;
  error?: string;
  assessment?: Assessment;
  pendingBarcode?: string;
  history: HistoryEntry[];
  searchResults: Assessment['product'][];
  scannerActive: boolean;
  snapshotAvailable: boolean;
  diagnostics?: ScannerDiagnostics;
  torchOn: boolean;
  /** El producto existe en la base pero sin datos suficientes para evaluarlo */
  sparseProduct: boolean;
  /** Catalogos publicados, con su estado en este dispositivo */
  catalogs: CatalogView[];
  /** El codigo no puede resolverse en ninguna base global (interno, libro, cupon) */
  unresolvableBarcode?: boolean;

  // --- Navegacion ---
  moreView: MoreView;
  contributeForm: boolean;
  histTab: 'all' | 'star';

  // --- Resultado: que hay desplegado ---
  /** Secciones de evidencia abiertas. Todas cerradas por defecto: son la capa 3. */
  evidenceOpen: Set<string>;
  confidenceOpen: boolean;
  /** Aditivo cuya hoja de detalle esta abierta */
  additiveOpen?: AdditiveAssessment;

  // --- Busqueda ---
  searchTerm: string;
  searching: boolean;
  /** El campo de busqueda tenia el foco: hay que devolverselo tras el render */
  searchFocus: boolean;
  recentSearches: string[];

  // --- Hojas y avisos ---
  manualOpen: boolean;
  manualCode: string;
  clearAsk: boolean;
  toast?: { text: string; action?: string };
  /** Que hacer si se pulsa la accion del toast. Fuera del estado serializable. */
  toastAction?: () => void;

  // --- Camara ---
  diagOpen: boolean;
  torchAvailable: boolean;
  cameraProblem?: { kind: 'denied' | 'error'; detail?: string };

  // --- Entorno ---
  online: boolean;
  rateLimited: boolean;
  installReady: boolean;
  updateReady: boolean;
}

const state: AppState = {
  view: 'scan',
  loading: false,
  history: [],
  searchResults: [],
  scannerActive: false,
  snapshotAvailable: false,
  catalogs: [],
  torchOn: false,
  sparseProduct: false,
  moreView: 'index',
  contributeForm: false,
  histTab: 'all',
  evidenceOpen: new Set(),
  confidenceOpen: false,
  searchTerm: '',
  searching: false,
  searchFocus: false,
  recentSearches: [],
  manualOpen: false,
  manualCode: '',
  clearAsk: false,
  diagOpen: false,
  torchAvailable: false,
  online: navigator.onLine,
  rateLimited: false,
  installReady: false,
  updateReady: false,
};

const off = new OffClient({
  appName: APP_NAME,
  appVersion: APP_VERSION,
  lang: 'es',
});

const repo = new ProductRepository({
  off,
  scoringContext: () => loadScoringContext(),
});

/**
 * Gestor de catalogos. Se crea al leer el indice publicado.
 *
 * Sustituye al modelo anterior de "un pais elegido en un desplegable": ahora
 * pueden convivir varios descargados, y los que no lo esten se consultan por
 * rangos antes de recurrir a la API.
 */
let catalogs: CatalogManager | undefined;

const root = document.getElementById('app')!;
let scanner: CameraScanner | undefined;

/**
 * El <video> se crea UNA sola vez y sobrevive a los re-renders.
 *
 * Es necesario: `render()` reconstruye el DOM con innerHTML, lo que destruiria
 * el elemento y dejaria al escaner analizando un nodo desconectado. La camara
 * seguiria encendida pero ya no se veria ni se decodificaria nada. Tras cada
 * render se vuelve a insertar este mismo nodo en su contenedor.
 */
const videoEl = document.createElement('video');
videoEl.muted = true;
videoEl.setAttribute('playsinline', 'true');
videoEl.setAttribute('autoplay', 'true');

/**
 * Refresca SOLO la fila del pais que cambio.
 *
 * Un `render()` completo reconstruye el DOM con innerHTML y **pierde el foco**,
 * lo que durante una descarga dejaria al teclado y al lector de pantalla sin
 * referencia cada vez que avanza la barra.
 */
function updateCatalogRow(country: string): void {
  if (!catalogs) return;
  const view = catalogs.get(country);
  if (!view) return;
  state.catalogs = catalogs.list();

  const fila = document.getElementById(`catalog-${country}`);
  if (!fila) {
    if (state.view === 'more') render();
    return;
  }
  const nueva = document.createElement('div');
  nueva.innerHTML = catalogRow(view).value;
  const reemplazo = nueva.firstElementChild;
  if (!reemplazo) return;

  // Si el foco estaba dentro de la fila, se devuelve al boton que la fila tenga
  // AHORA, que no es el mismo: "Descargar" pasa a "Descargando..." y luego a
  // "Eliminar". Buscar la accion anterior dejaria el foco en el body justo al
  // empezar y al terminar la descarga.
  const teniaFoco = fila.contains(document.activeElement);
  fila.replaceWith(reemplazo);
  if (teniaFoco) reemplazo.querySelector<HTMLElement>('.catalog-actions button')?.focus();

  // El recuento vive fuera de la fila, asi que no se arregla solo.
  const resumen = document.getElementById('catalog-summary');
  if (resumen) resumen.textContent = catalogSummary();
}

// ---------------------------------------------------------------------------
// Chrome: cabecera, pestanas, hojas
// ---------------------------------------------------------------------------

/**
 * Cabecera de vidrio.
 *
 * El fondo va al 78% de opacidad como minimo: el contraste del texto se mide
 * contra el peor caso, que es video claro de la camara pasando por debajo.
 */
function glassHeader(title: string, opts: { back?: boolean; right?: SafeHtml } = {}): SafeHtml {
  return html`
    <header class="glass-header">
      ${opts.back
        ? html`<button class="icon-btn" data-action="back" aria-label="Volver">‹</button>`
        : raw('')}
      <h1>${title}</h1>
      <div class="spacer"></div>
      ${opts.right ?? raw('')}
    </header>
  `;
}

/**
 * Cuatro destinos, no cinco.
 *
 * Participar (que ademas esta inactivo) y Metodo se van a «Mas»; Guardado
 * absorbe los favoritos. Cinco pestanas obligan a leer para elegir; cuatro se
 * reconocen de un vistazo, y ninguna de las que quedan es un callejon.
 */
function tabbar(): SafeHtml {
  const tabs: Array<[View, string, string]> = [
    ['scan', 'Escanear', 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18'],
    ['search', 'Buscar', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35'],
    ['history', 'Guardado', 'M12 8v4l3 3M3.05 11a9 9 0 1 1 .5 4M3 4v5h5'],
    ['more', 'Más', 'M5 12h.01M12 12h.01M19 12h.01'],
  ];
  return html`
    <nav class="tabbar" aria-label="Navegación principal">
      ${tabs.map(([id, label, path]) => {
        // El resultado pertenece al escaner: la pestana no debe saltar.
        const activa = state.view === id || (id === 'scan' && state.view === 'result');
        return html`
          <button
            data-action="nav"
            data-view="${id}"
            class="${activa ? 'current' : ''}"
            ${raw(activa ? 'aria-current="page"' : '')}
          >
            <span class="tab-pill">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="${path}" />
              </svg>
            </span>
            ${label}
          </button>
        `;
      })}
    </nav>
  `;
}

/** Aviso efimero. Lleva accion cuando lo que paso se puede deshacer. */
function toastEl(): SafeHtml {
  if (!state.toast) return raw('');
  return html`
    <div class="toast" role="status" aria-live="polite">
      <span>${state.toast.text}</span>
      ${state.toast.action
        ? html`<button data-action="toast-action">${state.toast.action}</button>`
        : raw('')}
    </div>
  `;
}

/**
 * Teclado numerico propio para el codigo de barras.
 *
 * El del sistema tarda en aparecer, tapa media pantalla y ofrece letras que
 * aqui no valen. Con uno propio, las teclas caen en la zona del pulgar y el
 * campo valida a medida que se escribe.
 */
/**
 * Hoja para escribir el codigo a mano.
 *
 * El campo es un `<input>` de verdad y no un recuadro pintado: asi funcionan el
 * teclado fisico del ordenador y el pegado (Ctrl+V, o la pulsacion larga en el
 * movil). `inputmode="none"` evita que ademas salte el teclado del sistema en
 * el movil, que taparia el nuestro y ofreceria letras que aqui no valen.
 */
function manualSheet(): SafeHtml {
  if (!state.manualOpen) return raw('');
  const codigo = state.manualCode;

  // El teclado propio ocupa la zona del pulgar; el hueco de abajo a la
  // izquierda queda vacio y el borrado a la DERECHA del cero, que es donde lo
  // ponen el teclado numerico de iOS y los marcadores de telefono.
  const teclas = [...'123456789'].map((d) => ({ label: d, aria: d, cls: 'num' }));
  teclas.push(
    { label: '', aria: '', cls: 'hueco' },
    { label: '0', aria: '0', cls: 'num' },
    { label: '⌫', aria: 'Borrar el último dígito', cls: 'fn' },
  );

  return html`
    <div class="scrim" data-action="close-manual"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="manual-h">
      <div class="sheet-grip" aria-hidden="true"></div>
      <h2 id="manual-h">Escribe el código de barras</h2>

      <div class="manual-field">
        <input
          id="manual-input"
          type="text"
          inputmode="none"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          maxlength="13"
          aria-label="Código de barras"
          aria-describedby="manual-hint"
          value="${codigo}"
        />
        <button class="paste-btn" data-action="paste">Pegar</button>
      </div>
      <div class="manual-hint" id="manual-hint" aria-live="polite">${manualHint(codigo)}</div>

      <div class="keypad">
        ${teclas.map((k) =>
          k.cls === 'hueco'
            ? html`<span class="key hueco" aria-hidden="true"></span>`
            : html`<button class="key ${k.cls}" data-action="key" data-key="${k.label}" aria-label="${k.aria}">
                ${k.label}
              </button>`,
        )}
      </div>

      <button class="primary" data-action="manual-lookup" ${raw(isValidEan(codigo) ? '' : 'disabled')}>
        Buscar
      </button>
    </div>
  `;
}

/** Texto de ayuda bajo el campo. Cambia mientras se escribe. */
function manualHint(codigo: string): string {
  if (!codigo) return 'EAN-8, UPC o EAN-13. Está bajo las barras.';
  if (isValidEan(codigo)) return `${codigo.length} dígitos · listo`;
  if (codigo.length >= 13) return `${codigo.length} dígitos · el dígito de control no cuadra`;
  return `${codigo.length} dígitos`;
}

/**
 * Refresca la hoja SIN volver a renderizar.
 *
 * Un `render()` reconstruye el DOM y el campo perderia el foco y el cursor en
 * cada pulsacion, que es justo lo que rompe escribir con el teclado fisico.
 */
function syncManual(): void {
  const input = document.getElementById('manual-input') as HTMLInputElement | null;
  if (input && input.value !== state.manualCode) input.value = state.manualCode;
  const hint = document.getElementById('manual-hint');
  if (hint) hint.textContent = manualHint(state.manualCode);
  const buscar = document.querySelector<HTMLButtonElement>('[data-action="manual-lookup"]');
  if (buscar) buscar.disabled = !isValidEan(state.manualCode);
}

/** Hoja de detalle de un aditivo. */
function additiveSheetEl(): SafeHtml {
  if (!state.additiveOpen) return raw('');
  return html`
    <div class="scrim" data-action="close-additive"></div>
    <div class="sheet" role="dialog" aria-modal="true">${additiveSheet(state.additiveOpen)}</div>
  `;
}

/** Confirmacion de vaciado. Respeta los favoritos y deja deshacer. */
function clearSheet(): SafeHtml {
  if (!state.clearAsk) return raw('');
  const n = state.history.filter((h) => !h.starred).length;
  return html`
    <div class="scrim" data-action="cancel-clear"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="clear-h">
      <div class="sheet-grip" aria-hidden="true"></div>
      <h2 id="clear-h">¿Vaciar los recientes?</h2>
      <p class="sheet-body">
        Se borran ${n} ${n === 1 ? 'producto' : 'productos'} de este dispositivo. Los favoritos se
        quedan. Tendrás unos segundos para deshacer.
      </p>
      <button class="danger" data-action="do-clear">Vaciar recientes</button>
      <button class="ghost" data-action="cancel-clear">Cancelar</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// V1 · Escanear
// ---------------------------------------------------------------------------

/** Chip de conexion. Comunica que sin red la app sigue sirviendo. */
function onlineChip(): SafeHtml {
  const guardados = catalogs?.downloadedCountries.length ?? 0;
  const texto = state.online ? 'En línea' : guardados ? 'Sin red · copia local' : 'Sin red';
  return html`
    <span class="chip-status ${state.online ? 'on' : 'off'}" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>${texto}
    </span>
  `;
}

function diagnosticsPanel(): SafeHtml {
  const d = state.diagnostics;
  if (!d || !state.diagOpen) return raw('');
  return html`
    <div class="diag" role="region" aria-label="Diagnóstico del escáner">
      <div class="diag-grid">
        <span>Motor</span><span>${d.engine === 'native' ? 'nativo del navegador' : 'zxing-wasm'}</span>
        <span>Resolución</span><span>${d.resolution ?? '—'}</span>
        <span>Fotogramas</span><span>${d.framesAnalyzed}</span>
        <span>Detecciones</span><span>${d.detections}</span>
        <span>Descartes (dígito control)</span><span>${d.rejectedByChecksum}</span>
        <span>Último error</span><span>${d.lastError ?? '—'}</span>
      </div>
      ${d.engine === 'zxing'
        ? html`<p>
            Sin detector nativo en este navegador. Si la cámara no enfoca de cerca,
            <strong>Foto</strong> es el camino fiable: el sistema enfoca y captura a resolución
            completa.
          </p>`
        : raw('')}
    </div>
  `;
}

/**
 * Escaner a pantalla completa.
 *
 * Todo lo pulsable vive en el tercio inferior. Antes, el boton de activar la
 * camara quedaba bajo una cabecera y una tarjeta: en un movil grande, sujeto
 * con una mano en el pasillo del supermercado, eso esta fuera del alcance del
 * pulgar.
 */
function scanView(): SafeHtml {
  const activo = state.scannerActive;
  const problema = state.cameraProblem;

  return html`
    <div class="screen scan">
      <div class="stage" id="stage">
        ${activo
          ? html`<div class="reticle" aria-hidden="true"><span class="sweep"></span></div>`
          : html`<div class="reticle idle" aria-hidden="true">
              <div>
                <div class="reticle-t">Apunta al código de barras</div>
                <div class="reticle-s">Veredicto en menos de tres segundos, y el porqué debajo.</div>
              </div>
            </div>`}
      </div>

      <header class="glass-header over">
        <img src="icons/favicon.svg" alt="" width="24" height="24" />
        <h1>Veskan</h1>
        <div class="spacer"></div>
        ${onlineChip()}
        ${activo && state.diagnostics
          ? html`<button
              class="chip-status mono"
              data-action="toggle-diag"
              aria-expanded="${state.diagOpen}"
            >
              ${state.diagnostics.engine === 'native' ? 'nativo' : 'WASM'}
            </button>`
          : raw('')}
      </header>
      ${diagnosticsPanel()}

      ${problema
        ? html`<div class="overlay-card">
            <div class="overlay-icon ${problema.kind === 'denied' ? 'warn' : 'bad'}">
              ${problema.kind === 'denied' ? '!' : '×'}
            </div>
            <div class="overlay-title">
              ${problema.kind === 'denied' ? 'La cámara está bloqueada' : 'No se pudo abrir la cámara'}
            </div>
            <p>
              ${problema.kind === 'denied'
                ? 'Lo denegaste antes. Puedes permitirla en los ajustes del navegador, o seguir sin ella: la foto y el código a mano funcionan igual.'
                : 'Otra aplicación la está usando, o este dispositivo no tiene.'}
              ${problema.detail ? html`<span class="mono">${problema.detail}</span>` : raw('')}
            </p>
            ${problema.kind === 'denied'
              ? raw('')
              : html`<button class="primary" data-action="start-camera">Reintentar</button>`}
            <label class="secondary as-button" for="photo-input">Escanear desde una foto</label>
            <button class="ghost" data-action="open-manual">Escribir el código</button>
          </div>`
        : raw('')}

      ${state.loading && state.view === 'scan'
        ? html`<div class="scan-loading" role="status" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <span>
              <strong>Código leído</strong>
              <span class="mono">${state.pendingBarcode ?? ''} · buscando…</span>
            </span>
          </div>`
        : raw('')}

      <div class="thumb-zone">
        ${state.installReady && !activo
          ? html`<div class="install-card">
              <img src="icons/icon-192.png" alt="" width="32" height="32" />
              <div>
                <strong>Añadir a la pantalla de inicio</strong>
                <span>Abre en un toque en el súper, también sin cobertura.</span>
              </div>
              <button data-action="install" class="mini primary">Añadir</button>
              <button data-action="dismiss-install" class="icon-btn" aria-label="Cerrar">×</button>
            </div>`
          : raw('')}
        ${activo
          ? html`
              <div class="trio">
                <label class="tool" for="photo-input"><span aria-hidden="true">▣</span>Foto</label>
                <button class="tool" data-action="open-manual">
                  <span class="mono" aria-hidden="true">123</span>Código
                </button>
                <button
                  class="tool ${state.torchOn ? 'on' : ''}"
                  data-action="toggle-torch"
                  aria-pressed="${state.torchOn}"
                  ${raw(state.torchAvailable ? '' : 'disabled')}
                >
                  <span aria-hidden="true">☀</span>${state.torchOn ? 'Luz on' : 'Linterna'}
                </button>
              </div>
              <button class="ghost" data-action="stop-camera">Detener cámara</button>
            `
          : html`
              <button class="primary big" data-action="start-camera">Activar cámara</button>
              <div class="duo">
                <label class="secondary as-button" for="photo-input">Desde una foto</label>
                <button class="secondary" data-action="open-manual">Escribir código</button>
              </div>
            `}
      </div>

      <input type="file" id="photo-input" accept="image/*" capture="environment" hidden />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// V2/V3 · Resultado
// ---------------------------------------------------------------------------

/** Problemas del resultado: cada uno ofrece el camino alternativo concreto. */
function resultProblem(): SafeHtml {
  const codigo = state.pendingBarcode ?? '';
  let glyph = '∅';
  let tone = 'dim';
  let title = 'No está en ninguna base abierta';
  let body = state.error ?? '';
  let primary = html`<button class="primary" data-action="nav" data-view="more" data-more="contribute">
    Añadir este producto
  </button>`;
  let secondary = html`<button class="ghost" data-action="nav" data-view="scan">Escanear otro</button>`;

  if (state.sparseProduct) {
    glyph = '?';
    tone = 'warn';
    title = 'Está en la base, pero vacío';
  } else if (state.unresolvableBarcode) {
    glyph = '⊘';
    tone = 'dim';
    title = 'Ese código no identifica un producto';
    primary = html`<button class="primary" data-action="nav" data-view="scan">Escanear otro</button>`;
    secondary = raw('');
  } else if (!state.online) {
    glyph = '⇣';
    tone = 'bad';
    title = 'Sin conexión';
    primary = html`<button class="primary" data-action="retry">Reintentar</button>`;
    secondary = html`<button class="ghost" data-action="nav" data-view="more" data-more="country">
      Descargar la copia de tu país
    </button>`;
  } else if (state.rateLimited) {
    glyph = '⏱';
    tone = 'warn';
    title = 'Demasiadas consultas seguidas';
    primary = html`<button class="primary" data-action="retry">Reintentar ahora</button>`;
    secondary = html`<button class="ghost" data-action="nav" data-view="more" data-more="country">
      Descargar la copia local
    </button>`;
  }

  return html`
    <div class="problem">
      <div class="problem-icon ${tone}" aria-hidden="true">${glyph}</div>
      ${codigo ? html`<div class="mono problem-code">${codigo}</div>` : raw('')}
      <h2>${title}</h2>
      <p>${body}</p>
      ${primary}${secondary}
    </div>
  `;
}

/** Esqueleto con la FORMA del resultado, para que la espera no desoriente. */
function resultSkeleton(): SafeHtml {
  return html`
    <div class="skeleton" aria-busy="true" aria-live="polite">
      <div class="sk-verdict">
        <div class="sk-dial shimmer"></div>
        <div class="sk-lines">
          <div class="sk-line w70"></div>
          <div class="sk-line w45 sm"></div>
          <div class="sk-pill"></div>
        </div>
      </div>
      <div class="sk-line w55 sm" style="margin-top:22px"></div>
      <div class="sk-bento">
        <div class="wide"></div><div></div><div></div><div class="wide short"></div>
      </div>
      <div class="mono sk-note">${state.pendingBarcode ?? ''} · consultando…</div>
    </div>
  `;
}

function resultView(): SafeHtml {
  const a = state.assessment;
  const marca = a?.product.brands?.join(', ') ?? '';
  const guardado = state.history.find((h) => h.barcode === state.pendingBarcode)?.starred ?? false;

  return html`
    <div class="screen">
      <header class="glass-header">
        <button class="icon-btn" data-action="back" aria-label="Volver">‹</button>
        <div class="crumb">${marca}</div>
        ${a
          ? html`<button
              class="icon-btn star ${guardado ? 'on' : ''}"
              data-action="toggle-star"
              aria-pressed="${guardado}"
              aria-label="Guardar en favoritos"
            >
              ${guardado ? '★' : '☆'}
            </button>`
          : raw('')}
      </header>
      <div class="scroll" id="result-scroll">
        ${state.loading
          ? resultSkeleton()
          : a
            ? assessmentView(a, { evidenceOpen: state.evidenceOpen, confidenceOpen: state.confidenceOpen })
            : resultProblem()}
      </div>
      ${a && !state.loading
        ? html`<div class="thumb-bar">
            <button class="primary" data-action="nav" data-view="scan">Escanear otro</button>
            <button
              class="secondary star ${guardado ? 'on' : ''}"
              data-action="toggle-star"
              aria-pressed="${guardado}"
              aria-label="Guardar en favoritos"
            >
              ${guardado ? '★' : '☆'}
            </button>
          </div>`
        : raw('')}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// V4 · Guardado
// ---------------------------------------------------------------------------

function historyView(): SafeHtml {
  const favoritos = state.histTab === 'star';
  const items = favoritos ? state.history.filter((h) => h.starred) : state.history;
  const vacio = items.length === 0;

  return html`
    <div class="screen">
      ${glassHeader('Guardado', {
        right: state.history.length
          ? html`<button class="pill-btn" data-action="ask-clear">Vaciar</button>`
          : raw(''),
      })}
      <div class="scroll">
        <div class="segmented" role="tablist">
          <button
            role="tab"
            data-action="hist-tab"
            data-tab="all"
            aria-selected="${!favoritos}"
            class="${!favoritos ? 'on' : ''}"
          >
            Recientes
          </button>
          <button
            role="tab"
            data-action="hist-tab"
            data-tab="star"
            aria-selected="${favoritos}"
            class="${favoritos ? 'on' : ''}"
          >
            ★ Favoritos
          </button>
        </div>

        ${vacio
          ? html`<div class="empty">
              <div class="empty-icon" aria-hidden="true">${favoritos ? '☆' : '▤'}</div>
              <div class="empty-title">
                ${favoritos ? 'Aún no tienes favoritos' : 'Todavía no has escaneado nada'}
              </div>
              <p>
                ${favoritos
                  ? 'Marca la estrella en un resultado para volver a él sin buscarlo.'
                  : 'Los productos que escanees aparecerán aquí, con su nota, y podrás volver a ellos sin conexión.'}
              </p>
              <button class="primary" data-action="nav" data-view="scan">Escanear el primero</button>
            </div>`
          : html`
              <div class="list">
                ${items.map(
                  (h) => html`
                    <div class="list-row">
                      <button class="list-main" data-action="open" data-barcode="${h.barcode}">
                        <span class="thumb">${h.imageThumbUrl ? html`<img src="${h.imageThumbUrl}" alt="" loading="lazy" />` : raw('')}</span>
                        <span class="list-text">
                          <span class="list-name">${h.name ?? h.barcode}</span>
                          <span class="list-sub">${[h.brand, relativeTime(h.scannedAt)].filter(Boolean).join(' · ')}</span>
                        </span>
                        ${h.score !== undefined
                          ? html`<span class="list-score band-${h.band ?? 'neutral'}">
                              <span class="n">${h.score}</span>
                              <span class="b">${bandLabel(h.band)}</span>
                            </span>`
                          : html`<span class="list-score band-neutral"
                              ><span class="n">—</span><span class="b">cosmética</span></span
                            >`}
                      </button>
                      <button
                        class="icon-btn star ${h.starred ? 'on' : ''}"
                        data-action="toggle-star-row"
                        data-id="${h.id}"
                        aria-pressed="${h.starred}"
                        aria-label="Favorito"
                      >
                        ${h.starred ? '★' : '☆'}
                      </button>
                    </div>
                  `,
                )}
              </div>
              <p class="fineprint">Todo se guarda solo en este dispositivo.</p>
            `}
      </div>
    </div>
  `;
}

/** `band` viaja como cadena en IndexedDB; se traduce solo si es una banda real. */
function bandLabel(band?: string): string {
  return band && band in BAND_LABELS ? BAND_LABELS[band as keyof typeof BAND_LABELS] : '';
}

/** «hoy», «ayer», «hace 3 días»: mas util que una fecha exacta en un historial. */
function relativeTime(ms: number): string {
  const dias = Math.floor((Date.now() - ms) / 86_400_000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 30) return `hace ${dias} días`;
  return new Date(ms).toLocaleDateString('es');
}

// ---------------------------------------------------------------------------
// V5 · Buscar
// ---------------------------------------------------------------------------

function searchView(): SafeHtml {
  const guardados = catalogs?.downloadedCountries.length ?? 0;
  const sinCopia = guardados === 0;
  const listos = state.catalogs.filter((c) => c.state === 'ready');
  const productos = listos.reduce((t, c) => t + c.products, 0);

  return html`
    <div class="screen">
      <header class="glass-header col">
        <h1>Buscar</h1>
        <div class="search-field ${sinCopia ? 'disabled' : ''}">
          <span aria-hidden="true">⌕</span>
          <input
            id="search-term"
            type="search"
            placeholder="Leche entera, galletas…"
            aria-label="Buscar por nombre"
            value="${state.searchTerm}"
            ${raw(sinCopia ? 'disabled' : '')}
          />
          ${state.searchTerm
            ? html`<button class="icon-btn sm" data-action="clear-term" aria-label="Borrar">×</button>`
            : raw('')}
        </div>
      </header>
      <div class="scroll">
        ${sinCopia
          ? html`<div class="empty">
              <div class="empty-icon" aria-hidden="true">⇩</div>
              <div class="empty-title">Buscar por nombre necesita un catálogo</div>
              <p>
                Descarga el de tu país y, además de poder buscar, el escáner funcionará
                <strong>sin conexión</strong>.
              </p>
              <button class="primary" data-action="nav" data-view="more" data-more="country">
                Elegir país y descargar
              </button>
              <div class="alt">
                Mientras tanto:
                <button class="link" data-action="nav" data-view="scan">escanear</button> o
                <button class="link" data-action="open-manual">escribir el código</button>.
              </div>
            </div>`
          : state.searching
            ? html`<div class="list" aria-busy="true">
                ${[70, 55, 62].map(
                  (w) => html`<div class="list-row sk">
                    <span class="thumb shimmer"></span>
                    <span class="sk-lines">
                      <span class="sk-line" style="width:${w}%"></span>
                      <span class="sk-line sm" style="width:${w - 25}%"></span>
                    </span>
                  </div>`,
                )}
              </div>`
            : state.searchResults.length
              ? html`
                  <div class="result-count" aria-live="polite">
                    ${state.searchResults.length}
                    ${state.searchResults.length === 1 ? 'resultado' : 'resultados'} en
                    ${listos.length === 1 ? listos[0]!.label : `${listos.length} catálogos`}
                  </div>
                  <div class="list">
                    ${state.searchResults.map(
                      (p) => html`
                        <button class="list-main row" data-action="open" data-barcode="${p.barcode}">
                          <span class="thumb">${p.imageThumbUrl ? html`<img src="${p.imageThumbUrl}" alt="" />` : raw('')}</span>
                          <span class="list-text">
                            <span class="list-name">${p.name ?? p.barcode}</span>
                            <span class="list-sub">${[p.brands?.join(', '), p.quantity].filter(Boolean).join(' · ')}</span>
                          </span>
                          <span class="chevron-right" aria-hidden="true">›</span>
                        </button>
                      `,
                    )}
                  </div>
                  <p class="fineprint">La nota se calcula al abrir cada producto.</p>
                `
              : state.searchTerm
                ? html`<div class="empty" aria-live="polite">
                    <div class="empty-title">Nada con «${state.searchTerm}»</div>
                    <p>
                      Hay ${productos.toLocaleString('es')} productos en lo que tienes descargado.
                      Prueba con menos palabras, escanea el código, o añádelo tú.
                    </p>
                    <div class="duo">
                      <button class="primary" data-action="nav" data-view="scan">Escanear</button>
                      <button class="secondary" data-action="nav" data-view="more" data-more="contribute">
                        Añadir producto
                      </button>
                    </div>
                  </div>`
                : html`
                    <div class="copy-line">
                      <span
                        >${listos.map((c) => c.label).join(' · ')} ·
                        ${productos.toLocaleString('es')} productos</span
                      >
                      <span class="ok">sin conexión ✓</span>
                    </div>
                    ${state.recentSearches.length
                      ? html`
                          <h3 class="sub-head">Recientes</h3>
                          <div class="chips">
                            ${state.recentSearches.map(
                              (t) => html`<button class="chip-btn" data-action="search-again" data-term="${t}">
                                ${t}
                              </button>`,
                            )}
                          </div>
                        `
                      : raw('')}
                  `}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// V6/V7 · Más
// ---------------------------------------------------------------------------

const MORE_TITLES: Record<MoreView, string> = {
  index: 'Más',
  country: 'Catálogos por país',
  method: 'Método y fuentes',
  privacy: 'Privacidad',
  contribute: 'Participar',
};

/** Resumen de una linea para el indice: dice el estado sin tener que entrar. */
function countryLine(): string {
  const listos = state.catalogs.filter((c) => c.state === 'ready');
  if (listos.length === 0) return 'Sin catálogos · solo consulta en vivo';
  const pendientes = listos.filter((c) => c.update).length;
  const nombres = listos.map((c) => c.label).join(', ');
  return pendientes
    ? `${nombres} · ${pendientes} con actualización`
    : `${nombres} · sin conexión ✓`;
}

function moreIndex(): SafeHtml {
  const filas: Array<[MoreView, string, string, SafeHtml | string]> = [
    ['country', 'Catálogos por país', countryLine(), ''],
    ['method', 'Método y fuentes', 'Cómo se calcula la nota, y en qué nos diferenciamos', ''],
    [
      'contribute',
      'Participar',
      'Añadir productos que faltan',
      FEATURES.contributions ? '' : html`<span class="tag warn">PRÓXIMAMENTE</span>`,
    ],
    ['privacy', 'Privacidad y aviso sanitario', 'Sin cuenta, sin servidor, sin datos que salgan', ''],
  ];
  return html`
    <div class="list">
      ${filas.map(
        ([id, t, s, tag]) => html`
          <button class="list-main row" data-action="more" data-more="${id}">
            <span class="list-text">
              <span class="list-name">${t} ${tag}</span>
              <span class="list-sub">${s}</span>
            </span>
            <span class="chevron-right" aria-hidden="true">›</span>
          </button>
        `,
      )}
    </div>
    ${state.updateReady
      ? html`<div class="notice-row">
          <div>
            <strong>Hay una versión nueva</strong>
            <span>Se aplicará al recargar. Nada se pierde.</span>
          </div>
          <button class="mini primary" data-action="apply-update">Actualizar</button>
        </div>`
      : raw('')}
    <p class="fineprint">
      ${APP_NAME} ${APP_VERSION} · código AGPL-3.0 · datos ODbL
    </p>
  `;
}

function methodView(): SafeHtml {
  const pesos: Array<[string, number, string]> = [
    ['Calidad nutricional · Nutri-Score 2023', 55, 'w-nutrition'],
    ['Procesamiento · NOVA', 20, 'w-processing'],
    ['Aditivos · sobreexposición EFSA', 20, 'w-additives'],
    ['Advertencias · modelo OPS/OMS', 5, 'w-regulatory'],
  ];
  const diferencias: Array<[string, string]> = [
    [
      'Riesgo, no peligro.',
      'Los aditivos se valoran por el riesgo de sobreexposición que evalúa EFSA, no por su peligro teórico al margen de la dosis.',
    ],
    [
      'Sin topes ocultos.',
      'Ninguna regla congela la nota en un valor arbitrario. Toda penalización es gradual y aparece desglosada.',
    ],
    [
      'Sin bonus por «orgánico».',
      'No tiene respaldo en resultados de salud: se muestra como información y no suma.',
    ],
    [
      'Decimos lo que no sabemos.',
      'Si faltan datos verás el nivel de confianza y el rango posible, no una precisión fingida.',
    ],
  ];
  return html`
    <h3 class="sub-head">Cómo se calcula la nota</h3>
    <div class="weights" aria-hidden="true">
      ${pesos.map(([, n, cls]) => html`<span class="${cls}" style="flex:${n}"></span>`)}
    </div>
    <div class="list tight">
      ${pesos.map(
        ([label, n, cls]) => html`
          <div class="kv">
            <span><span class="swatch ${cls}" aria-hidden="true"></span>${label}</span>
            <strong class="mono">${n} %</strong>
          </div>
        `,
      )}
    </div>

    <h3 class="sub-head">En qué nos diferenciamos</h3>
    <div class="cards">
      ${diferencias.map(([t, d]) => html`<div class="mini-card"><strong>${t}</strong> ${d}</div>`)}
    </div>

    <h3 class="sub-head">Fuentes</h3>
    <div class="list tight">
      <a class="kv" href="https://world.openfoodfacts.org" target="_blank" rel="noopener"
        >Open Food Facts · ODbL<span aria-hidden="true">↗</span></a
      >
      <div class="kv">Nutri-Score 2023 (FSAm-NPS)</div>
      <div class="kv">Clasificación NOVA</div>
      <div class="kv">EFSA · reevaluación de aditivos; ANSES · vigilancia</div>
      <a
        class="kv"
        href="https://iris.paho.org/handle/10665.2/18621"
        target="_blank"
        rel="noopener"
        >Modelo de Perfil de Nutrientes OPS (2016)<span aria-hidden="true">↗</span></a
      >
      <div class="kv">Reglamento (CE) 1223/2009 · CosIng</div>
    </div>
  `;
}

function privacyView(): SafeHtml {
  return html`
    <div class="list tight">
      <div class="kv block">No hay cuenta, ni registro, ni servidor propio.</div>
      <div class="kv block">El historial y los favoritos no salen de este dispositivo.</div>
      <div class="kv block">La aplicación no envía ningún dato personal a ninguna parte.</div>
      <div class="kv block">
        La fuente tipográfica se sirve desde esta misma aplicación, no desde un tercero.
      </div>
    </div>
    <div class="mini-card" style="margin-top:12px">
      <strong>Aviso sanitario.</strong> Esta aplicación es informativa y no sustituye el consejo de
      un profesional sanitario. No diagnostica ni prescribe.
    </div>
  `;
}

function moreView(): SafeHtml {
  const sub = state.moreView !== 'index';
  const cuerpo =
    state.moreView === 'index'
      ? moreIndex()
      : state.moreView === 'country'
        ? catalogsSection()
        : state.moreView === 'method'
          ? methodView()
          : state.moreView === 'privacy'
            ? privacyView()
            : contributeSection();
  return html`
    <div class="screen">
      ${glassHeader(MORE_TITLES[state.moreView], { back: sub })}
      <div class="scroll">${cuerpo}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Más · Catálogos por país
// ---------------------------------------------------------------------------

const mb = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/**
 * Una fila de la lista de catalogos.
 *
 * El diseno proponia radios de un solo pais, pero eso es anterior a que la
 * aplicacion soportara varios a la vez. Se mantiene la lista con descarga y
 * borrado independientes -- medido, el 19,3% del catalogo mexicano lleva
 * prefijo GS1 estadounidense -- y se le aplica el lenguaje visual nuevo.
 *
 * Cada boton lleva el pais en su nombre accesible: sin eso, un lector de
 * pantalla anuncia una lista de botones «Descargar» indistinguibles.
 */
function catalogRow(v: CatalogView): SafeHtml {
  const pct = v.progress ? Math.round((v.progress.loaded / (v.progress.total || 1)) * 100) : 0;
  const ocupado = v.state === 'downloading' || v.state === 'updating';
  return html`
    <div class="catalog-row" id="catalog-${v.country}">
      <div class="list-text">
        <span class="list-name" id="catalog-name-${v.country}">${v.label}</span>
        <span class="list-sub">
          ${v.products.toLocaleString('es')} productos · ${mb(v.bytes)}
          ${v.state === 'ready' && !v.update
            ? html` · <span class="ok">guardado y al día, funciona sin conexión</span>`
            : raw('')}
          ${v.update ? html` · <span class="pending">${v.update.cost}</span>` : raw('')}
        </span>
      </div>

      <div class="catalog-actions">
        ${ocupado
          ? html`<button
              class="secondary compact"
              data-action="catalog-download"
              data-country="${v.country}"
              aria-disabled="true"
              aria-label="${v.state === 'updating' ? 'Actualizando' : 'Descargando'} el catálogo de ${v.label}"
            >
              ${v.state === 'updating' ? 'Actualizando…' : 'Descargando…'}
            </button>`
          : v.state === 'ready'
            ? html`
                ${v.update
                  ? html`<button
                      class="primary compact"
                      data-action="catalog-update"
                      data-country="${v.country}"
                      aria-label="Actualizar el catálogo de ${v.label}. ${v.update.cost}"
                    >
                      Actualizar
                    </button>`
                  : raw('')}
                <button
                  class="secondary compact"
                  data-action="catalog-remove"
                  data-country="${v.country}"
                  aria-label="Eliminar el catálogo de ${v.label}"
                >
                  Eliminar
                </button>
              `
            : html`<button
                class="primary compact"
                data-action="catalog-download"
                data-country="${v.country}"
                aria-label="Descargar el catálogo de ${v.label}, ${mb(v.bytes)}"
              >
                ${v.state === 'error' ? 'Reintentar' : 'Descargar'}
              </button>`}
      </div>

      ${ocupado && v.progress
        ? html`
            <div class="catalog-progress">
              <div
                class="bar"
                role="progressbar"
                aria-labelledby="catalog-name-${v.country}"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow="${pct}"
              >
                <span style="width:${pct}%"></span>
              </div>
              <small>${mb(v.progress.loaded)} de ${mb(v.progress.total)}</small>
            </div>
          `
        : raw('')}

      ${v.problem
        ? html`<div class="catalog-problem">
            <strong>${v.problem.title}</strong>
            <span>${v.problem.body}</span>
          </div>`
        : raw('')}
    </div>
  `;
}

function catalogSummary(): string {
  const guardados = state.catalogs.filter((c) => c.state === 'ready');
  if (guardados.length === 0) return 'Todavía no has guardado ningún catálogo.';
  const bytes = mb(guardados.reduce((t, c) => t + c.bytes, 0));
  return guardados.length === 1
    ? `1 catálogo guardado en este dispositivo, ${bytes}.`
    : `${guardados.length} catálogos guardados en este dispositivo, ${bytes} en total.`;
}

function catalogsSection(): SafeHtml {
  if (state.catalogs.length === 0) {
    return html`<p class="fineprint">
      No disponibles en esta instalación. La aplicación funciona igualmente consultando Open Food
      Facts en vivo.
    </p>`;
  }
  const aviso = state.catalogs.find((c) => c.warning)?.warning;
  return html`
    <p class="lead">
      Guarda el catálogo de los países que te interesen y la aplicación funcionará
      <strong>sin cobertura</strong>. Puedes tener varios: los productos importados suelen llevar
      el código de barras de su país de origen.
    </p>
    <div class="list">${state.catalogs.map(catalogRow)}</div>
    ${aviso ? html`<p class="fineprint">${aviso}</p>` : raw('')}
    <p class="fineprint" id="catalog-summary">${catalogSummary()}</p>
    <p class="fineprint">
      Datos de Open Food Facts, licencia ODbL. Lo que no guardes se consulta igualmente por
      internet, sin gastar el límite de peticiones.
    </p>
  `;
}

// ---------------------------------------------------------------------------
// Más · Participar
// ---------------------------------------------------------------------------

function contributeSection(): SafeHtml {
  const barcode = state.pendingBarcode ?? '';
  const offUrl = barcode
    ? `https://world.openfoodfacts.org/cgi/product.pl?type=edit&code=${encodeURIComponent(barcode)}`
    : 'https://world.openfoodfacts.org';

  if (state.contributeForm && FEATURES.contributions) return contributeFormView();

  return html`
    <div class="soon">
      <span class="tag warn">PRÓXIMAMENTE</span>
      <h2>Publicar desde aquí</h2>
      <p>
        Estamos tramitando con Open Food Facts el permiso para publicar productos directamente
        desde la aplicación.
      </p>
    </div>

    <h3 class="sub-head">Cómo funcionará</h3>
    <div class="steps">
      <div class="step"><span class="n">1</span>Pulsas <em>Conectar con Open Food Facts</em>.</div>
      <div class="step">
        <span class="n">2</span>Te identificas <strong>en su web</strong>, no aquí: esta aplicación
        nunca verá tu contraseña.
      </div>
      <div class="step">
        <span class="n">3</span>Vuelves y publicas. El producto queda <strong>a tu nombre</strong> y
        disponible para todos.
      </div>
    </div>

    <div class="mini-card" style="margin-top:20px">
      <strong>Mientras tanto, sí puedes ayudar</strong>
      <p>
        Open Food Facts la rellena la gente, y en Latinoamérica está mucho más vacía que en Europa.
        Lo que añadas allí aparecerá aquí en la próxima actualización del catálogo.
      </p>
      <a class="primary as-button" href="${offUrl}" target="_blank" rel="noopener">
        ${barcode ? `Añadir ${barcode} en Open Food Facts ↗` : 'Abrir Open Food Facts ↗'}
      </a>
    </div>
    ${FEATURES.contributions
      ? html`<button class="link" data-action="show-form">Ver el formulario preparado</button>`
      : raw('')}
  `;
}

function contributeFormView(): SafeHtml {
  return html`
    <div class="form">
      <div class="card">
        <label for="c-barcode">Código de barras</label>
        <input id="c-barcode" type="text" inputmode="numeric" value="${state.pendingBarcode ?? ''}" />

        <label for="c-name">Nombre del producto</label>
        <input id="c-name" type="text" placeholder="Harina de maíz precocida" />

        <label for="c-brand">Marca</label>
        <input id="c-brand" type="text" placeholder="P.A.N." />

        <label for="c-quantity">Cantidad</label>
        <input id="c-quantity" type="text" placeholder="1 kg" />

        <label for="c-ingredients">Ingredientes (copia la etiqueta)</label>
        <textarea id="c-ingredients" rows="4" placeholder="Harina de maíz precocida, vitaminas…"></textarea>

        <h2 style="margin-top:20px">Información nutricional por 100 g</h2>
        <div class="row">
          <div>
            <label for="c-energy">Energía (kcal)</label>
            <input id="c-energy" type="number" inputmode="decimal" step="any" />
          </div>
          <div>
            <label for="c-fat">Grasas (g)</label>
            <input id="c-fat" type="number" inputmode="decimal" step="any" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="c-satfat">Saturadas (g)</label>
            <input id="c-satfat" type="number" inputmode="decimal" step="any" />
          </div>
          <div>
            <label for="c-carbs">Hidratos (g)</label>
            <input id="c-carbs" type="number" inputmode="decimal" step="any" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="c-sugars">Azúcares (g)</label>
            <input id="c-sugars" type="number" inputmode="decimal" step="any" />
          </div>
          <div>
            <label for="c-fiber">Fibra (g)</label>
            <input id="c-fiber" type="number" inputmode="decimal" step="any" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="c-proteins">Proteínas (g)</label>
            <input id="c-proteins" type="number" inputmode="decimal" step="any" />
          </div>
          <div>
            <label for="c-salt">Sal (g)</label>
            <input id="c-salt" type="number" inputmode="decimal" step="any" />
          </div>
        </div>

        <button class="primary" data-action="save-contribution" style="margin-top:20px">
          Publicar en Open Food Facts
        </button>
      </div>
    </main>
  `;
}




// ---------------------------------------------------------------------------
// Renderizado y acciones
// ---------------------------------------------------------------------------

function render(): void {
  const views: Record<View, () => SafeHtml> = {
    scan: scanView,
    result: resultView,
    history: historyView,
    search: searchView,
    more: moreView,
  };
  // Las hojas y el toast van FUERA de la vista: se superponen a cualquiera y
  // no deben desaparecer al cambiar de pestana por debajo.
  const conBarra = !state.manualOpen && !state.additiveOpen && !state.clearAsk;
  mount(
    root,
    html`${views[state.view]()} ${conBarra ? tabbar() : raw('')} ${manualSheet()}
    ${additiveSheetEl()} ${clearSheet()} ${toastEl()}`,
  );

  // Se devuelve el <video> persistente a su contenedor. Al ser siempre el mismo
  // nodo, el stream y el escaner siguen vivos entre renders.
  if (state.view === 'scan') {
    const stage = document.getElementById('stage');
    if (stage && !stage.contains(videoEl)) stage.prepend(videoEl);
    if (state.scannerActive) void attachCamera();
  }

  // Con la hoja abierta el foco va al campo, para poder escribir con el teclado
  // fisico sin tener que pulsar antes en ningun sitio.
  if (state.manualOpen) {
    const input = document.getElementById('manual-input') as HTMLInputElement | null;
    if (input && document.activeElement !== input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // El campo de busqueda se rehace en cada render y perderia el cursor.
  if (state.view === 'search' && state.searchFocus) {
    const input = document.getElementById('search-term') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

/** Muestra un aviso efimero. Con accion cuando lo ocurrido se puede deshacer. */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, action?: string, fn?: () => void): void {
  clearTimeout(toastTimer);
  state.toast = { text, action };
  state.toastAction = fn;
  render();
  toastTimer = setTimeout(() => {
    state.toast = undefined;
    state.toastAction = undefined;
    render();
  }, 6000);
}

async function navigate(view: View, more?: MoreView): Promise<void> {
  if (state.view === 'scan' && view !== 'scan') stopCamera();
  state.view = view;
  state.error = undefined;
  state.manualOpen = false;
  state.additiveOpen = undefined;
  state.clearAsk = false;
  if (more) state.moreView = more;
  if (view === 'more' && !more) state.moreView = 'index';
  if (view === 'history') state.history = await listHistory();
  render();
}

async function lookup(barcode: string): Promise<void> {
  const normalized = normalizeBarcode(barcode);
  if (!isValidEan(normalized)) {
    state.error = 'Ese código de barras no es válido. Revisa los dígitos.';
    render();
    return;
  }

  // El prefijo GS1 permite descartar de entrada lo que ninguna base global
  // puede resolver, en vez de hacer al usuario esperar a un "no encontrado".
  // Son casos frecuentes: el 16% del catalogo espanol son codigos internos de
  // tienda, que no son unicos en el mundo.
  const gs1 = classifyBarcode(normalized);
  if (gs1.kind !== 'product' && gs1.note) {
    stopCamera();
    state.pendingBarcode = normalized;
    state.view = 'result';
    state.loading = false;
    state.assessment = undefined;
    state.sparseProduct = false;
    state.error = gs1.note;
    state.unresolvableBarcode = true;
    render();
    return;
  }
  state.unresolvableBarcode = false;

  stopCamera();
  state.pendingBarcode = normalized;
  state.view = 'result';
  state.loading = true;
  state.assessment = undefined;
  state.error = undefined;
  render();

  try {
    const product = await repo.lookup(normalized);
    if (!hasUsableData(product)) {
      // El producto existe en la base pero esta practicamente vacio. Mostrar una
      // puntuacion aqui seria inventarsela: es mas honesto pedir los datos.
      state.sparseProduct = true;
      state.error =
        'Este producto está en la base de datos pero sin información: no tiene nombre, ingredientes ni tabla nutricional. No se puede puntuar algo de lo que no se sabe nada. Si añades los datos del envase, quedará resuelto para todo el mundo.';
      state.loading = false;
      render();
      return;
    }
    state.sparseProduct = false;
    // Se evalua el producto que ya tenemos, sin volver a pedirlo por codigo.
    state.assessment = await repo.assessProduct(product);
  } catch (err) {
    if (err instanceof ProductNotFoundError) {
      state.error =
        'Este producto no está en las bases de datos abiertas. Puedes añadirlo tú y ayudar a quien venga detrás.';
    } else if (err instanceof OffRateLimitError) {
      const seconds = Math.ceil(err.retryAfterMs / 1000);
      state.error = `Open Food Facts limita las consultas a 15 por minuto. Inténtalo de nuevo en ${seconds} segundos.`;
    } else if (!navigator.onLine) {
      // Sin red, la unica via era un catalogo guardado. Soltar el "Failed to
      // fetch" del navegador no le dice al usuario ni que ha pasado ni que
      // puede hacer.
      const guardados = catalogs?.downloadedCountries.length ?? 0;
      state.error =
        guardados > 0
          ? 'No hay conexión y este producto no está en los catálogos que tienes guardados. ' +
            'Vuelve a intentarlo cuando tengas red, o guarda el catálogo de su país.'
          : 'No hay conexión y no tienes ningún catálogo guardado. Descarga el de tu país en ' +
            'Información → Catálogos sin conexión y podrás consultar sin red.';
    } else {
      state.error = err instanceof Error ? err.message : 'Error desconocido';
    }
  } finally {
    state.loading = false;
    render();
  }
}

/**
 * Marca o desmarca un favorito.
 *
 * Sin `id` actua sobre el producto que se esta viendo, que puede no estar aun
 * en el historial si el guardado todavia no ha terminado.
 */
async function toggleStarred(id?: number): Promise<void> {
  let objetivo = id;
  if (objetivo === undefined) {
    const entrada = state.history.find((h) => h.barcode === state.pendingBarcode);
    objetivo = entrada?.id;
  }
  if (objetivo === undefined) return;
  await toggleStar(objetivo);
  state.history = await listHistory();
  const ahora = state.history.find((h) => h.id === objetivo)?.starred;
  render();
  toast(ahora ? 'Guardado en favoritos.' : 'Quitado de favoritos.');
}

/** Vacia los recientes dejando los favoritos, con deshacer. */
async function vaciarRecientes(): Promise<void> {
  const borrados = await clearRecent();
  state.clearAsk = false;
  state.history = await listHistory();
  render();
  toast(
    borrados.length ? 'Recientes vaciados.' : 'No había nada que vaciar.',
    borrados.length ? 'Deshacer' : undefined,
    borrados.length
      ? () => {
          void restoreHistory(borrados).then(async () => {
            state.history = await listHistory();
            render();
          });
        }
      : undefined,
  );
}

/** Pega el codigo del portapapeles, cuando el navegador lo permite. */
async function pegarCodigo(): Promise<void> {
  try {
    const texto = await navigator.clipboard.readText();
    const digitos = texto.replace(/\D/g, '').slice(0, 13);
    if (digitos) {
      state.manualCode = digitos;
      syncManual();
      document.getElementById('manual-input')?.focus();
    } else {
      toast('No hay ningún número en el portapapeles.');
    }
  } catch {
    // Safari y Firefox solo lo permiten tras un gesto y con permiso explicito.
    toast('Tu navegador no permite pegar desde aquí.');
  }
}

/** Busca por nombre en los catalogos descargados. */
async function runSearch(): Promise<void> {
  const term = state.searchTerm.trim();
  if (!term) {
    state.searchResults = [];
    render();
    return;
  }
  state.searching = true;
  state.searchFocus = false;
  render();
  try {
    state.searchResults = await repo.search(term);
    // Solo se recuerda lo que dio resultados: una lista de busquedas fallidas
    // no le sirve a nadie para repetirlas.
    if (state.searchResults.length) {
      state.recentSearches = [term, ...state.recentSearches.filter((t) => t !== term)].slice(0, 6);
    }
  } catch (err) {
    state.searchResults = [];
    state.error = err instanceof Error ? err.message : String(err);
  }
  state.searching = false;
  render();
}

/** Muestra el dialogo nativo de instalacion, si el navegador lo ofrecio. */
async function promptInstall(): Promise<void> {
  const evento = installEvent;
  if (!evento) return;
  installEvent = undefined;
  state.installReady = false;
  render();
  await evento.prompt();
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
let installEvent: InstallPromptEvent | undefined;

async function attachCamera(): Promise<void> {
  if (scanner) return;
  scanner = new CameraScanner({
    video: videoEl,
    onResult: (result) => void lookup(result.barcode),
    onDiagnostics: (d) => {
      state.diagnostics = d;
      // Solo se refresca el panel: un render completo aqui seria un derroche a
      // 5 fotogramas por segundo.
      const panel = root.querySelector('.diag');
      if (panel) {
        const fresh = document.createElement('div');
        fresh.innerHTML = diagnosticsPanel().value;
        const next = fresh.firstElementChild;
        if (next) panel.replaceWith(next);
      }
    },
    onError: (err) => {
      // Un fallo de decodificacion es normal y transitorio: se registra en el
      // diagnostico, no se interrumpe al usuario con un cartel de error.
      console.warn('[escaner]', err);
    },
  });
  try {
    await scanner.start();
    state.cameraProblem = undefined;
    state.torchAvailable = scanner.hasTorch();
    render();
  } catch (err) {
    scanner = undefined;
    state.scannerActive = false;
    // Se distingue «lo denegaste» de «no se pudo abrir»: el primero se arregla
    // en los ajustes del navegador y el segundo reintentando, y ofrecer el
    // camino equivocado deja al usuario dando vueltas.
    const denegado = err instanceof Error && err.name === 'NotAllowedError';
    state.cameraProblem = {
      kind: denegado ? 'denied' : 'error',
      detail: err instanceof Error ? err.name : undefined,
    };
    render();
  }
}

function stopCamera(): void {
  scanner?.stop();
  scanner = undefined;
  state.scannerActive = false;
  state.diagOpen = false;
  state.torchAvailable = false;
}

function num(id: string): number | undefined {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el?.value) return undefined;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : undefined;
}

function str(id: string): string | undefined {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  return el?.value.trim() || undefined;
}

root.addEventListener('click', (event) => {
  const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
  if (!el) return;
  // `aria-disabled` mantiene el boton en el orden de tabulacion, a diferencia
  // de `disabled`, pero no impide la pulsacion: hay que ignorarla aqui.
  if (el.getAttribute('aria-disabled') === 'true') return;
  const action = el.dataset.action;

  switch (action) {
    case 'nav':
      void navigate(el.dataset.view as View, el.dataset['more'] as MoreView | undefined);
      break;
    case 'more':
      state.moreView = el.dataset['more'] as MoreView;
      state.contributeForm = false;
      render();
      break;
    case 'back':
      // «Volver» significa cosas distintas segun donde se este: dentro de Mas
      // sube un nivel, en el resultado vuelve al escaner.
      if (state.view === 'more' && state.moreView !== 'index') {
        state.moreView = 'index';
        state.contributeForm = false;
        render();
      } else {
        void navigate('scan');
      }
      break;
    case 'show-form':
      state.contributeForm = true;
      render();
      break;

    // --- Resultado ---
    case 'toggle-confidence':
      state.confidenceOpen = !state.confidenceOpen;
      render();
      break;
    case 'toggle-evidence':
    case 'open-evidence': {
      const id = el.dataset['ev'];
      if (!id) break;
      if (action === 'open-evidence') state.evidenceOpen.add(id);
      else if (state.evidenceOpen.has(id)) state.evidenceOpen.delete(id);
      else state.evidenceOpen.add(id);
      render();
      // Al abrir desde un bloque del bento hay que llevar al usuario hasta la
      // seccion: si no, el contenido se despliega fuera de la pantalla y el
      // toque parece no haber hecho nada.
      if (action === 'open-evidence') {
        requestAnimationFrame(() =>
          document.getElementById(`ev-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
      }
      break;
    }
    case 'open-additive': {
      const tag = el.dataset['tag'];
      const a = state.assessment;
      if (a?.kind === 'food') state.additiveOpen = a.score.additives.find((x) => x.tag === tag);
      render();
      break;
    }
    case 'close-additive':
      state.additiveOpen = undefined;
      render();
      break;
    case 'toggle-star':
    case 'toggle-star-row':
      void toggleStarred(el.dataset['id'] ? Number(el.dataset['id']) : undefined);
      break;
    case 'retry':
      if (state.pendingBarcode) void lookup(state.pendingBarcode);
      break;

    // --- Guardado ---
    case 'hist-tab':
      state.histTab = el.dataset['tab'] === 'star' ? 'star' : 'all';
      render();
      break;
    case 'ask-clear':
      state.clearAsk = true;
      render();
      break;
    case 'cancel-clear':
      state.clearAsk = false;
      render();
      break;
    case 'do-clear':
      void vaciarRecientes();
      break;
    case 'toast-action':
      state.toastAction?.();
      state.toast = undefined;
      state.toastAction = undefined;
      render();
      break;

    // --- Codigo a mano ---
    case 'open-manual':
      state.manualOpen = true;
      state.manualCode = '';
      render();
      break;
    case 'close-manual':
      state.manualOpen = false;
      render();
      break;
    case 'key': {
      const k = el.dataset['key'];
      if (k === '⌫') state.manualCode = state.manualCode.slice(0, -1);
      else if (k) state.manualCode = (state.manualCode + k).slice(0, 13);
      syncManual();
      // El foco vuelve al campo para que se pueda seguir con el teclado fisico
      // despues de haber tocado una tecla de la pantalla.
      document.getElementById('manual-input')?.focus();
      break;
    }
    case 'paste':
      void pegarCodigo();
      break;

    // --- Busqueda ---
    case 'clear-term':
      state.searchTerm = '';
      state.searchResults = [];
      state.searchFocus = true;
      render();
      break;
    case 'search-again': {
      const t = el.dataset['term'];
      if (t) {
        state.searchTerm = t;
        void runSearch();
      }
      break;
    }

    // --- Camara / entorno ---
    case 'toggle-diag':
      state.diagOpen = !state.diagOpen;
      render();
      break;
    case 'dismiss-install':
      state.installReady = false;
      render();
      break;
    case 'install':
      void promptInstall();
      break;
    case 'apply-update':
      // `true` hace `skipWaiting()` y recarga: sin eso la version nueva sigue
      // esperando y el boton no haria nada visible.
      void updateSW(true);
      break;
    case 'start-camera':
      state.scannerActive = true;
      state.error = undefined;
      render();
      break;
    case 'stop-camera':
      stopCamera();
      render();
      break;
    case 'toggle-torch':
      void scanner?.setTorch(!state.torchOn).then((ok) => {
        if (ok) state.torchOn = !state.torchOn;
        render();
      });
      break;
    case 'manual-lookup': {
      const codigo = state.manualCode;
      if (!isValidEan(codigo)) break;
      state.manualOpen = false;
      void lookup(codigo);
      break;
    }
    case 'open':
      if (el.dataset.barcode) void lookup(el.dataset.barcode);
      break;
    case 'catalog-download': {
      const country = el.dataset['country'];
      if (country) void catalogs?.download(country);
      break;
    }
    case 'catalog-update': {
      const country = el.dataset['country'];
      if (country) void catalogs?.update(country);
      break;
    }
    case 'catalog-remove': {
      const country = el.dataset['country'];
      if (country) void catalogs?.remove(country);
      break;
    }
    case 'clear-history':
      void clearHistory().then(() => navigate('history'));
      break;

    case 'save-contribution': {
      if (!FEATURES.contributions) return;
      const barcode = str('c-barcode');
      if (!barcode) {
        state.error = 'Hace falta el código de barras.';
        render();
        return;
      }
      void queueContribution(barcode, {
        name: str('c-name'),
        brands: str('c-brand'),
        quantity: str('c-quantity'),
        ingredientsText: str('c-ingredients'),
        nutrimentsPer100g: {
          'energy-kcal': num('c-energy'),
          fat: num('c-fat'),
          'saturated-fat': num('c-satfat'),
          carbohydrates: num('c-carbs'),
          sugars: num('c-sugars'),
          fiber: num('c-fiber'),
          proteins: num('c-proteins'),
          salt: num('c-salt'),
        },
      }).then(() => {
        state.error = undefined;
        void navigate('more', 'index');
      });
      break;
    }
    case 'export-contributions':
      void exportContributions().then((json) => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `veskan-aportaciones-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
      break;
  }
});

// Escaneo desde foto: el camino mas fiable cuando la camara no enfoca.
root.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id !== 'photo-input' || !input.files?.length) return;
  const file = input.files[0]!;
  state.loading = true;
  state.error = undefined;
  render();
  void scanFromFile(file)
    .then((result) => {
      state.loading = false;
      if (result) {
        void lookup(result.barcode);
      } else {
        state.error =
          'No se ha encontrado ningún código de barras en esa imagen. Procura que salga recto, enfocado y ocupando buena parte del encuadre.';
        render();
      }
    })
    .catch((err) => {
      state.loading = false;
      state.error = `No se ha podido leer la imagen: ${err instanceof Error ? err.message : err}`;
      render();
    });
});

/**
 * Entrada en el campo del codigo.
 *
 * Se filtra a digitos aqui y no con `pattern`: el usuario puede pegar un codigo
 * con guiones o espacios copiado de una web, y rechazarlo entero seria
 * quisquilloso cuando lo que quiere esta ahi dentro.
 */
root.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id !== 'manual-input') return;
  const limpio = input.value.replace(/\D/g, '').slice(0, 13);
  if (input.value !== limpio) input.value = limpio;
  state.manualCode = limpio;
  syncManual();
});

/**
 * Pegado nativo (Ctrl+V, clic derecho, pulsacion larga).
 *
 * Es mas fiable que `navigator.clipboard.readText()`, que Safari y Firefox solo
 * conceden con permiso explicito. El boton «Pegar» sigue existiendo para el
 * movil, donde no hay Ctrl+V.
 */
root.addEventListener('paste', (event) => {
  const input = event.target as HTMLElement;
  if (input.id !== 'manual-input') return;
  const texto = (event as ClipboardEvent).clipboardData?.getData('text') ?? '';
  const digitos = texto.replace(/\D/g, '').slice(0, 13);
  if (!digitos) return;
  event.preventDefault();
  state.manualCode = digitos;
  syncManual();
});

/**
 * Busqueda al escribir, con rebote.
 *
 * 300 ms: por debajo se lanza una consulta por pulsacion y la lista parpadea;
 * por encima se nota el retraso. Cada consulta toca el indice FTS del catalogo
 * en disco, asi que no es gratis.
 */
let searchTimer: ReturnType<typeof setTimeout> | undefined;
root.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id !== 'search-term') return;
  state.searchTerm = input.value;
  state.searchFocus = true;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void runSearch(), 300);
});

document.addEventListener('keydown', (event) => {
  // Escape cierra la hoja de encima, no la aplicacion entera.
  if ((event as KeyboardEvent).key !== 'Escape') return;
  if (state.additiveOpen) state.additiveOpen = undefined;
  else if (state.manualOpen) state.manualOpen = false;
  else if (state.clearAsk) state.clearAsk = false;
  else return;
  render();
});

root.addEventListener('keydown', (event) => {
  const e = event as KeyboardEvent;
  if (e.key !== 'Enter') return;
  const target = e.target as HTMLElement;
  if (target.id === 'manual-input') {
    if (isValidEan(state.manualCode)) {
      state.manualOpen = false;
      void lookup(state.manualCode);
    }
    return;
  }
  if (target.id === 'search-term') {
    clearTimeout(searchTimer);
    (target as HTMLInputElement).blur();
    void runSearch();
  }
});

/**
 * Registro del service worker, con aviso de version nueva.
 *
 * `registerType: 'prompt'` NO activa sola la version nueva: se queda esperando
 * mientras haya una pestana abierta. Sin este cableado el usuario se quedaba
 * con la version que cargo la primera vez **para siempre**, y cada despliegue
 * era invisible. El aviso de «Mas» existia en la interfaz pero nadie lo
 * encendia.
 *
 * Se prefiere avisar a activar sin preguntar: recargar en medio de un escaneo
 * o de una descarga de catalogo seria peor que esperar un momento.
 */
const updateSW = registerSW({
  onNeedRefresh() {
    state.updateReady = true;
    render();
  },
});

/**
 * Estado de la conexion.
 *
 * Se refleja en la cabecera del escaner porque cambia lo que la aplicacion
 * puede hacer: con catalogos guardados sigue resolviendo codigos sin red, y
 * decirlo evita que el usuario la de por rota.
 */
for (const evento of ['online', 'offline'] as const) {
  window.addEventListener(evento, () => {
    state.online = navigator.onLine;
    render();
  });
}

/**
 * Invitacion a instalar.
 *
 * Se guarda el evento y se ofrece como una tarjeta descartable sobre las
 * acciones del escaner, nunca como un modal: interrumpir antes del primer
 * veredicto es pedirle al usuario que se comprometa con algo que aun no ha
 * probado.
 */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e as InstallPromptEvent;
  state.installReady = true;
  render();
});

window.addEventListener('appinstalled', () => {
  state.installReady = false;
  installEvent = undefined;
  render();
});

// Liberar la camara al ocultar la pestana: gasta bateria y es un riesgo de
// privacidad dejarla encendida de fondo.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && scanner) {
    stopCamera();
    render();
  }
});

async function boot(): Promise<void> {
  state.history = await listHistory();

  const params = new URLSearchParams(location.search);
  const requested = params.get('view') as View | null;
  if (requested && ['scan', 'history', 'search', 'about'].includes(requested)) {
    state.view = requested;
  }
  const code = params.get('code');

  render();

  // Se precarga la taxonomia de aditivos para que el primer escaneo no espere.
  void loadScoringContext().catch((err) => console.warn('[taxonomias]', err));

  // El indice de snapshots se carga en segundo plano: la app ya es usable
  // contra la API en vivo mientras tanto.
  void loadSnapshotIndex(SNAPSHOT_BASE_URL).then(async (index) => {
    if (!index) return;
    state.snapshotAvailable = true;

    catalogs = new CatalogManager({ baseUrl: SNAPSHOT_BASE_URL, onChange: updateCatalogRow });
    await catalogs.init(index);
    repo.setCatalogs(catalogs);
    state.catalogs = catalogs.list();

    // Nada se descarga sin que el usuario lo pida: bajar megas que no ha
    // pedido, y que quiza no le sirvan, seria abusivo. El prefijo GS1 y el
    // idioma solo sirven para poner su pais el primero de la lista.
    if (catalogs.downloadedCountries.length === 0) {
      const sugerido = guessCountry(Object.keys(index.countries));
      if (sugerido) catalogs.suggest(sugerido);
      state.catalogs = catalogs.list();
    }
    render();

    // Despues de pintar: saber si hay actualizacion exige preguntar al Worker
    // por la version de cada base, y eso no debe retrasar la primera pantalla.
    void catalogs.checkUpdates();
  });

  if (code) void lookup(code);
}

void boot();
