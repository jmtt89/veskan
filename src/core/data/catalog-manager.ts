/**
 * Gestor de catalogos por pais.
 *
 * Reemplaza al modelo de "un solo pais elegido en un desplegable". Ahora el
 * usuario puede tener varios descargados a la vez, y los que no lo esten se
 * consultan igualmente por rangos HTTP antes de recurrir a la API.
 *
 * El motivo de permitir varios esta medido: en Latinoamerica los importados
 * estadounidenses son frecuentes (19,3% del catalogo mexicano, 13,8% del
 * venezolano llevan prefijo GS1 de Estados Unidos), asi que un usuario mexicano
 * necesita Mexico Y Estados Unidos.
 *
 * Orden de consulta, de mas barato a mas caro:
 *
 *   1. catalogos descargados   disco, sin red, ~5-50 ms
 *   2. catalogo sugerido por el prefijo GS1, por rangos   necesita red, sin limite
 *   3. (fuera de aqui) la API de Open Food Facts   15 peticiones/min
 *
 * El paso 2 existe para no gastar el cupo de un servicio donado cuando el
 * producto esta en un catalogo que ya publicamos.
 */

import type { Product } from '../types.js';
import { snapshotPriority } from '../scanner/gs1.js';
import { SqliteHttpSource } from './sqlite-http/client.js';
import { COUNTRY_LABELS, type SnapshotIndex } from './sqlite-http/snapshot-index.js';
import {
  classifyEviction,
  detectIosWebkit,
  evictionWarning,
  isInstalled,
  planSpace,
  requestPersistence,
  spaceProblemMessage,
  opfsUnsupportedMessage,
  unknownQuotaWarning,
  type UserMessage,
} from './storage-check.js';

export type CatalogState =
  /** Publicado pero no descargado. Se consulta por rangos si hace falta. */
  | 'absent'
  | 'downloading'
  /** En disco. Funciona sin conexion. */
  | 'ready'
  | 'error';

export interface CatalogView {
  country: string;
  label: string;
  products: number;
  bytes: number;
  state: CatalogState;
  progress?: { loaded: number; total: number };
  /** Motivo por el que no se pudo, con texto ya listo para mostrar */
  problem?: UserMessage;
  /** Advertencia que no impide descargar, p.ej. el borrado a los 7 dias */
  warning?: string;
}

interface Capabilities {
  opfs: boolean;
  reason?: string;
  detail?: string;
  catalogs: string[];
}

export interface CatalogManagerOptions {
  baseUrl: string;
  /** Se llama cuando cambia el estado de un pais, para refrescar la interfaz */
  onChange: (country: string) => void;
}

const STORAGE_KEY = 'veskan.catalogs';

export class CatalogManager {
  private index?: SnapshotIndex;
  private readonly states = new Map<string, CatalogView>();
  /** Fuentes abiertas: descargadas y las de rango que se hayan necesitado */
  private readonly sources = new Map<string, SqliteHttpSource>();
  private downloaded: string[] = [];
  private suggested: string | undefined;
  private capabilities?: Capabilities;

  constructor(private readonly opts: CatalogManagerOptions) {}

  async init(index: SnapshotIndex): Promise<void> {
    this.index = index;

    // Se pregunta al Worker que hay REALMENTE en disco, en lugar de fiarse de
    // lo que diga localStorage: el navegador puede haber liberado espacio, y
    // mostrar como descargado algo que ya no esta seria mentir.
    this.capabilities = await this.askCapabilities();
    if (!this.capabilities.opfs) {
      console.warn(
        `[opfs] almacen local no disponible (${this.capabilities.reason ?? 'sin motivo'}):`,
        this.capabilities.detail ?? '',
      );
    }
    const enDisco = this.capabilities.catalogs;

    for (const [country, entry] of Object.entries(index.countries)) {
      this.states.set(country, {
        country,
        label: COUNTRY_LABELS[country] ?? country,
        products: entry.products,
        bytes: entry.bytes,
        state: enDisco.includes(country) ? 'ready' : 'absent',
        warning: this.evictionNote(),
        problem: this.capabilities.opfs
          ? undefined
          : opfsUnsupportedMessage(this.capabilities.reason ?? 'unknown'),
      });
    }

    // Lo que el usuario creia tener y ya no esta: se dice, no se oculta.
    for (const country of this.remembered()) {
      if (!enDisco.includes(country) && this.states.has(country)) {
        const view = this.states.get(country)!;
        view.problem = {
          title: 'Se perdió la copia local',
          body:
            `El catálogo de ${view.label} ya no está en este dispositivo. El navegador puede ` +
            'haberlo liberado para hacer sitio. Puedes volver a descargarlo.',
        };
        this.opts.onChange(country);
      }
    }

    this.downloaded = enDisco;
    this.remember();
    await Promise.all(enDisco.map((c) => this.openLocal(c)));
  }

