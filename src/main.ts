/**
 * Punto de entrada. Compone la aplicacion y gestiona la navegacion.
 *
 * Todo el analisis ocurre en el navegador: no hay backend propio. Las unicas
 * peticiones externas son a Open Food Facts (que permite CORS) y al snapshot
 * estatico servido por CDN.
 */

import './styles.css';
import { html, mount, raw, type SafeHtml } from './ui/render.js';
import { assessmentView } from './ui/components.js';
import { OffClient, OffRateLimitError } from './core/data/off.js';
import { hasUsableData, ProductNotFoundError, ProductRepository } from './core/data/repository.js';
import { SqliteHttpSource } from './core/data/sqlite-http/client.js';
import {
  availableCountries,
  COUNTRY_LABELS,
  guessCountry,
  loadSnapshotIndex,
  strategyFor,
  type SnapshotIndex,
} from './core/data/sqlite-http/snapshot-index.js';
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
  exportContributions,
  listHistory,
  queueContribution,
  type HistoryEntry,
} from './core/data/idb.js';
import { BAND_COLORS } from './core/scoring/engine.js';
import { FEATURES } from './core/features.js';
import type { Assessment } from './core/types.js';

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

const COUNTRY_STORAGE_KEY = 'veskan.country';

type View = 'scan' | 'result' | 'history' | 'search' | 'contribute' | 'about';

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
  snapshotIndex?: SnapshotIndex;
  country?: string;
  snapshotStatus: 'none' | 'loading' | 'ready' | 'error';
  /** El codigo no puede resolverse en ninguna base global (interno, libro, cupon) */
  unresolvableBarcode?: boolean;
  snapshotDetail?: string;
  downloadProgress?: { loaded: number; total: number };
}

