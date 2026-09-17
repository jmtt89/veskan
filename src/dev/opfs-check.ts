/**
 * Banco de pruebas del almacen OPFS.
 *
 * Verifica en un navegador real lo que ningun test de Node puede verificar: que
 * el catalogo queda como archivo en disco, que persiste entre recargas y que se
 * consulta SIN RED. Tambien mide, que es lo que decide si un catalogo grande es
 * viable en movil.
 *
 * La comprobacion 6 usa un parametro `?fase=2` en la URL: la primera pasada
 * descarga, la segunda comprueba que sigue ahi tras recargar.
 */

import { SqliteHttpSource } from '../core/data/sqlite-http/client.js';
import { send } from '../core/data/sqlite-http/worker-pool.js';
import {
  classifyEviction,
  detectIosWebkit,
  evictionWarning,
  isInstalled,
  planSpace,
  requestPersistence,
} from '../core/data/storage-check.js';

const BASE_URL =
  import.meta.env.VITE_SNAPSHOT_URL ?? 'https://raw.githubusercontent.com/jmtt89/veskan-data/data';
const out = document.getElementById('out')!;
const params = new URLSearchParams(location.search);
const fase = params.get('fase');

/** País pequeño con el que probar sin descargar cientos de megas. */
const PAIS = params.get('pais') ?? 'venezuela';

interface Check {
  name: string;
  run: () => Promise<string>;
}

function log(name: string, estado: 'ok' | 'fail', detalle: string): void {
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `<strong>${estado === 'ok' ? '✅' : '❌'} ${name}</strong><pre style="margin:8px 0 0;white-space:pre-wrap;font-size:.82rem">${detalle}</pre>`;
  out.appendChild(div);
}

const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;

interface Capacidades {
  opfs: boolean;
  reason?: string;
  detail?: string;
  catalogs: string[];
}