  /**
   * Marca un pais como sugerido para que salga el primero de la lista.
   *
   * Solo cambia el orden: no descarga nada. Un catalogo pesa megabytes y la
   * deduccion por idioma o por prefijo GS1 acierta a menudo, pero no siempre.
   */
  suggest(country: string): void {
    if (this.states.has(country)) this.suggested = country;
  }

  list(): CatalogView[] {
    // Descargados primero; despues el sugerido; dentro de cada grupo, por
    // numero de productos.
    return [...this.states.values()].sort((a, b) => {
      const peso = (v: CatalogView) =>
        v.state === 'ready' ? 0 : v.state === 'downloading' ? 1 : v.country === this.suggested ? 2 : 3;
      return peso(a) - peso(b) || b.products - a.products;
    });
  }

  get(country: string): CatalogView | undefined {
    return this.states.get(country);
  }

  get downloadedCountries(): string[] {
    return [...this.downloaded];
  }

  // -------------------------------------------------------------------------
  // Descarga y borrado
  // -------------------------------------------------------------------------

  async download(country: string): Promise<void> {
    const view = this.states.get(country);
    const entry = this.index?.countries[country];
    if (!view || !entry) return;

    // Comprobar ANTES de empezar, no a mitad: el criterio es avisar, no
    // degradar en silencio ni fallar a medio camino.
    if (!this.capabilities?.opfs) {
      view.problem = opfsUnsupportedMessage(this.capabilities?.reason ?? 'unknown');
      view.state = 'error';
      this.opts.onChange(country);
      return;
    }

    const need = planSpace(await this.estimate(), entry.bytes);
    if (!need.fits) {
      view.problem = spaceProblemMessage(need, view.label);
      view.state = 'error';
      this.opts.onChange(country);
      return;
    }
    const avisoCuota = unknownQuotaWarning(need);

    await requestPersistence();

    view.state = 'downloading';
    view.problem = undefined;
    view.progress = { loaded: 0, total: entry.bytes };
    this.opts.onChange(country);

    try {
      await this.sources.get(country)?.close();
      const source = new SqliteHttpSource({
        source: country,
        url: `${this.opts.baseUrl}/${entry.file}`,
        strategy: 'download',
        onProgress: (p) => {
          view.progress = p;
          this.opts.onChange(country);
        },
      });
      await source.init();
      this.sources.set(country, source);

      view.state = 'ready';
      view.progress = undefined;
      view.warning = avisoCuota ?? this.evictionNote();
      if (!this.downloaded.includes(country)) this.downloaded.push(country);
      this.remember();
    } catch (err) {
      view.state = 'error';
      view.progress = undefined;
      view.problem = this.describeFailure(err, view.label);
      this.sources.delete(country);
    }
    this.opts.onChange(country);
  }

