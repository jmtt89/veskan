/**
 * Banco de pruebas del VFS de SQLite sobre HTTP Range.
 *
 * No es codigo desechable: es la unica forma de verificar en un navegador real
 * lo que ningun test de Node puede comprobar (XHR sincrono en Worker, Range,
 * CORS y la interaccion con el Service Worker). Se sirve como entrada aparte,
 * fuera del bundle de la aplicacion.
 */

import { SqliteHttpSource } from '../core/data/sqlite-http/client.js';
import { openSources } from '../core/data/sqlite-http/worker-pool.js';

const BASE_URL = import.meta.env.VITE_SNAPSHOT_URL ?? 'http://localhost:8787';
// Para las comprobaciones de un solo archivo se usa el primer país del índice.
const SNAPSHOT_URL = `${BASE_URL}/venezuela.sqlite3`;
const out = document.getElementById('out')!;

interface Check {
  name: string;
  run: () => Promise<string>;
}

const source = new SqliteHttpSource({ source: 'diagnostico', url: SNAPSHOT_URL });

function log(name: string, status: 'ok' | 'fail' | 'run', detail: string): void {
  const icon = status === 'ok' ? '✅' : status === 'fail' ? '❌' : '⏳';
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `<strong>${icon} ${name}</strong><pre style="margin:8px 0 0;white-space:pre-wrap;font-size:.82rem">${detail}</pre>`;
  out.appendChild(div);
}

const checks: Check[] = [
  {
    name: '1. El servidor responde 206 a una petición Range',
    run: async () => {
      const res = await fetch(SNAPSHOT_URL, { headers: { Range: 'bytes=0-99' } });
      if (res.status !== 206) throw new Error(`Se esperaba 206 y llegó ${res.status}`);
      const range = res.headers.get('Content-Range');
      const len = res.headers.get('Content-Length');
      // `Content-Range` no es legible entre orígenes salvo que el servidor la
      // exponga con Access-Control-Expose-Headers, y raw.githubusercontent no
      // lo hace. No es un problema: el VFS averigua el tamaño con HEAD y
      // `Content-Length`, que sí es legible siempre.
      return (
        `HTTP ${res.status}\n` +
        `Content-Range: ${range ?? '(no expuesta por CORS, se usa HEAD)'}\n` +
        `Content-Length: ${len ?? '?'}`
      );
    },
  },
  {
    name: '2. La cabecera de SQLite es la correcta',
    run: async () => {
      const res = await fetch(SNAPSHOT_URL, { headers: { Range: 'bytes=0-99' } });
      const buf = new Uint8Array(await res.arrayBuffer());
      const magic = new TextDecoder().decode(buf.subarray(0, 15));
      if (magic !== 'SQLite format 3') throw new Error(`Cabecera inesperada: "${magic}"`);
      // El page_size vive en los bytes 16-17, big-endian.
      const pageSize = (buf[16]! << 8) | buf[17]!;
      return `magic: "${magic}"\npage_size: ${pageSize === 1 ? 65536 : pageSize} B`;
    },
  },
  {
    name: '3. El Worker abre la base remota',
    run: async () => {
      const t0 = performance.now();
      await source.init();
      return `Base abierta en ${Math.round(performance.now() - t0)} ms`;
    },
  },
  {
    name: '4. Consulta por código de barras (clave primaria)',
    run: async () => {
      // El código se toma de la propia base en vez de cablearlo: así la
      // comprobación sigue valiendo cuando cambia el catálogo publicado.
      const muestra = await source.search('a', 1);
      const codigo = muestra[0]?.barcode;
      if (!codigo) throw new Error('El catálogo no devolvió ningún producto de muestra');
      const t0 = performance.now();
      const product = await source.getProduct(codigo);
      const ms = Math.round(performance.now() - t0);
      if (!product) throw new Error(`No se encontró el producto ${codigo}`);
      return `${product.name}\nmarca: ${product.brands?.join(', ') || '—'}\nNutri-Score: ${
        product.offNutriscoreGrade?.toUpperCase() ?? '—'
      }\naditivos: ${product.additiveTags.length}\nen ${ms} ms`;
    },
  },
  {
    name: '5. Búsqueda por texto (índice FTS5)',
    run: async () => {
      const t0 = performance.now();
      const results = await source.search('leche', 5);
      const ms = Math.round(performance.now() - t0);
      return `${results.length} resultados en ${ms} ms\n` +
        results.map((r) => `  · ${r.name}`).join('\n');
    },
  },
  {
    name: '6. DOS catálogos abiertos a la vez (un solo Worker)',
    run: async () => {
      // Es la comprobación clave de la Fase 1: antes el VFS tenía un único
      // lector de módulo y el Worker una única conexión, así que abrir el
      // segundo país reemplazaba al primero en silencio.
      const index = await fetch(`${BASE_URL}/index.json`).then((r) => r.json());
      const paises = Object.keys(index.countries ?? {})
        .filter((c) => index.countries[c].bytes < 30 * 1024 * 1024)
        .slice(0, 2);
      if (paises.length < 2) throw new Error('Hacen falta dos catálogos pequeños en el índice');

      const fuentes = paises.map(
        (c) =>
          new SqliteHttpSource({
            source: c,
            url: `${BASE_URL}/${index.countries[c].file}`,
            strategy: 'range',
          }),
      );
      await Promise.all(fuentes.map((f) => f.init()));

      const abiertas = await openSources();
      const muestras = await Promise.all(
        fuentes.map(async (f) => {
          const r = await f.search('a', 1);
          return `${f.source}: ${r[0]?.name ?? '(sin resultados)'}`;
        }),
      );

      // Las dos deben seguir abiertas y devolver datos propios.
      for (const c of paises) {
        if (!abiertas.includes(c)) throw new Error(`La fuente "${c}" no quedó abierta`);
      }
      await Promise.all(fuentes.map((f) => f.close()));
      return (
        `fuentes abiertas a la vez: ${abiertas.join(', ')}\n` +
        muestras.map((m) => `  ${m}`).join('\n')
      );
    },
  },
  {
    name: '7. Eficiencia: bytes transferidos frente al tamaño total',
    run: async () => {
      const stats = await source.stats();
      if (!stats) throw new Error('El lector no devolvió estadísticas');
      const head = await fetch(SNAPSHOT_URL, { method: 'HEAD' });
      const total = Number(head.headers.get('Content-Length') ?? 0);
      const pct = total ? ((stats.bytesTransferred / total) * 100).toFixed(1) : '?';
      return (
        `peticiones Range:   ${stats.requests}\n` +
        `bytes transferidos: ${stats.bytesTransferred.toLocaleString('es')} B\n` +
        `tamaño del archivo: ${total.toLocaleString('es')} B\n` +
        `transferido:        ${pct}% del total\n` +
        `aciertos de caché:  ${stats.cacheHits} (fallos: ${stats.cacheMisses})\n` +
        `desalojos LRU:      ${stats.evictions}`
      );
    },
  },
];

(async () => {
  let passed = 0;
  for (const check of checks) {
    try {
      const detail = await check.run();
      log(check.name, 'ok', detail);
      passed++;
    } catch (err) {
      log(check.name, 'fail', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }
  }
  const summary = document.createElement('div');
  summary.className = passed === checks.length ? 'notice info' : 'notice error';
  summary.textContent = `${passed} de ${checks.length} comprobaciones superadas`;
  out.prepend(summary);
  (window as unknown as { __vfsResult: unknown }).__vfsResult = {
    passed,
    total: checks.length,
  };
})();
