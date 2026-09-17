/**
 * Tests del gestor de catalogos.
 *
 * Lo que se prueba aqui son las decisiones: a quien se le pregunta primero por
 * un codigo, que se hace cuando el usuario creia tener un catalogo que ya no
 * esta, y cuando hay que negarse a descargar. La parte de SQLite se sustituye
 * por un doble, porque abre un Worker y no aporta nada a estas decisiones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '../src/core/types.js';

/** Catalogos que el doble de `SqliteHttpSource` finge tener. */
const contenido = new Map<string, Map<string, Product>>();
/** Paises cuya apertura debe fallar, para probar la caida al siguiente. */
const rotos = new Set<string>();
const aperturas: string[] = [];

vi.mock('../src/core/data/sqlite-http/client.js', () => ({
  SqliteHttpSource: class {
    readonly source: string;
    constructor(opts: { source: string; strategy: string }) {
      this.source = opts.source;
      aperturas.push(`${opts.source}:${opts.strategy}`);
    }
    async init(): Promise<void> {
      if (rotos.has(this.source)) throw new Error(`catalogo roto: ${this.source}`);
    }
    async getProduct(barcode: string): Promise<Product | undefined> {
      if (rotos.has(this.source)) throw new Error('lectura fallida');
      return contenido.get(this.source)?.get(barcode);
    }
    async search(): Promise<Product[]> {
      return [...(contenido.get(this.source)?.values() ?? [])];
    }
    async version(): Promise<string | undefined> {
      return versiones.get(this.source);
    }
    async applyDelta(d: { header: { to: string } }): Promise<{ applied: number; reindexed: number }> {
      aplicados.push(`${this.source}:${d.header.to}`);
      versiones.set(this.source, d.header.to);
      return { applied: 1, reindexed: 0 };
    }
    async close(): Promise<void> {}
  },
}));

/** Version que finge tener cada catalogo en disco. */
const versiones = new Map<string, string>();
/** Deltas que se han llegado a aplicar, para comprobar el orden. */
const aplicados: string[] = [];
/** Deltas servidos por la red simulada. */
const deltasServidos = new Map<string, unknown>();

vi.mock('../src/core/data/sqlite-http/delta-sync.js', async (original) => {
  const real = await original<typeof import('../src/core/data/sqlite-http/delta-sync.js')>();
  return {
    ...real,
    // Solo se sustituye la descarga: `planSync` y `parseDelta` son los de
    // verdad, que es justo lo que interesa ejercitar aqui.
    fetchDelta: async (url: string) => {
      const d = deltasServidos.get(url);
      if (!d) throw new Error(`delta no publicado: ${url}`);
      return d;
    },
  };
});

vi.mock('../src/core/data/idb.js', () => ({
  invalidateCached: async (b: string[]) => void invalidados.push(...b),
}));
const invalidados: string[] = [];

/** Lo que el Worker dice que hay REALMENTE en disco. */
let enDisco: string[] = [];
let opfsDisponible = true;

vi.mock('../src/core/data/sqlite-http/worker-pool.js', () => ({
  send: async (msg: { type: string }) => {
    if (msg.type === 'capabilities') {
      return opfsDisponible
        ? { opfs: true, catalogs: enDisco }
        : { opfs: false, reason: 'no-api', catalogs: [] };
    }
    if (msg.type === 'remove') return { removed: true };
    return null;
  },
}));

const { CatalogManager } = await import('../src/core/data/catalog-manager.js');

const producto = (barcode: string, name: string): Product =>
  ({ barcode, name, brands: '', source: 'snapshot' }) as unknown as Product;

const indice = {
  generated_at: '2026-09-16',
  countries: {
    spain: { file: 'spain.sqlite3', products: 339_562, bytes: 80_367_616 },
    mexico: { file: 'mexico.sqlite3', products: 16_218, bytes: 6_600_000 },
    venezuela: { file: 'venezuela.sqlite3', products: 1_516, bytes: 540_672 },
  },
};

const almacen = new Map<string, string>();