const state: AppState = {
  view: 'scan',
  loading: false,
  history: [],
  searchResults: [],
  scannerActive: false,
  snapshotAvailable: false,
  torchOn: false,
  sparseProduct: false,
  snapshotStatus: 'none',
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
 * Prepara el snapshot del pais indicado.
 *
 * La estrategia la decide el TAMANO publicado en el indice, no una lista
 * cableada: los paises pequenos se descargan enteros (y despues funcionan sin
 * conexion), los grandes se consultan por rangos.
 */
async function useCountry(country: string): Promise<void> {
  const index = state.snapshotIndex;
  const entry = index?.countries[country];
  if (!index || !entry) {
    state.snapshotStatus = 'none';
    render();
    return;
  }

  state.country = country;
  try {
    localStorage.setItem(COUNTRY_STORAGE_KEY, country);
  } catch {
    /* almacenamiento bloqueado: se pierde la preferencia, nada mas */
  }

  const strategy = strategyFor(entry);
  state.snapshotStatus = 'loading';
  state.downloadProgress = undefined;
  render();

  await repo.snapshot?.close().catch(() => {});

  const source = new SqliteHttpSource({
    url: `${SNAPSHOT_BASE_URL}/${entry.file}`,
    strategy,
    cacheKey: country,
    generatedAt: index.generated_at,
    onProgress: (p) => {
      state.downloadProgress = p;
      updateSnapshotStatusInPlace();
    },
  });
  repo.setSnapshot(source);

  try {
    await source.init();
    state.snapshotStatus = 'ready';
    state.snapshotDetail =
      strategy === 'download'
        ? `${entry.products.toLocaleString('es')} productos disponibles sin conexión`
        : `${entry.products.toLocaleString('es')} productos, consultados bajo demanda`;
  } catch (err) {
    state.snapshotStatus = 'error';
    state.snapshotDetail = err instanceof Error ? err.message : String(err);
    repo.setSnapshot(undefined);
  }
  state.downloadProgress = undefined;
  render();
}

/** Refresca solo la barra de progreso: un render completo por cada trozo seria un derroche. */
function updateSnapshotStatusInPlace(): void {
  const bar = document.getElementById('snapshot-progress') as HTMLElement | null;
  if (!bar || !state.downloadProgress) return;
  const { loaded, total } = state.downloadProgress;
  const pct = total ? Math.round((loaded / total) * 100) : 0;
  bar.style.width = `${pct}%`;
  const label = document.getElementById('snapshot-progress-label');
  if (label) label.textContent = `${pct}% · ${(loaded / 1024 / 1024).toFixed(1)} MB`;
}

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

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

function header(title: string, showBack = false): SafeHtml {
  return html`
    <header class="app-header">
      ${showBack
        ? html`<button
            class="icon-btn"
            data-action="back"
            aria-label="Volver"
            style="background:none;border:0;color:inherit;font-size:1.3rem;cursor:pointer;padding:4px 8px;min-height:44px"
          >
            ‹
          </button>`
        : raw('')}
      <h1>${title}</h1>
      <div class="spacer"></div>
    </header>
  `;
}

function tabbar(): SafeHtml {
  // La pestana de participacion se muestra aunque la funcion este inactiva:
  // esconderla dejaria al usuario sin saber que existe ni por que no funciona.
  const tabs: Array<[View, string, string]> = [
    ['scan', 'Escanear', 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18'],
    ['search', 'Buscar', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35'],
    ['history', 'Historial', 'M12 8v4l3 3M3.05 11a9 9 0 1 1 .5 4M3 4v5h5'],
    ['contribute', 'Participar', 'M12 5v14M5 12h14'],
    ['about', 'Método', 'M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z'],
  ];
  return html`
    <nav class="tabbar" aria-label="Navegación principal">
      ${tabs.map(
        ([id, label, path]) => html`
          <button
            data-action="nav"
            data-view="${id}"
            ${raw(state.view === id ? 'aria-current="page"' : '')}
          >
            ${id === 'contribute' && !FEATURES.contributions
              ? raw('<span aria-hidden="true" style="position:absolute;transform:translate(14px,-4px);width:7px;height:7px;border-radius:50%;background:var(--warning)"></span>')
              : raw('')}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="${path}" />
            </svg>
            ${label}
          </button>
        `,
      )}
    </nav>
  `;
}

function diagnosticsPanel(): SafeHtml {
  const d = state.diagnostics;
  if (!d) return raw('');
  return html`
    <details class="card" style="margin-top:12px">
      <summary>Diagnóstico del escáner</summary>
      <table class="nutrient-table" style="margin-top:8px">
        <tbody>
          <tr><td>Motor</td><td>${d.engine === 'native' ? 'nativo del navegador' : 'zxing-wasm'}</td></tr>
          <tr><td>Resolución</td><td>${d.resolution ?? '—'}</td></tr>
          <tr><td>Fotogramas analizados</td><td>${d.framesAnalyzed}</td></tr>
          <tr><td>Códigos detectados</td><td>${d.detections}</td></tr>
          <tr><td>Descartados por dígito de control</td><td>${d.rejectedByChecksum}</td></tr>
          ${d.lastRejected ? html`<tr><td>Último descartado</td><td>${d.lastRejected}</td></tr>` : raw('')}
          ${d.lastError ? html`<tr><td>Último error</td><td>${d.lastError}</td></tr>` : raw('')}
        </tbody>
      </table>
      ${d.engine === 'zxing'
        ? html`<p class="source-note">
            Tu navegador no trae detector de códigos nativo (es el caso de Chrome en Linux y
            Windows, Firefox y Safari), así que se usa zxing-wasm. Si la cámara no enfoca de cerca,
            usa "Escanear desde una foto": el disparo del sistema enfoca y captura a resolución
            completa.
          </p>`
        : raw('')}
    </details>
  `;
}

function scanView(): SafeHtml {
  return html`
    ${header('Escanear producto')}
    <main>
      ${state.error ? html`<div class="notice error">${state.error}</div>` : raw('')}
      <div class="scanner-stage" id="stage">
        <div class="reticle" aria-hidden="true"></div>
      </div>
      <div style="margin-top:14px">
        ${state.scannerActive
          ? html`
              <div class="row">
                <button class="secondary" data-action="stop-camera">Detener cámara</button>
                ${scanner?.hasTorch()
                  ? html`<button class="secondary" data-action="toggle-torch">
                      ${state.torchOn ? 'Apagar luz' : 'Encender luz'}
                    </button>`
                  : raw('')}
              </div>
            `
          : html`<button class="primary" data-action="start-camera">Activar cámara</button>`}
      </div>

      <div class="card" style="margin-top:14px">
        <h2>Escanear desde una foto</h2>
        <p style="margin:0 0 10px;font-size:.86rem;color:var(--text-dim)">
          Suele funcionar mejor que el vídeo en vivo: la cámara del sistema enfoca de verdad y
          captura a resolución completa.
        </p>
        <label for="photo-input">Selecciona o toma una foto del código de barras</label>
        <input id="photo-input" type="file" accept="image/*" capture="environment" />
      </div>

      <div class="card">
        <h2>O introduce el código a mano</h2>
        <div class="row">
          <input
            id="manual-barcode"
            type="text"
            inputmode="numeric"
            placeholder="8410000000000"
            autocomplete="off"
          />
          <button class="primary" data-action="manual-lookup" style="flex:0 0 auto;width:auto">
            Buscar
          </button>
        </div>
      </div>
      ${diagnosticsPanel()}
      ${state.loading ? html`<div class="spinner" style="margin-top:20px"></div>` : raw('')}
    </main>
  `;
}

function resultView(): SafeHtml {
  if (state.loading) {
    return html`
      ${header('Analizando…', true)}
      <main><div class="spinner" style="margin-top:40px"></div></main>
    `;
  }
  if (!state.assessment) {
    return html`
      ${header('Resultado', true)}
      <main>
        <div class="notice ${state.sparseProduct ? 'warn' : 'error'}">
          ${state.error ?? 'No hay ningún resultado que mostrar.'}
        </div>
        ${state.pendingBarcode && !state.unresolvableBarcode
          ? html`
              <a
                href="https://world.openfoodfacts.org/cgi/product.pl?type=edit&code=${state.pendingBarcode}"
                target="_blank"
                rel="noopener noreferrer"
                class="primary"
                style="display:block;text-align:center;text-decoration:none;box-sizing:border-box"
              >
                ${state.sparseProduct
                  ? 'Completar los datos en Open Food Facts'
                  : 'Añadir este producto en Open Food Facts'}
              </a>
              <button class="secondary" data-action="nav" data-view="contribute" style="margin-top:10px">
                ¿Por qué no puedo hacerlo aquí?
              </button>
            `
          : raw('')}
      </main>
    `;
  }
  return html`
    ${header(state.assessment.product.name ?? 'Resultado', true)}
    <main>${assessmentView(state.assessment)}</main>
  `;
}

function historyView(): SafeHtml {
  return html`
    ${header('Historial')}
    <main>
      ${state.history.length === 0
        ? html`<div class="empty">
            <div class="icon">📋</div>
            <p>Todavía no has escaneado nada.</p>
          </div>`
        : html`
            <div class="card">
              ${state.history.map(
                (h) => html`
                  <div class="list-item" data-action="open" data-barcode="${h.barcode}">
                    ${h.imageThumbUrl
                      ? html`<img src="${h.imageThumbUrl}" alt="" loading="lazy" />`
                      : html`<div class="placeholder">📦</div>`}
                    <div class="info">
                      <strong>${h.name ?? h.barcode}</strong>
                      <small>${h.brand ?? ''}</small>
                    </div>
                    ${h.score !== undefined
                      ? html`<div
                          class="mini-score"
                          style="background:${raw(
                            BAND_COLORS[(h.band ?? 'mediocre') as keyof typeof BAND_COLORS] ??
                              '#888',
                          )}"
                        >
                          ${h.score}
                        </div>`
                      : raw('')}
                  </div>
                `,
              )}
            </div>
            <button class="secondary" data-action="clear-history">Vaciar historial</button>
          `}
    </main>
  `;
}

function searchView(): SafeHtml {
  return html`
    ${header('Buscar por nombre')}
    <main>
      ${state.snapshotStatus !== 'ready'
        ? html`<div class="notice warn">
            La búsqueda por nombre necesita la copia local de tu país.
            ${state.snapshotAvailable
              ? html`Elígela en <strong>Método</strong> → Copia local por país.`
              : 'No está disponible en esta instalación.'}
            Mientras tanto puedes escanear el código de barras o introducirlo a mano.
          </div>`
        : raw('')}
      <div class="row">
        <input id="search-term" type="search" placeholder="Leche entera, galletas…" />
        <button class="primary" data-action="search" style="flex:0 0 auto;width:auto">Buscar</button>
      </div>
      ${state.loading ? html`<div class="spinner" style="margin-top:20px"></div>` : raw('')}
      ${state.searchResults.length > 0
        ? html`<div class="card" style="margin-top:14px">
            ${state.searchResults.map(
              (p) => html`
                <div class="list-item" data-action="open" data-barcode="${p.barcode}">
                  ${p.imageThumbUrl
                    ? html`<img src="${p.imageThumbUrl}" alt="" loading="lazy" />`
                    : html`<div class="placeholder">📦</div>`}
                  <div class="info">
                    <strong>${p.name ?? p.barcode}</strong>
                    <small>${p.brands?.join(', ') ?? ''}</small>
                  </div>
                </div>
              `,
            )}
          </div>`
        : raw('')}
    </main>
  `;
}

/**
 * Seccion de participacion.
 *
 * En la v1 esta presente pero inactiva. Se muestra igualmente, y con el motivo
 * explicado, en lugar de esconderla: quien escanea un producto que no existe
 * merece saber por que no puede arreglarlo desde aqui y que si puede hacerlo en
 * otro sitio.
 */
function contributeView(): SafeHtml {
  const barcode = state.pendingBarcode ?? '';
  const offUrl = barcode
    ? `https://world.openfoodfacts.org/cgi/product.pl?type=edit&code=${encodeURIComponent(barcode)}`
    : 'https://world.openfoodfacts.org';

  if (!FEATURES.contributions) {
    return html`
      ${header('Participar', true)}
      <main>
        <div class="card" style="text-align:center">
          <div style="font-size:2.4rem;line-height:1">🚧</div>
          <h2 style="margin:10px 0 6px;font-size:1.05rem;text-transform:none;letter-spacing:0;color:var(--text)">
            Próximamente
          </h2>
          <p style="margin:0;font-size:.9rem;color:var(--text-dim)">
            Estamos tramitando con Open Food Facts el permiso para que puedas publicar productos
            directamente desde aquí.
          </p>
        </div>

        <div class="card">
          <h2>Cómo funcionará</h2>
          <ol style="margin:0;padding-left:20px;font-size:.89rem;line-height:1.75">
            <li>Pulsas <em>Conectar con Open Food Facts</em>.</li>
            <li>Te identificas <strong>en la web de ellos</strong>, no aquí: esta aplicación nunca
              verá tu contraseña.</li>
            <li>Vuelves y publicas. El producto queda <strong>a tu nombre</strong> en Open Food
              Facts, y disponible para cualquiera que lo escanee.</li>
          </ol>
          <p class="source-note">
            Seguir usando la aplicación no requerirá cuenta nunca. La identificación solo aparece si
            decides publicar algo.
          </p>
        </div>

        <div class="card">
          <h2>Mientras tanto, sí puedes ayudar</h2>
          <p style="margin:0 0 12px;font-size:.89rem">
            Open Food Facts es una base de datos abierta que rellena la gente. En Venezuela hay
            1.721 productos registrados y en Colombia 7.293, frente a los 371.511 de España: lo que
            se añada ahí aparecerá aquí en la siguiente actualización.
          </p>
          <a
            href="${offUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="primary"
            style="display:block;text-align:center;text-decoration:none;box-sizing:border-box"
          >
            ${barcode ? `Añadir ${barcode} en Open Food Facts` : 'Ir a Open Food Facts'}
          </a>
        </div>
      </main>
    `;
  }

  return contributeFormView();
}

/**
 * Formulario de aportacion. Escrito y listo, a la espera de que
 * `FEATURES.contributions` se active.
 */
function contributeFormView(): SafeHtml {
  return html`
    ${header('Añadir producto', true)}
    <main>
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

/**
 * Tarjeta de la copia local por pais.
 *
 * Se muestra el tamano y lo que implica cada estrategia, porque descargar
 * megas sin avisar en una conexion movil no es aceptable.
 */
function snapshotCard(): SafeHtml {
  const index = state.snapshotIndex;
  if (!index) {
    return html`
      <div class="card">
        <h2>Copia local</h2>
        <p style="margin:0;font-size:.88rem;color:var(--text-dim)">
          No disponible en esta instalación. La aplicación funciona igualmente
          consultando Open Food Facts en vivo.
        </p>
      </div>
    `;
  }

  const countries = availableCountries(index);
  const current = state.country;
  const entry = current ? index.countries[current] : undefined;

  return html`
    <div class="card">
      <h2>Copia local por país</h2>
      <p style="margin:0 0 10px;font-size:.88rem;color:var(--text-dim)">
        Guardar la base de tu país acelera las consultas y, si es pequeña, hace
        que la aplicación funcione <strong>sin conexión</strong>.
      </p>

      <label for="country-select">País</label>
      <select id="country-select">
        <option value="">Ninguno (solo consulta en vivo)</option>
        ${countries.map(
          (c) => html`<option value="${c.code}" ${raw(c.code === current ? 'selected' : '')}>
            ${COUNTRY_LABELS[c.code] ?? c.code} · ${c.products.toLocaleString('es')} productos ·
            ${(c.bytes / 1024 / 1024).toFixed(1)} MB
          </option>`,
        )}
      </select>

      ${state.snapshotStatus === 'loading'
        ? html`
            <div style="margin-top:12px">
              <div class="confidence" style="margin:0">
                <strong>Descargando…</strong>
                <div class="bar"><span id="snapshot-progress" style="width:0%"></span></div>
                <div id="snapshot-progress-label">preparando</div>
              </div>
            </div>
          `
        : raw('')}

      ${state.snapshotStatus === 'ready' && entry
        ? html`<p style="margin:12px 0 0;font-size:.86rem">
            ✓ ${state.snapshotDetail}
            ${strategyFor(entry) === 'download'
              ? html`<br /><span style="color:var(--text-dim)"
                  >Guardada en este dispositivo: funciona sin cobertura.</span
                >`
              : html`<br /><span style="color:var(--text-dim)"
                  >Demasiado grande para guardarla entera
                  (${(entry.bytes / 1024 / 1024).toFixed(0)} MB): se consultan solo las páginas
                  necesarias, así que requiere conexión.</span
                >`}
          </p>`
        : raw('')}

      ${state.snapshotStatus === 'error'
        ? html`<p style="margin:12px 0 0;font-size:.86rem;color:var(--danger)">
            No se pudo preparar: ${state.snapshotDetail}
          </p>`
        : raw('')}

      <p class="source-note">
        Datos generados el ${new Date(index.generated_at).toLocaleDateString('es')} a partir de
        Open Food Facts, bajo licencia ODbL.
      </p>
    </div>
  `;
}

function aboutView(): SafeHtml {
  return html`
    ${header('Método y fuentes')}
    <main>
      <div class="card">
        <h2>Cómo se calcula la puntuación</h2>
        <p style="margin:0 0 10px;font-size:.9rem">
          La nota de 0 a 100 combina cuatro bloques, cada uno con respaldo científico o
          regulatorio propio:
        </p>
        <table class="nutrient-table">
          <tbody>
            <tr><td>Calidad nutricional — Nutri-Score 2023</td><td>55%</td></tr>
            <tr><td>Grado de procesamiento — NOVA</td><td>20%</td></tr>
            <tr><td>Aditivos — sobreexposición según EFSA</td><td>20%</td></tr>
            <tr><td>Advertencias — modelo OPS/OMS</td><td>5%</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>En qué nos diferenciamos</h2>
        <ul style="margin:0;padding-left:20px;font-size:.89rem;line-height:1.7">
          <li>
            <strong>Riesgo, no peligro.</strong> Los aditivos se valoran por el riesgo de
            sobreexposición que evalúa EFSA, no por su peligro teórico al margen de la dosis.
          </li>
          <li>
            <strong>Sin topes ocultos.</strong> No hay reglas que congelen la nota en un valor
            arbitrario. Toda penalización es gradual y aparece desglosada.
          </li>
          <li>
            <strong>Sin bonus por "orgánico".</strong> No tiene respaldo en resultados de salud, así
            que se muestra como información y no suma puntos.
          </li>
          <li>
            <strong>Decimos lo que no sabemos.</strong> Si faltan datos, verás el nivel de
            confianza en vez de una precisión fingida.
          </li>
        </ul>
      </div>

      <div class="card">
        <h2>Fuentes</h2>
        <ul style="margin:0;padding-left:20px;font-size:.87rem;line-height:1.7">
          <li><a href="https://world.openfoodfacts.org" target="_blank" rel="noopener noreferrer">Open Food Facts</a> — base de productos, licencia ODbL</li>
          <li>Nutri-Score 2023 (FSAm-NPS), algoritmo revisado obligatorio desde el 31-12-2023</li>
          <li>Clasificación NOVA de grado de procesamiento</li>
          <li>Evaluaciones de aditivos de EFSA y lista de vigilancia de ANSES</li>
          <li><a href="https://www.paho.org/en/nutrient-profile-model" target="_blank" rel="noopener noreferrer">Modelo de Perfil de Nutrientes de la OPS</a> (2016)</li>
          <li>Reglamento (CE) 1223/2009 y base CosIng, para cosmética</li>
        </ul>
        <p class="source-note">
          Los datos de producto proceden de Open Food Facts y se usan bajo licencia ODbL. La base
          derivada que distribuimos hereda esa misma licencia.
        </p>
      </div>

      ${snapshotCard()}

      <div class="card">
        <h2>Privacidad</h2>
        <ul style="margin:0;padding-left:20px;font-size:.88rem;line-height:1.7">
          <li>No hay cuenta, ni registro, ni servidor propio.</li>
          <li>El historial y los productos guardados no salen de este dispositivo.</li>
          <li>La aplicación no envía ningún dato personal a ninguna parte.</li>
        </ul>
      </div>

      <div class="notice info">
        Esta aplicación es informativa y no sustituye el consejo de un profesional sanitario. No
        diagnostica ni prescribe.
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
    contribute: contributeView,
    about: aboutView,
  };
  mount(root, html`${views[state.view]()} ${tabbar()}`);

  // Se devuelve el <video> persistente a su contenedor. Al ser siempre el mismo
  // nodo, el stream y el escaner siguen vivos entre renders.
  if (state.view === 'scan') {
    const stage = document.getElementById('stage');
    if (stage && !stage.contains(videoEl)) stage.prepend(videoEl);
    if (state.scannerActive) void attachCamera();
  }
}