  async remove(country: string): Promise<void> {
    const view = this.states.get(country);
    if (!view) return;
    await this.sources.get(country)?.close();
    this.sources.delete(country);
    try {
      const { send } = await import('./sqlite-http/worker-pool.js');
      await send({ type: 'remove', source: country });
    } catch {
      /* si no se pudo borrar, el estado siguiente lo reflejara */
    }
    this.downloaded = this.downloaded.filter((c) => c !== country);
    this.remember();
    view.state = 'absent';
    view.problem = undefined;
    view.progress = undefined;
    this.opts.onChange(country);
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  /**
   * Busca un producto recorriendo los catalogos por orden de probabilidad.
   *
   * Devuelve tambien de cual salio, para poder decirselo al usuario.
   */
  async getProduct(barcode: string): Promise<{ product: Product; country: string } | undefined> {
    for (const country of snapshotPriority(barcode, this.downloaded)) {
      const source = await this.sourceFor(country);
      if (!source) continue;
      try {
        const product = await source.getProduct(barcode);
        if (product) return { product, country };
      } catch {
        // Un catalogo que falla no debe impedir probar el siguiente.
        continue;
      }
    }
    return undefined;
  }

  /**
   * Busqueda por texto, solo sobre los catalogos descargados.
   *
   * Los de rango quedan fuera a proposito: buscar en ellos obligaria a leer el
   * indice de texto por la red para un caso poco frecuente. Quien quiera buscar
   * en un catalogo, que lo descargue.
   */
  async search(term: string, limit = 25): Promise<Product[]> {
    const resultados = await Promise.all(
      this.downloaded.map(async (c) => {
        try {
          return await (await this.sourceFor(c))?.search(term, limit) ?? [];
        } catch {
          return [];
        }
      }),
    );
    const vistos = new Set<string>();
    const unidos: Product[] = [];
    for (const lista of resultados) {
      for (const p of lista) {
        if (vistos.has(p.barcode)) continue;
        vistos.add(p.barcode);
        unidos.push(p);
      }
    }
    return unidos.slice(0, limit);
  }

  /** Cierra todo. Para tests y para cambiar de indice. */
  async close(): Promise<void> {
    await Promise.all([...this.sources.values()].map((s) => s.close()));
    this.sources.clear();
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  /** Abre la fuente de un pais, creandola por rangos si no esta descargado. */
  private async sourceFor(country: string): Promise<SqliteHttpSource | undefined> {
    const existente = this.sources.get(country);
    if (existente) return existente;

    const entry = this.index?.countries[country];
    if (!entry) return undefined;

    const source = new SqliteHttpSource({
      source: country,
      url: `${this.opts.baseUrl}/${entry.file}`,
      strategy: 'range',
    });
    try {
      await source.init();
    } catch {
      return undefined;
    }
    this.sources.set(country, source);
    return source;
  }

  private async openLocal(country: string): Promise<void> {
    const entry = this.index?.countries[country];
    if (!entry) return;
    try {
      const source = new SqliteHttpSource({
        source: country,
        url: `${this.opts.baseUrl}/${entry.file}`,
        strategy: 'download',
      });
      await source.init();
      this.sources.set(country, source);
    } catch (err) {
      const view = this.states.get(country);
      if (view) {
        view.state = 'error';
        view.problem = this.describeFailure(err, view.label);
        this.opts.onChange(country);
      }
    }
  }

  private async askCapabilities(): Promise<Capabilities> {
    try {
      const { send } = await import('./sqlite-http/worker-pool.js');
      return await send<Capabilities>({ type: 'capabilities' });
    } catch (err) {
      console.warn('[opfs] no se ha podido abrir el almacen local:', err);
      return { opfs: false, reason: 'unknown', detail: String(err), catalogs: [] };
    }
  }

  private async estimate(): Promise<{ quota?: number; usage?: number } | undefined> {
    try {
      return await navigator.storage?.estimate?.();
    } catch {
      return undefined;
    }
  }

  private evictionNote(): string | undefined {
    const ios = detectIosWebkit(navigator.userAgent, navigator.maxTouchPoints ?? 0);
    // `persisted` se consulta de forma optimista: si no se sabe, el aviso
    // generico es preferible al silencio.
    return evictionWarning(
      classifyEviction({ isIosWebkit: ios, installed: isInstalled(), persisted: false }),
    );
  }

  private describeFailure(err: unknown, label: string): UserMessage {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('interrumpio') || msg.includes('Truncated')) {
      return { title: 'La descarga se interrumpió', body: msg };
    }
    if (msg.includes('otra pestana') || msg.includes('otra pestaña')) {
      return opfsUnsupportedMessage('locked-by-other-tab');
    }
    return {
      title: `No se pudo guardar ${label}`,
      body: `${msg}. Puedes volver a intentarlo; mientras tanto se consultará en línea.`,
    };
  }

  private remembered(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  private remember(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.downloaded));
    } catch {
      /* almacenamiento bloqueado: se perdera la lista, no los datos */
    }
  }
}