beforeEach(() => {
  contenido.clear();
  rotos.clear();
  aperturas.length = 0;
  almacen.clear();
  versiones.clear();
  aplicados.length = 0;
  deltasServidos.clear();
  invalidados.length = 0;
  enDisco = [];
  opfsDisponible = true;

  vi.stubGlobal('localStorage', {
    getItem: (k: string) => almacen.get(k) ?? null,
    setItem: (k: string, v: string) => void almacen.set(k, v),
    removeItem: (k: string) => void almacen.delete(k),
  });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    maxTouchPoints: 0,
    storage: {
      estimate: async () => ({ quota: 5_000_000_000, usage: 0 }),
      persist: async () => true,
      persisted: async () => true,
    },
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

const crear = () => new CatalogManager({ baseUrl: 'https://ejemplo/data', onChange: () => {} });

describe('CatalogManager', () => {
  it('ordena los descargados primero y el sugerido por delante del resto', async () => {
    enDisco = ['venezuela'];
    const m = crear();
    await m.init(indice as never);
    m.suggest('mexico');

    // Venezuela es el mas pequeno de los tres, pero esta en disco.
    expect(m.list().map((c) => c.country)).toEqual(['venezuela', 'mexico', 'spain']);
  });

  it('se fia del disco y no de localStorage, y dice lo que se perdio', async () => {
    almacen.set('veskan.catalogs', JSON.stringify(['spain', 'venezuela']));
    enDisco = ['venezuela'];

    const m = crear();
    await m.init(indice as never);

    expect(m.downloadedCountries).toEqual(['venezuela']);
    expect(m.get('spain')?.state).toBe('absent');
    // No se oculta: el usuario lo descargo y tiene derecho a saber que ya no esta.
    expect(m.get('spain')?.problem?.title).toContain('Se perdió la copia local');
    expect(m.get('venezuela')?.problem).toBeUndefined();
  });

  it('consulta primero los catalogos descargados, en su orden', async () => {
    enDisco = ['venezuela', 'mexico'];
    // Codigo con prefijo GS1 estadounidense: el caso de los importados.
    contenido.set('venezuela', new Map([['0016000177758', producto('0016000177758', 'Fruit Roll-Ups')]]));

    const m = crear();
    await m.init(indice as never);

    const hallado = await m.getProduct('0016000177758');
    expect(hallado?.country).toBe('venezuela');
    expect(hallado?.product.name).toBe('Fruit Roll-Ups');

    // Si esta en dos, gana el primero de la lista de descargados, no el que
    // sugiera el prefijo: lo que el usuario tiene manda sobre la deduccion.
    contenido.set('mexico', new Map([['0016000177758', producto('0016000177758', 'Otro')]]));
    expect((await m.getProduct('0016000177758'))?.country).toBe('venezuela');
  });

  it('si un catalogo falla, sigue con el siguiente en vez de rendirse', async () => {
    enDisco = ['venezuela', 'mexico'];
    rotos.add('venezuela');
    contenido.set('mexico', new Map([['7500000125473', producto('7500000125473', 'Tortilla')]]));

    const m = crear();
    await m.init(indice as never);

    expect((await m.getProduct('7500000125473'))?.country).toBe('mexico');
  });

  it('no repite un producto que esta en dos catalogos a la vez', async () => {
    enDisco = ['venezuela', 'mexico'];
    const p = producto('7501000111114', 'Galletas');
    contenido.set('venezuela', new Map([[p.barcode, p]]));
    contenido.set('mexico', new Map([[p.barcode, p]]));

    const m = crear();
    await m.init(indice as never);

    expect(await m.search('galletas')).toHaveLength(1);
  });

  it('se niega a descargar si no cabe, y lo explica antes de tocar la red', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      maxTouchPoints: 0,
      storage: {
        // 90 MB libres frente a los 80 MB de Espana: no caben con el margen
        // del journal, y hay que decirlo en vez de fallar a mitad.
        estimate: async () => ({ quota: 90_000_000, usage: 0 }),
        persist: async () => true,
        persisted: async () => true,
      },
    });

    const m = crear();
    await m.init(indice as never);
    await m.download('spain');

    expect(m.get('spain')?.state).toBe('error');
    expect(m.get('spain')?.problem?.body).toMatch(/MB/);
    expect(aperturas).toEqual([]);
  });

  it('se niega a descargar si el navegador no puede guardar', async () => {
    opfsDisponible = false;
    const m = crear();
    await m.init(indice as never);
    await m.download('venezuela');

    expect(m.get('venezuela')?.state).toBe('error');
    expect(aperturas).toEqual([]);
  });

  it('avisa de la actualizacion con el peso del delta, no el del catalogo', async () => {
    enDisco = ['venezuela'];
    versiones.set('venezuela', 'v1');
    const idx = JSON.parse(JSON.stringify(indice));
    idx.countries.venezuela.version = 'v2';
    idx.countries.venezuela.deltas = [
      { from: 'v1', to: 'v2', file: 'deltas/venezuela/v2.jsonl.gz', bytes: 1200, upserts: 3, deletes: 1 },
    ];

    const m = crear();
    await m.init(idx as never);
    await m.checkUpdates();

    // 1 kB, no los 540 kB del catalogo: es el punto de toda la fase.
    expect(m.get('venezuela')?.update?.cost).toContain('kB');
    expect(m.get('venezuela')?.update?.cost).not.toContain('entero');
  });

  it('aplica los deltas en orden y deja de avisar', async () => {
    enDisco = ['venezuela'];
    versiones.set('venezuela', 'v1');
    const idx = JSON.parse(JSON.stringify(indice));
    idx.countries.venezuela.version = 'v3';
    idx.countries.venezuela.deltas = [
      { from: 'v1', to: 'v2', file: 'd/v2.gz', bytes: 900, upserts: 1, deletes: 0 },
      { from: 'v2', to: 'v3', file: 'd/v3.gz', bytes: 900, upserts: 1, deletes: 1 },
    ];
    const cabecera = (from: string, to: string) => ({
      header: { format: 1, country: 'venezuela', from, to, upserts: 1, deletes: 0, columns: ['barcode'] },
      upserts: [{ op: 'u', fts: 0, barcode: `b-${to}` }],
      deletes: [] as string[],
    });
    deltasServidos.set('https://ejemplo/data/d/v2.gz', cabecera('v1', 'v2'));
    deltasServidos.set('https://ejemplo/data/d/v3.gz', cabecera('v2', 'v3'));

    const m = crear();
    await m.init(idx as never);
    await m.checkUpdates();
    await m.update('venezuela');

    expect(aplicados).toEqual(['venezuela:v2', 'venezuela:v3']);
    expect(m.get('venezuela')?.update).toBeUndefined();
    expect(m.get('venezuela')?.state).toBe('ready');
    // Sin invalidar el cache, el usuario no veria el cambio en 30 dias.
    expect(invalidados).toEqual(['b-v2', 'b-v3']);
  });

  it('rechaza un delta que no encaja en la cadena, sin tocar la base', async () => {
    enDisco = ['venezuela'];
    versiones.set('venezuela', 'v1');
    const idx = JSON.parse(JSON.stringify(indice));
    idx.countries.venezuela.version = 'v2';
    idx.countries.venezuela.deltas = [
      { from: 'v1', to: 'v2', file: 'd/v2.gz', bytes: 900, upserts: 1, deletes: 0 },
    ];
    // El indice dice v1->v2 pero el archivo publicado dice venir de otra version.
    deltasServidos.set('https://ejemplo/data/d/v2.gz', {
      header: { format: 1, country: 'venezuela', from: 'vX', to: 'v2', upserts: 1, deletes: 0, columns: ['barcode'] },
      upserts: [{ op: 'u', fts: 0, barcode: 'b1' }],
      deletes: [],
    });

    const m = crear();
    await m.init(idx as never);
    await m.checkUpdates();
    await m.update('venezuela');

    expect(aplicados).toEqual([]);
    expect(m.get('venezuela')?.state).toBe('ready');
    expect(m.get('venezuela')?.problem?.title).toContain('No se ha podido actualizar');
    // Lo importante: el catalogo que ya tenia sigue sirviendo.
    expect(m.downloadedCountries).toEqual(['venezuela']);
  });

  it('borrar un catalogo no toca a los demas', async () => {
    enDisco = ['venezuela', 'mexico'];
    contenido.set('mexico', new Map([['7500000125473', producto('7500000125473', 'Tortilla')]]));

    const m = crear();
    await m.init(indice as never);
    await m.remove('venezuela');

    expect(m.downloadedCountries).toEqual(['mexico']);
    expect(m.get('venezuela')?.state).toBe('absent');
    expect((await m.getProduct('7500000125473'))?.country).toBe('mexico');
  });
});