async function navigate(view: View): Promise<void> {
  if (state.view === 'scan' && view !== 'scan') stopCamera();
  state.view = view;
  state.error = undefined;
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
    state.assessment = await repo.assess(normalized);
  } catch (err) {
    if (err instanceof ProductNotFoundError) {
      state.error =
        'Este producto no está en las bases de datos abiertas. Puedes añadirlo tú y ayudar a quien venga detrás.';
    } else if (err instanceof OffRateLimitError) {
      const seconds = Math.ceil(err.retryAfterMs / 1000);
      state.error = `Open Food Facts limita las consultas a 15 por minuto. Inténtalo de nuevo en ${seconds} segundos.`;
    } else {
      state.error = err instanceof Error ? err.message : 'Error desconocido';
    }
  } finally {
    state.loading = false;
    render();
  }
}

async function attachCamera(): Promise<void> {
  if (scanner) return;
  scanner = new CameraScanner({
    video: videoEl,
    onResult: (result) => void lookup(result.barcode),
    onDiagnostics: (d) => {
      state.diagnostics = d;
      // Solo se refresca el panel: un render completo aqui seria un derroche a
      // 5 fotogramas por segundo.
      const panel = root.querySelector('details.card');
      if (panel?.hasAttribute('open')) {
        const fresh = document.createElement('div');
        fresh.innerHTML = diagnosticsPanel().value;
        const next = fresh.firstElementChild;
        if (next) {
          next.setAttribute('open', '');
          panel.replaceWith(next);
        }
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
  } catch (err) {
    scanner = undefined;
    state.scannerActive = false;
    state.error =
      err instanceof Error && err.name === 'NotAllowedError'
        ? 'No has dado permiso para usar la cámara. Puedes introducir el código a mano.'
        : `No se ha podido abrir la cámara: ${err instanceof Error ? err.message : err}`;
    render();
  }
}

function stopCamera(): void {
  scanner?.stop();
  scanner = undefined;
  state.scannerActive = false;
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
  const action = el.dataset.action;

  switch (action) {
    case 'nav':
      void navigate(el.dataset.view as View);
      break;
    case 'back':
      void navigate('scan');
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
      const value = (document.getElementById('manual-barcode') as HTMLInputElement)?.value;
      if (value) void lookup(value);
      break;
    }
    case 'open':
      if (el.dataset.barcode) void lookup(el.dataset.barcode);
      break;
    case 'clear-history':
      void clearHistory().then(() => navigate('history'));
      break;
    case 'search': {
      const term = (document.getElementById('search-term') as HTMLInputElement)?.value ?? '';
      state.loading = true;
      render();
      void repo.search(term).then((results) => {
        state.searchResults = results;
        state.loading = false;
        render();
      });
      break;
    }
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
        void navigate('about');
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

root.addEventListener('change', (event) => {
  const select = event.target as HTMLSelectElement;
  if (select.id === 'country-select') {
    const value = select.value;
    if (!value) {
      void repo.snapshot?.close().catch(() => {});
      repo.setSnapshot(undefined);
      state.country = undefined;
      state.snapshotStatus = 'none';
      try {
        localStorage.removeItem(COUNTRY_STORAGE_KEY);
      } catch {
        /* almacenamiento bloqueado */
      }
      render();
    } else {
      void useCountry(value);
    }
    return;
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

root.addEventListener('keydown', (event) => {
  const e = event as KeyboardEvent;
  if (e.key !== 'Enter') return;
  const target = e.target as HTMLElement;
  if (target.id === 'manual-barcode') {
    void lookup((target as HTMLInputElement).value);
  } else if (target.id === 'search-term') {
    (root.querySelector('[data-action="search"]') as HTMLElement | null)?.click();
  }
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
    state.snapshotIndex = index;
    state.snapshotAvailable = true;

    let chosen: string | undefined;
    try {
      chosen = localStorage.getItem(COUNTRY_STORAGE_KEY) ?? undefined;
    } catch {
      /* almacenamiento bloqueado */
    }
    const codes = Object.keys(index.countries);
    if (!chosen || !codes.includes(chosen)) chosen = guessCountry(codes);

    // Sin pais deducible no se descarga nada: bajar megas que el usuario no ha
    // pedido, y que quiza no le sirvan, seria abusivo.
    if (chosen) await useCountry(chosen);
    else render();
  });

  if (code) void lookup(code);
}

void boot();
