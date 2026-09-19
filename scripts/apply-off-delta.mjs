/**
 * Construye la generacion nueva aplicando los deltas diarios de Open Food Facts
 * sobre la anterior, en vez de reprocesar el volcado completo.
 *
 *   node scripts/apply-off-delta.mjs --prev=prev --out-dir=out --countries=...
 *
 * Por que: la reconstruccion nocturna descarga 12 GB y recorre 4,75 millones de
 * productos para encontrar los ~7.000 que cambiaron ese dia. Los deltas de Open
 * Food Facts traen justo esos, en 26 MB.
 *
 * Se descartaron en su dia por una medicion mia equivocada: mire `nutriments` y
 * lo vi vacio en el 100% de los casos. El dato estaba en
 * `nutrition.aggregated_set`, igual que en el volcado completo. Medido sobre un
 * delta real: 0,0% con `nutriments._100g` y 72,9% con `aggregated_set`.
 *
 * DOS LIMITES, los dos documentados por Open Food Facts, y por eso esto NO
 * sustituye a la reconstruccion completa sino que se alterna con ella:
 *
 *   - «Delta files cannot tell you about deleted products». Un producto que
 *     deja de tener el tag de un pais SI se detecta -llega en el delta con sus
 *     `countries_tags` nuevos- pero una baja real en Open Food Facts, no. Solo
 *     la reconstruccion completa las recoge.
 *   - Solo hay 13 dias de historico. Si la nocturna falla mas de trece dias
 *     seguidos, hay que volver al volcado.
 *
 * Datos de Open Food Facts bajo licencia ODbL. Lo derivado hereda ODbL.
 */

