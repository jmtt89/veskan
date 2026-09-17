/**
 * Banco de pruebas del VFS de SQLite sobre HTTP Range.
 *
 * No es codigo desechable: es la unica forma de verificar en un navegador real
 * lo que ningun test de Node puede comprobar (XHR sincrono en Worker, Range,
 * CORS y la interaccion con el Service Worker). Se sirve como entrada aparte,
 * fuera del bundle de la aplicacion.
 */

import { SqliteHttpSource } from '../core/data/sqlite-http/client.js';

const SNAPSHOT_URL = import.meta.env.VITE_SNAPSHOT_URL ?? 'http://localhost:8787/snapshot.sqlite3';
const out = document.getElementById('out')!;

interface Check {
  name: string;
  run: () => Promise<string>;
}

const source = new SqliteHttpSource({ url: SNAPSHOT_URL });

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
      const range = res.headers.get('Content-Range');
      if (res.status !== 206) throw new Error(`Se esperaba 206 y llegó ${res.status}`);
      if (!range) throw new Error('Falta la cabecera Content-Range (¿expuesta por CORS?)');
      return `HTTP ${res.status}\nContent-Range: ${range}`;
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
      const t0 = performance.now();
      const product = await source.getProduct('0013000001243');
      const ms = Math.round(performance.now() - t0);
      if (!product) throw new Error('No se encontró el producto de prueba');
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
    name: '6. Eficiencia: bytes transferidos frente al tamaño total',
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
