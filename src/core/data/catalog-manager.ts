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
import { invalidateCached } from './idb.js';
import { snapshotPriority } from '../scanner/gs1.js';
import { SqliteHttpSource } from './sqlite-http/client.js';
import {
  COUNTRY_LABELS,
  partFor,
  partsOf,
  type SnapshotIndex,
} from './sqlite-http/snapshot-index.js';
import { fetchDelta, planSync, syncCost, type SyncPlan } from './sqlite-http/delta-sync.js';
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
  /** En disco, aplicando un delta encima */
  | 'updating'
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
  /** Hay una version mas nueva publicada, y lo que costaria ponerse al dia */
  update?: { plan: SyncPlan; cost: string };
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
  /**
   * Fuentes abiertas, por pais, EN ORDEN DE PARTE.
   *
   * Un catalogo puede ser varios SQLite: los de mas de 100 MB no caben en un
   * archivo de GitHub y se parten por rango de codigo de barras. Cada parte es
   * una base completa, con su propio indice de texto.
   */
  private readonly sources = new Map<string, SqliteHttpSource[]>();
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

  async download(country: string, opts: { force?: boolean } = {}): Promise<void> {
    const view = this.states.get(country);
    const entry = this.index?.countries[country];
    if (!view || !entry) return;

    // Al reemplazar una copia vieja hay que borrar la de disco primero: si no,
    // el Worker la encuentra ya presente y se salta la descarga.
    if (opts.force) await this.remove(country);

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
      await this.closeSources(country);
      const partes = partsOf(entry);
      const abiertas: SqliteHttpSource[] = [];
      // Las partes se bajan una tras otra, no a la vez: en paralelo el aviso de
      // progreso saltaria hacia atras y adelante, y ademas se multiplicaria la
      // memoria durante la escritura en disco.
      let yaBajado = 0;
      for (const [i, parte] of partes.entries()) {
        const source = new SqliteHttpSource({
          source: CatalogManager.sourceId(country, i, partes.length),
          url: `${this.opts.baseUrl}/${parte.file}`,
          strategy: 'download',
          onProgress: (p) => {
            view.progress = { loaded: yaBajado + p.loaded, total: entry.bytes };
            this.opts.onChange(country);
          },
        });
        await source.init();
        abiertas.push(source);
        yaBajado += parte.bytes;
      }
      this.sources.set(country, abiertas);

      view.state = 'ready';
      view.progress = undefined;
      view.update = undefined;
      view.warning = avisoCuota ?? this.evictionNote();
      if (!this.downloaded.includes(country)) this.downloaded.push(country);
      this.remember();
      // Lo recien bajado es, por definicion, la version publicada; pero se
      // comprueba igual por si el indice cambio durante la descarga.
      void this.checkUpdate(country);
    } catch (err) {
      view.state = 'error';
      view.progress = undefined;
      view.problem = this.describeFailure(err, view.label);
      this.sources.delete(country);
    }
    this.opts.onChange(country);
  }

  /** Cierra y olvida todas las partes de un pais. */
  private async closeSources(country: string): Promise<void> {
    for (const s of this.sources.get(country) ?? []) await s.close().catch(() => {});
    this.sources.delete(country);
  }

  async remove(country: string): Promise<void> {
    const view = this.states.get(country);
    if (!view) return;
    const partes = this.index ? partsOf(this.index.countries[country]!) : [];
    await this.closeSources(country);
    try {
      const { send } = await import('./sqlite-http/worker-pool.js');
      // Se borra parte por parte: cada una es un archivo propio en el disco.
      for (let i = 0; i < Math.max(1, partes.length); i++) {
        await send({ type: 'remove', source: CatalogManager.sourceId(country, i, partes.length || 1) });
      }
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
  // Actualizacion incremental
  // -------------------------------------------------------------------------

  /**
   * Mira si los catalogos guardados se han quedado viejos.
   *
   * No actualiza: solo deja escrito en la vista lo que costaria, para que el
   * usuario decida. Bajar megas sin pedirlo seria abusivo, y aqui ademas hay un
   * motivo tecnico: aplicar un delta escribe sobre la base, y hacerlo justo
   * mientras alguien escanea alargaria la consulta sin necesidad.
   */
  async checkUpdates(): Promise<void> {
    await Promise.all(this.downloaded.map((c) => this.checkUpdate(c)));
  }

  /**
   * Revisa un solo pais.
   *
   * Tiene que llamarse tambien DESPUES de descargar: si no, el aviso calculado
   * para la copia anterior se queda pegado a una copia que ya esta al dia, y el
   * usuario ve "actualizacion disponible" sobre lo que acaba de bajar.
   */
  private async checkUpdate(country: string): Promise<void> {
    const view = this.states.get(country);
    const entry = this.index?.countries[country];
    if (!view || !entry || view.state !== 'ready') return;
    const antes = view.update?.cost;
    try {
      const plan = await this.planFor(country, entry);
      const cost = syncCost(plan, entry);
      view.update = cost ? { plan, cost } : undefined;
    } catch {
      // Si no se puede saber, no se inventa un aviso: se quita el que hubiera.
      view.update = undefined;
    }
    if (view.update?.cost !== antes) this.opts.onChange(country);
  }

  /**
   * Plan de actualizacion del catalogo entero, mirando parte por parte.
   *
   * Cada parte lleva su propia cadena de deltas: en una noche pueden cambiar
   * productos de una y ninguno de otra. Pero la decision es del catalogo, no de
   * la parte: si a UNA le falta un eslabon hay que bajarlo todo, porque las
   * partes de un mismo catalogo tienen que estar en la misma version -- si no,
   * un producto podria aparecer con datos de anteayer segun en que rango caiga.
   */
  private async planFor(country: string, entry: SnapshotIndex['countries'][string]): Promise<SyncPlan> {
    const local = await this.sources.get(country)?.[0]?.version();
    const partes = partsOf(entry);
    const planes = partes.map((parte) =>
      planSync(local, { ...entry, bytes: parte.bytes, deltas: parte.deltas }),
    );

    const completo = planes.find((p) => p.kind === 'full');
    if (completo) return completo;
    if (planes.every((p) => p.kind === 'up-to-date')) return { kind: 'up-to-date' };

    const chain = planes.flatMap((p) => (p.kind === 'deltas' ? p.chain : []));
    return { kind: 'deltas', chain, bytes: chain.reduce((t, d) => t + d.bytes, 0) };
  }

  /**
   * Pone al dia un catalogo.
   *
   * Si hay cadena de deltas se aplican en orden; si no la hay -- porque la copia
   * local es mas vieja que el historial publicado, o porque cambio el esquema --
   * se vuelve a descargar entero. La decision la toma `planSync`, que es pura y
   * esta probada aparte.
   */
  async update(country: string): Promise<void> {
    const view = this.states.get(country);
    const entry = this.index?.countries[country];
    if (!view || !entry || view.state !== 'ready') return;

    const plan = view.update?.plan ?? (await this.planFor(country, entry));
    if (plan.kind === 'up-to-date') {
      view.update = undefined;
      this.opts.onChange(country);
      return;
    }
    if (plan.kind === 'full') {
      view.update = undefined;
      await this.download(country, { force: true });
      return;
    }

    view.state = 'updating';
    view.progress = { loaded: 0, total: plan.bytes };
    this.opts.onChange(country);

    try {
      const fuentes = this.sources.get(country) ?? [];
      if (!fuentes.length) throw new Error('El catálogo no está abierto');
      let bajado = 0;
      for (const paso of plan.chain) {
        const delta = await fetchDelta(`${this.opts.baseUrl}/${paso.file}`);
        // Se comprueba el eslabon ANTES de tocar la base: un indice mal
        // publicado no debe poder mezclar el delta de un pais con otro, ni
        // saltarse un dia dejando la base en una version que no existe.
        if (delta.header.country !== country || delta.header.from !== paso.from) {
          throw new Error('El delta descargado no corresponde a este catálogo');
        }
        // Cada delta dice a que parte pertenece. Aplicarlo a la equivocada
        // metería productos fuera de su rango y el enrutado por codigo dejaria
        // de encontrarlos.
        const idx = (delta.header.part ?? 1) - 1;
        const destino = fuentes[idx];
        if (!destino) throw new Error('El delta es de una parte que no tenemos');
        await destino.applyDelta(delta);
        // El cache de productos ya vistos es la PRIMERA capa que se consulta:
        // si no se invalida, el usuario no veria el cambio hasta 30 dias
        // despues, cuando caduque. Solo se borra lo que el delta toco.
        await invalidateCached([
          ...delta.upserts.map((u) => String(u['barcode'])),
          ...delta.deletes,
        ]);
        bajado += paso.bytes;
        view.progress = { loaded: bajado, total: plan.bytes };
        this.opts.onChange(country);
      }
      view.state = 'ready';
      view.progress = undefined;
      view.update = undefined;
      view.problem = undefined;
    } catch (err) {
      // La base sigue en su version anterior: `applyDelta` va en transaccion y
      // deshace si falla. Asi que esto NO deja el catalogo inservible.
      view.state = 'ready';
      view.progress = undefined;
      view.problem = {
        title: 'No se ha podido actualizar',
        body:
          `${err instanceof Error ? err.message : 'Error desconocido'}. El catálogo que tienes ` +
          'sigue funcionando; puedes volver a intentarlo.',
      };
    }
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
      const entry = this.index?.countries[country];
      if (!entry) continue;
      const fuentes = await this.sourcesFor(country);
      if (!fuentes.length) continue;

      // En un catalogo partido solo se consulta la parte que puede contenerlo.
      // Preguntar a todas multiplicaria por tres las lecturas de disco -- o las
      // peticiones por red, en el modo por rangos -- de cada escaneo.
      const partes = partsOf(entry);
      const parte = partFor(partes, barcode);
      const indice = parte ? partes.indexOf(parte) : -1;
      const candidatas = indice >= 0 && fuentes[indice] ? [fuentes[indice]] : fuentes;

      for (const source of candidatas) {
        try {
          const product = await source.getProduct(barcode);
          if (product) return { product, country };
        } catch {
          // Una parte que falla no debe impedir probar el resto.
          continue;
        }
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
    // Aqui si hay que preguntar a TODAS las partes: un nombre puede estar en
    // cualquier rango de codigos, y cada parte tiene su propio indice de texto.
    const resultados = await Promise.all(
      this.downloaded.flatMap((c) =>
        [...Array(1)].map(async () => {
          const fuentes = await this.sourcesFor(c);
          const porParte = await Promise.all(
            fuentes.map((f) => f.search(term, limit).catch(() => [] as Product[])),
          );
          return porParte.flat();
        }),
      ),
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
    await Promise.all([...this.sources.values()].flat().map((s) => s.close()));
    this.sources.clear();
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  /**
   * Nombre con el que el Worker conoce una parte.
   *
   * Tiene que ser unico: el Worker guarda una conexion por nombre, y dos partes
   * del mismo pais compartiendo nombre se pisarian.
   */
  private static sourceId(country: string, i: number, total: number): string {
    return total === 1 ? country : `${country}-${String(i + 1).padStart(2, '0')}`;
  }

  /** Abre las partes de un pais, por rangos si no esta descargado. */
  private async sourcesFor(country: string): Promise<SqliteHttpSource[]> {
    const existentes = this.sources.get(country);
    if (existentes?.length) return existentes;

    const entry = this.index?.countries[country];
    if (!entry) return [];

    const partes = partsOf(entry);
    const abiertas: SqliteHttpSource[] = [];
    for (const [i, parte] of partes.entries()) {
      const source = new SqliteHttpSource({
        source: CatalogManager.sourceId(country, i, partes.length),
        url: `${this.opts.baseUrl}/${parte.file}`,
        strategy: 'range',
      });
      try {
        await source.init();
        abiertas.push(source);
      } catch {
        // Una parte que no abre no debe tumbar a las demas: el producto puede
        // estar en otra.
        continue;
      }
    }
    if (abiertas.length) this.sources.set(country, abiertas);
    return abiertas;
  }

  private async openLocal(country: string): Promise<void> {
    const entry = this.index?.countries[country];
    if (!entry) return;
    const partes = partsOf(entry);
    try {
      const abiertas: SqliteHttpSource[] = [];
      for (const [i, parte] of partes.entries()) {
        const source = new SqliteHttpSource({
          source: CatalogManager.sourceId(country, i, partes.length),
          url: `${this.opts.baseUrl}/${parte.file}`,
          strategy: 'download',
        });
        await source.init();
        abiertas.push(source);
      }
      this.sources.set(country, abiertas);
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