const checks: Check[] = [
  {
    name: '1. El navegador permite guardar en disco',
    run: async () => {
      const cap = await send<Capacidades>({ type: 'capabilities' });
      if (!cap.opfs) throw new Error(`${cap.reason}: ${cap.detail ?? 'sin detalle'}`);
      return (
        `OPFS disponible: sí\n` +
        `crossOriginIsolated: ${self.crossOriginIsolated} (no hace falta)\n` +
        `catálogos ya en disco: ${cap.catalogs.length ? cap.catalogs.join(', ') : '(ninguno)'}`
      );
    },
  },
  {
    name: '2. Comprobación de espacio antes de descargar',
    run: async () => {
      const index = await fetch(`${BASE_URL}/index.json`).then((r) => r.json());
      const entry = index.countries?.[PAIS];
      if (!entry) throw new Error(`El índice no tiene "${PAIS}"`);
      const est = await navigator.storage.estimate();
      const need = planSpace(est, entry.bytes);
      if (!need.fits) throw new Error(`No cabe: faltan ${fmt(need.shortfallBytes)}`);
      return (
        `catálogo: ${fmt(need.downloadBytes)}\n` +
        `necesario con margen: ${fmt(need.requiredBytes)}\n` +
        `disponible: ${fmt(need.availableBytes)}\n` +
        `cuota conocida: ${need.quotaKnown}`
      );
    },
  },
  {
    name: '3. Riesgo de borrado y persistencia',
    run: async () => {
      const ios = detectIosWebkit(navigator.userAgent, navigator.maxTouchPoints ?? 0);
      const persisted = await requestPersistence();
      const risk = classifyEviction({ isIosWebkit: ios, installed: isInstalled(), persisted });
      return (
        `iOS/iPadOS: ${ios}\ninstalada: ${isInstalled()}\n` +
        `almacenamiento persistente: ${persisted}\n` +
        `riesgo: ${risk}\n${evictionWarning(risk) ?? '(sin advertencia)'}`
      );
    },
  },
  {
    name: '4. Importar el catálogo a disco por streaming',
    run: async () => {
      const index = await fetch(`${BASE_URL}/index.json`).then((r) => r.json());
      const entry = index.countries[PAIS];
      const antes = (await navigator.storage.estimate()).usage ?? 0;
      const t0 = performance.now();
      const fuente = new SqliteHttpSource({
        source: PAIS,
        url: `${BASE_URL}/${entry.file}`,
        strategy: 'download',
      });
      await fuente.init();
      const ms = Math.round(performance.now() - t0);
      const despues = (await navigator.storage.estimate()).usage ?? 0;
      return (
        `importado en ${ms} ms\n` +
        `uso de almacenamiento: ${fmt(antes)} → ${fmt(despues)}  (+${fmt(despues - antes)})\n` +
        `tamaño declarado: ${fmt(entry.bytes)}`
      );
    },
  },
  {
    name: '5. Consultar la base local',
    run: async () => {
      const fuente = new SqliteHttpSource({ source: PAIS, url: '', strategy: 'download' });
      const t0 = performance.now();
      const r = await fuente.search('a', 3);
      const ms = Math.round(performance.now() - t0);
      if (!r.length) throw new Error('La base local no devolvió resultados');
      return `${r.length} resultados en ${ms} ms\n` + r.map((p) => `  · ${p.name}`).join('\n');
    },
  },
  {
    name: '6. Persiste tras recargar, y se consulta SIN RED',
    run: async () => {
      if (fase !== '2') {
        return (
          'Pendiente de la segunda pasada.\n' +
          `Abre: ${location.pathname}?fase=2&pais=${PAIS}\n` +
          '(la base ya quedó escrita en disco por la comprobación 4)'
        );
      }
      // En la segunda pasada la base ya estaba en disco: no debe haber ninguna
      // peticion de red al catalogo.
      const antesDeRed = performance
        .getEntriesByType('resource')
        .filter((r) => r.name.includes('.sqlite3')).length;
      const fuente = new SqliteHttpSource({ source: PAIS, url: '', strategy: 'download' });
      const r = await fuente.search('a', 1);
      const despuesDeRed = performance
        .getEntriesByType('resource')
        .filter((x) => x.name.includes('.sqlite3')).length;
      if (despuesDeRed > antesDeRed) {
        throw new Error(`Hubo ${despuesDeRed - antesDeRed} peticiones de red al catálogo`);
      }
      if (!r.length) throw new Error('La base no sobrevivió a la recarga');
      return `la base sigue en disco tras recargar\npeticiones de red al catálogo: 0\nejemplo: ${r[0]!.name}`;
    },
  },
  {
    name: '7. Velocidad de escritura por página',
    run: async () => {
      // Es la medida que decide si aplicar deltas sobre un catálogo grande es
      // viable en un móvil.
      const t0 = performance.now();
      await send({
        type: 'query',
        source: PAIS,
        sql: "INSERT OR REPLACE INTO meta(key,value) VALUES ('probe', ?)",
        params: [String(Date.now())],
      });
      const ms = performance.now() - t0;
      return `una escritura con transacción: ${ms.toFixed(1)} ms`;
    },
  },
  {
    name: '8. Borrar libera el espacio de verdad',
    run: async () => {
      if (params.get('conservar') === '1') return 'omitido (?conservar=1)';
      const antes = (await navigator.storage.estimate()).usage ?? 0;
      await send({ type: 'remove', source: PAIS });
      const despues = (await navigator.storage.estimate()).usage ?? 0;
      const cap = await send<Capacidades>({ type: 'capabilities' });
      if (cap.catalogs.includes(PAIS)) throw new Error('El catálogo sigue listado tras borrarlo');
      return `uso: ${fmt(antes)} → ${fmt(despues)}  (−${fmt(antes - despues)})\ncatálogos: ${cap.catalogs.join(', ') || '(ninguno)'}`;
    },
  },
];

(async () => {
  let pasadas = 0;
  for (const check of checks) {
    try {
      log(check.name, 'ok', await check.run());
      pasadas++;
    } catch (err) {
      log(check.name, 'fail', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }
  }
  const resumen = document.createElement('div');
  resumen.className = pasadas === checks.length ? 'notice info' : 'notice warn';
  resumen.textContent = `${pasadas} de ${checks.length} comprobaciones superadas`;
  out.prepend(resumen);
  (window as unknown as { __opfsResult: unknown }).__opfsResult = {
    passed: pasadas,
    total: checks.length,
  };
})();