import Database from 'better-sqlite3';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COLUMNS, versionFromBuiltAt } from './lib/schema.mjs';
import { mapProduct } from './build-db.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const ROOT = process.cwd();
const PREV = resolve(ROOT, args.prev ?? 'prev');
const OUT = resolve(ROOT, args['out-dir'] ?? 'out');
const BASE = args.base ?? 'https://static.openfoodfacts.org/data/delta';
const UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)';
const COUNTRIES = new Set(
  (args.countries ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);

const log = (...x) => console.log(...x);

/**
 * Ficheros del histórico que hacen falta.
 *
 * Se llaman `openfoodfacts_products_<desde>_<hasta>.json.gz`, con marcas de
 * tiempo Unix. Se toman los que terminan DESPUES de la generacion anterior, en
 * orden cronologico: aplicarlos al reves dejaria el valor viejo encima.
 */
async function ficherosPendientes(desdeSegundos) {
  const res = await fetch(`${BASE}/index.txt`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`indice de deltas: HTTP ${res.status}`);
  const lineas = (await res.text()).split('\n').map((l) => l.trim()).filter(Boolean);

  const conRango = lineas
    .map((f) => {
      const m = /_(\d+)_(\d+)\.json\.gz$/.exec(f);
      return m ? { f, desde: Number(m[1]), hasta: Number(m[2]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.hasta - b.hasta);

  if (!conRango.length) throw new Error('el indice de deltas no trae ningun fichero reconocible');

  const masViejo = Math.min(...conRango.map((x) => x.desde));
  if (desdeSegundos < masViejo) {
    throw new Error(
      `la generacion anterior es de ${new Date(desdeSegundos * 1000).toISOString()}, ` +
        `anterior al historico disponible (${new Date(masViejo * 1000).toISOString()}). ` +
        'Hay que reconstruir desde el volcado completo.',
    );
  }
  return conRango.filter((x) => x.hasta > desdeSegundos);
}

/** Abre las partes de un pais y deja resuelto a cual va cada codigo de barras. */
function abrirPais(pais, entrada) {
  const partes = (entrada.parts ?? [{ file: `${pais}.sqlite3`, from: null, to: null }]).map((p) => {
    const destino = resolve(OUT, p.file);
    // Se trabaja sobre una COPIA: si algo falla a medias, la generacion
    // anterior sigue intacta y se puede repetir.
    copyFileSync(resolve(PREV, p.file), destino);
    const db = new Database(destino);
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    return {
      ...p,
      db,
      upsert: db.prepare(
        `INSERT OR REPLACE INTO products (${COLUMNS.join(',')}) ` +
          `VALUES (${COLUMNS.map(() => '?').join(',')})`,
      ),
      borrar: db.prepare('DELETE FROM products WHERE barcode = ?'),
      ftsBorrar: db.prepare('DELETE FROM products_fts WHERE barcode = ?'),
      ftsInsertar: db.prepare('INSERT INTO products_fts (barcode, name, brands) VALUES (?,?,?)'),
    };
  });

  /**
   * Parte que le toca a un codigo. La comparacion es de CADENAS porque es asi
   * como ordena SQLite y como se calcularon los cortes; convertir a numero
   * daria otro orden y el producto caeria en la parte equivocada.
   */
  const parteDe = (code) =>
    partes.find((p) => (p.from === null || code >= p.from) && (p.to === null || code < p.to)) ??
    partes[partes.length - 1];

  return { partes, parteDe };
}

async function main() {
  if (!existsSync(resolve(PREV, 'index.json'))) {
    throw new Error(`no hay generacion anterior en ${PREV}: hace falta el volcado completo`);
  }
  const indice = JSON.parse(readFileSync(resolve(PREV, 'index.json'), 'utf8'));
  mkdirSync(OUT, { recursive: true });

  const desde = Math.floor(new Date(indice.generated_at).getTime() / 1000);
  log(`Generacion anterior: ${indice.generated_at}`);

  const pendientes = await ficherosPendientes(desde);
  if (!pendientes.length) {
    log('No hay deltas nuevos. Nada que hacer.');
    return;
  }
  log(`${pendientes.length} delta(s) por aplicar:`);
  for (const x of pendientes) log(`  ${x.f}`);

  const paises = Object.keys(indice.countries).filter((c) => !COUNTRIES.size || COUNTRIES.has(c));
  const abiertos = Object.fromEntries(paises.map((c) => [c, abrirPais(c, indice.countries[c])]));
  log(`\nPaises: ${paises.join(', ')}`);

  const cuenta = { leidos: 0, altas: 0, bajas: 0 };
  const t0 = Date.now();

  for (const { f } of pendientes) {
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/${f}`, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    const rl = createInterface({
      input: Readable.fromWeb(res.body).pipe(createGunzip()),
      crlfDelay: Infinity,
    });

    // Las escrituras van por transaccion y por fichero: en SQLite el coste esta
    // en la transaccion, no en la fila.
    const pendientesEscribir = [];
    try {
      for await (const linea of rl) {
        if (!linea) continue;
        let p;
        try { p = JSON.parse(linea); } catch { continue; }
        cuenta.leidos++;
        const code = p.code ? String(p.code) : null;
        if (!code) continue;

        const suyos = new Set((p.countries_tags ?? []).map((c) => String(c).replace(/^en:/, '')));
        const fila = mapProduct(p);

        for (const pais of paises) {
          pendientesEscribir.push({ pais, code, fila: suyos.has(pais) ? fila : null });
        }
      }
    } finally {
      rl.close();
      try { ctrl.abort(); } catch { /* el flujo ya acabo */ }
    }

    for (const pais of paises) {
      const { parteDe } = abiertos[pais];
      const mias = pendientesEscribir.filter((x) => x.pais === pais);
      if (!mias.length) continue;
      const porParte = new Map();
      for (const x of mias) {
        const parte = parteDe(x.code);
        if (!porParte.has(parte)) porParte.set(parte, []);
        porParte.get(parte).push(x);
      }
      for (const [parte, xs] of porParte) {
        parte.db.transaction(() => {
          for (const { code, fila } of xs) {
            // El indice de texto se rehace siempre: si el nombre cambio y no se
            // tocara, la busqueda seguiria devolviendo el anterior.
            parte.ftsBorrar.run(code);
            if (fila) {
              parte.upsert.run(COLUMNS.map((c) => fila[c] ?? null));
              parte.ftsInsertar.run(code, fila.name ?? '', fila.brands ?? '');
              cuenta.altas++;
            } else {
              const r = parte.borrar.run(code);
              if (r.changes) cuenta.bajas++;
            }
          }
        })();
      }
    }
    log(`  ${f}: aplicado`);
  }

  // Cierre: version nueva, compactar y reescribir el indice.
  const builtAt = new Date().toISOString();
  const version = versionFromBuiltAt(builtAt);
  const salida = { ...indice, generated_at: builtAt, countries: {} };

  for (const pais of paises) {
    const { partes } = abiertos[pais];
    const nuevas = [];
    for (const parte of partes) {
      const meta = parte.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)');
      meta.run('built_at', builtAt);
      meta.run('version', version);
      parte.db.exec('VACUUM');
      parte.db.exec('ANALYZE');
      const n = parte.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
      parte.db.close();
      const bytes = statSync(resolve(OUT, parte.file)).size;
      nuevas.push({ file: parte.file, from: parte.from, to: parte.to, products: n, bytes });
    }
    const total = nuevas.reduce((t, x) => t + x.products, 0);
    salida.countries[pais] = {
      ...(nuevas.length === 1 ? { file: nuevas[0].file } : {}),
      products: total,
      bytes: nuevas.reduce((t, x) => t + x.bytes, 0),
      version,
      parts: nuevas,
    };
    log(`  ${pais.padEnd(16)} ${total.toLocaleString('es').padStart(9)} productos en ${nuevas.length} parte(s)`);
  }

  writeFileSync(resolve(OUT, 'index.json'), JSON.stringify(salida, null, 2));
  log(
    `\nAplicados ${pendientes.length} delta(s) en ${((Date.now() - t0) / 60000).toFixed(1)} min: ` +
      `${cuenta.leidos.toLocaleString('es')} productos leidos, ` +
      `${cuenta.altas.toLocaleString('es')} altas/cambios, ${cuenta.bajas.toLocaleString('es')} bajas.`,
  );
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
