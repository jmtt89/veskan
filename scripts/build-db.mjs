/**
 * Construye el snapshot SQLite estatico (capa L1).
 *
 * Dos modos:
 *   --mode=api   (por defecto) arma un snapshot desde la API de OFF. Rapido, no
 *                exige descargar los 9 GB del volcado completo. Ideal para
 *                desarrollo y para el primer despliegue.
 *   --mode=dump  procesa `openfoodfacts-products.jsonl.gz`. Para el snapshot de
 *                produccion con cientos de miles de productos.
 *
 * El archivo resultante se sirve desde un host que soporte HTTP 206
 * (jsDelivr, raw.githubusercontent, Cloudflare R2) y se consulta por rangos:
 * el navegador descarga solo las paginas que toca cada consulta, no la base.
 *
 * Datos de Open Food Facts bajo licencia ODbL. El snapshot derivado hereda ODbL.
 */

import Database from 'better-sqlite3';
import {
  COLUMNS,
  FTS_SCHEMA,
  PAGE_SIZE,
  SCHEMA,
  versionFromBuiltAt,
} from './lib/schema.mjs';
import { leerNutrientes } from './lib/nutrients.mjs';
import { ingredientesDe, nombreDe } from './lib/nombres.mjs';
import { banderasDe } from './lib/categorias.mjs';
import { tipoDeBebida } from './lib/bebidas.mjs';
import { createReadStream, mkdirSync, readFileSync, statSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Las rutas se resuelven contra el DIRECTORIO DE TRABAJO, no contra la
 * ubicacion del script. Antes se usaba la carpeta del propio archivo, lo que
 * ataba el script a vivir en la raiz de su repositorio: el repositorio de datos
 * lo ejecuta desde un checkout aparte, y las salidas habrian caido dentro de
 * ese checkout en vez de donde se lanza la construccion.
 */
const ROOT = process.cwd();
// Identificacion ante Open Food Facts. No es autenticacion ni lleva datos
// personales: solo el nombre del proyecto y una URL publica de contacto.
const UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const MODE = args.mode ?? 'api';
const OUT = resolve(ROOT, args.out ?? 'data/snapshot.sqlite3');
const COUNTRIES = (args.countries ?? 'spain,mexico,colombia,venezuela,argentina,chile,peru')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PER_COUNTRY = Number(args.limit ?? 300);

/**
 * Recuento de que peldano de la escalera resolvio cada nutriente. Sirve para
 * medir la cobertura real en vez de suponerla: si un peldano no aporta nada,
 * sobra; si aporta mucho, hay que cuidarlo.
 */
const ORIGENES = {
  por_origen: new Map(),
  con_energia: 0,
  sin_energia: 0,
  declarado_sin_datos: 0,
  imposibles: 0,
  productos_con_imposibles: 0,
  anotar(origenes, sinDatos, imposibles = []) {
    if (imposibles.length) {
      this.productos_con_imposibles += 1;
      this.imposibles += imposibles.length;
    }
    for (const o of Object.values(origenes)) {
      this.por_origen.set(o, (this.por_origen.get(o) ?? 0) + 1);
    }
    if (origenes.energy_kj) this.con_energia += 1;
    else this.sin_energia += 1;
    if (sinDatos) this.declarado_sin_datos += 1;
  },
  resumen() {
    const total = this.con_energia + this.sin_energia;
    if (!total) return '';
    const pct = (x) => `${((x / total) * 100).toFixed(1)}%`;
    const filas = [...this.por_origen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([o, n]) => `      ${o.padEnd(20)} ${String(n).padStart(9)}`)
      .join('\n');
    return (
      `  nutrientes: ${this.con_energia}/${total} con energia (${pct(this.con_energia)})` +
      `, ${this.declarado_sin_datos} declaran no_nutrition_data\n` +
      `    valores imposibles conservados: ${this.imposibles} en ${this.productos_con_imposibles} productos\n` +
      `    resueltos por peldano:\n${filas}`
    );
  },
};

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const list = (v) => (Array.isArray(v) && v.length ? v.join(',') : null);
const truthy = (v) => (v === 1 || v === '1' || v === true ? 1 : 0);

/** Volumen en ml, respetando la unidad declarada si la hay. */
function volumenMl(p) {
  const v = num(p.product_quantity);
  if (v === null || v <= 0) return null;
  const u = String(p.product_quantity_unit ?? '').trim().toLowerCase();
  if (u === 'l' || u === 'kg') return v * 1000;
  if (u === 'cl') return v * 10;
  if (u === 'dl') return v * 100;
  return v;   // ml o g
}

/**
 * Traduce un producto de Open Food Facts a nuestra fila.
 *
 * Se exporta para que `apply-off-delta.mjs` use EXACTAMENTE el mismo mapeo: si
 * la reconstruccion nocturna tradujera distinto que la semanal, los catalogos
 * irian divergiendo un poco cada dia sin que nada fallara.
 */
export function mapProduct(p) {
  const nd = p.nutriscore_data ?? {};
  // Los `_100g` son campos CALCULADOS y en el volcado faltan a menudo; la
  // escalera de lib/nutrients.mjs cae a los campos de origen. Ver alli el
  // porque, citando el esquema oficial.
  const { valores, origenes, sinDatos, imposibles, estimados } = leerNutrientes(p);
  const banderas = banderasDe(p);
  ORIGENES.anotar(origenes, sinDatos, imposibles);
  // Sin idioma fijo: el catalogo lo consume gente de cualquier pais, y
  // preferir uno descartaba productos que solo tienen el nombre en el suyo.
  const name = nombreDe(p);
  if (!p.code || !name) return null; // sin nombre el registro no sirve al usuario

  return {
    barcode: String(p.code),
    name,
    brands: p.brands ?? null,
    quantity: p.quantity ?? null,
    image_url: p.image_front_small_url ?? p.image_front_url ?? null,
    ingredients_text: ingredientesDe(p),
    additives: list(p.additives_tags),
    allergens: list(p.allergens_tags),
    labels: list(p.labels_tags),
    nova_group: num(p.nova_group),
    nutriscore_grade: nd.grade ?? p.nutriscore_grade ?? null,
    nutriscore_score: num(nd.score),
    energy_kj: valores.energy_kj,
    energy_kcal: valores.energy_kcal,
    fat: valores.fat,
    saturated_fat: valores.saturated_fat,
    trans_fat: valores.trans_fat,
    carbohydrates: valores.carbohydrates,
    sugars: valores.sugars,
    fiber: valores.fiber,
    proteins: valores.proteins,
    salt: valores.salt,
    // la columna `sodium` va en mg; la escalera devuelve gramos
    sodium: valores.sodium === null ? null : valores.sodium * 1000,
    fvl: valores.fvl,
    alcohol: valores.alcohol,
    // Volumen del envase en ml. `product_quantity` viene en gramos; para una
    // bebida se toma 1 g = 1 ml, que es la densidad del agua y el error frente
    // al alcohol o el azucar disuelto es menor que el de la propia declaracion.
    quantity_ml: volumenMl(p),
    drink_type: valores.alcohol !== null && valores.alcohol > 1.2 ? tipoDeBebida(p.categories_tags) : null,
    // Las banderas se resuelven en lib/categorias.mjs, compartido con la
    // aplicacion: leian de sitios distintos y el mismo producto podia puntuar
    // diferente segun viniera del catalogo o de la API.
    // NULL cuando no se pudieron resolver: no es lo mismo "no es una bebida"
    // que "no sabemos si lo es".
    is_beverage: banderas.origen === null ? null : banderas.isBeverage ? 1 : 0,
    is_water: banderas.origen === null ? null : banderas.isWater ? 1 : 0,
    is_cheese: banderas.origen === null ? null : banderas.isCheese ? 1 : 0,
    is_fat_oil_nuts_seeds: banderas.origen === null ? null : banderas.isFatOilNutsSeeds ? 1 : 0,
    is_red_meat: banderas.origen === null ? null : banderas.isRedMeat ? 1 : 0,
    // JSON compacto, y null cuando no hay nada: es la inmensa mayoria de filas.
    implausible: imposibles.length
      ? JSON.stringify(
          imposibles.map((x) => ({
            n: x.nutriente,
            v: Number(x.valor.toFixed(2)),
            u: x.unidad,
            m: x.motivo === 'racion-incoherente' ? 'racion' : 'max',
            ...(x.sustituido ? { s: x.sustituido } : {}),
          })),
        )
      : null,
    estimados: Object.keys(estimados).length
      ? Object.entries(estimados).map(([k, v]) => `${k}:${v}`).join(',')
      : null,
    last_modified: p.last_modified_t ? p.last_modified_t * 1000 : null,
    popularity: num(p.popularity_key) ?? 0,
  };
}

const API_FIELDS = [
  'code','product_name','generic_name','brands','quantity','lang',
  'image_front_small_url','image_front_url','ingredients_text',
  'additives_tags','allergens_tags','categories_tags','countries_tags',
  'nutriments','nutriscore_data','nutriscore_grade','nova_group','last_modified_t','popularity_key',
  // Campos de ORIGEN de los nutrientes. Sin ellos no se pueden leer los
  // productos cuyos `_100g` -que son calculados- no vienen en la respuesta.
  'nutrition_data_per','serving_quantity','no_nutrition_data',
  'labels_tags','product_quantity_unit',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Limitador de ritmo por ventana deslizante.
 *
 * Open Food Facts permite 10 busquedas por minuto y por IP. Esperar un intervalo
 * fijo entre peticiones no basta: los REINTENTOS tambien consumen cupo, asi que
 * un fallo arrastra al siguiente y el efecto se acumula hasta que los ultimos
 * paises se quedan sin nada. (Ocurrio: Venezuela, Colombia y Chile terminaron
 * con 0 productos.)
 *
 * Esto cuenta las peticiones REALES de la ultima ventana y espera lo necesario
 * antes de cada una, reintentos incluidos.
 */
class RateLimiter {
  constructor(maxPerWindow = 8, windowMs = 60_000) {
    this.max = maxPerWindow;
    this.windowMs = windowMs;
    this.calls = [];
  }

  async acquire() {
    for (;;) {
      const now = Date.now();
      this.calls = this.calls.filter((t) => now - t < this.windowMs);
      if (this.calls.length < this.max) {
        this.calls.push(now);
        return;
      }
      const wait = this.windowMs - (now - this.calls[0]) + 500;
      process.stdout.write(`\r  (limite de peticiones: esperando ${Math.ceil(wait / 1000)}s)      `);
      await sleep(wait);
    }
  }
}

// 8 de 10 permitidas: se deja holgura deliberada para no rozar el limite.
const limiter = new RateLimiter(8, 60_000);

async function collectFromApi() {
  const out = [];
  const seen = new Set();
  for (const country of COUNTRIES) {
    let collected = 0;
    for (let page = 1; collected < PER_COUNTRY; page++) {
      const url =
        `https://world.openfoodfacts.org/api/v2/search?countries_tags_en=${country}` +
        `&fields=${API_FIELDS}&page_size=100&page=${page}&sort_by=popularity_key`;
      let data;
      for (let attempt = 0; attempt < 6; attempt++) {
        await limiter.acquire();
        try {
          const res = await fetch(url, { headers: { 'User-Agent': UA } });
          if (res.status === 503 || res.status === 429) throw new Error(`HTTP ${res.status}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = await res.json();
          break;
        } catch (e) {
          // Retroceso exponencial: 20s, 40s, 80s... Un 503 significa que el
          // servidor ya esta saturado; insistir enseguida solo lo empeora.
          const backoff = 20000 * 2 ** attempt;
          process.stdout.write(
            `\r  ${country}: reintento ${attempt + 1}/6 tras ${backoff / 1000}s (${e.message})     `,
          );
          await sleep(backoff);
        }
      }
      if (!data) {
        console.log(`\n  AVISO: ${country} no respondio tras 6 intentos. Se continua sin sus datos.`);
        break;
      }
      if (!data?.products?.length) break;
      for (const p of data.products) {
        const mapped = mapProduct(p);
        if (!mapped) continue;
        // Un mismo producto puede aparecer en varios paises. Se registra en
        // cada uno, porque en modo --split cada pais tiene su propia base y no
        // son particiones de una sola.
        const key = `${country}:${p.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ row: mapped, country });
        collected++;
      }
      process.stdout.write(`\r  ${country}: ${collected} productos            `);
      if (data.products.length < 100) break;
    }
    process.stdout.write(`\r  ${country}: ${collected} productos            \n`);
  }
  return out;
}

/**
 * Lee el volcado linea a linea, desde un archivo o desde la entrada estandar.
 *
 * La opcion `--stdin` existe por una razon concreta: el volcado JSONL de Open
 * Food Facts pesa **12 GB comprimidos** (no 0,9 GB, que es el del CSV), y un
 * runner de GitHub Actions trae unos 14 GB libres. Guardarlo en disco antes de
 * procesarlo dejaria la maquina al borde y el workflow fallaria de forma
 * intermitente. Transmitiendolo no se almacena nada:
 *
 *   curl -fL <url> | node scripts/build-db.mjs --mode=dump --stdin
 */
async function* readDump(path) {
  const source = path === '-' ? process.stdin : createReadStream(path);
  const rl = createInterface({
    input: source.pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* linea corrupta: se ignora */
    }
  }
}

/** Crea una base vacia con el esquema completo. */
function createDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) unlinkSync(path);
  const db = new Database(path);
  db.exec(SCHEMA);
  db.exec(FTS_SCHEMA);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO products (${COLUMNS.join(',')})
     VALUES (${COLUMNS.map((c) => '@' + c).join(',')})`,
  );
  const insertFts = db.prepare(
    'INSERT INTO products_fts (barcode, name, brands) VALUES (@barcode, @name, @brands)',
  );
  return {
    db,
    path,
    count: 0,
    pending: [],
    // Una transaccion por lote: sin esto habria un fsync por fila.
    flushBatch: db.transaction((rows) => {
      for (const r of rows) {
        insert.run(r);
        insertFts.run({ barcode: r.barcode, name: r.name, brands: r.brands ?? '' });
      }
    }),
  };
}

function finalizeDb(target, maxProducts) {
  /**
   * Recorte por popularidad.
   *
   * Paises como Estados Unidos tienen ~970.000 productos en Open Food Facts,
   * que a 250 B cada uno son 231 MB: por encima del limite de 100 MB por
   * archivo de GitHub. En lugar de partir el archivo (lo que romperia la
   * consulta por rangos, que necesita una sola base), se conservan los mas
   * escaneados.
   *
   * El recorte se hace en SQL y no en memoria a proposito: cargar un millon de
   * objetos en Node para ordenarlos consumiria varios GB en un runner que solo
   * tiene 7.
   */
  if (maxProducts) {
    const before = target.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
    if (before > maxProducts) {
      target.db.exec(`
        DELETE FROM products WHERE barcode NOT IN (
          SELECT barcode FROM products ORDER BY popularity DESC, barcode ASC LIMIT ${maxProducts}
        );
        DELETE FROM products_fts WHERE barcode NOT IN (SELECT barcode FROM products);
      `);
      const after = target.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
      console.log(`  ${target.country ?? 'snapshot'}: recortado de ${before.toLocaleString('es')} a ${after.toLocaleString('es')} por popularidad`);
    }
  }

  /**
   * Deduplicar el indice de texto.
   *
   * `products` deduplica sola porque `barcode` es su clave primaria y se
   * inserta con INSERT OR REPLACE. `products_fts` no tiene clave: un producto
   * repetido en el volcado entra dos veces y sale dos veces en las busquedas.
   * Medido sobre el shard de Espana publicado: 339.576 entradas de indice para
   * 339.562 productos, 14 duplicados.
   *
   * Se conserva el rowid mayor, que es la ultima insercion y por tanto la que
   * se corresponde con la fila que quedo en `products`.
   */
  target.db.exec(`
    DELETE FROM products_fts
    WHERE rowid NOT IN (SELECT MAX(rowid) FROM products_fts GROUP BY barcode);
  `);

  const meta = target.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const builtAt = new Date().toISOString();
  meta.run('built_at', builtAt);
  // Eslabon de la cadena de deltas: el cliente compara SU version con la del
  // indice para saber si le basta con un delta o tiene que bajarlo todo.
  meta.run('version', versionFromBuiltAt(builtAt));
  meta.run('source', 'Open Food Facts (ODbL)');
  meta.run('license', 'ODbL-1.0');
  meta.run('page_size', String(PAGE_SIZE));
  if (target.country) meta.run('country', target.country);
  // VACUUM compacta y deja las paginas contiguas: menos peticiones por consulta.
  target.db.exec('VACUUM');
  target.db.exec('ANALYZE');
  const n = target.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  target.db.close();
  return {
    path: target.path,
    count: n,
    bytes: statSync(target.path).size,
    country: target.country,
    version: versionFromBuiltAt(builtAt),
  };
}

/**
 * Limite por archivo.
 *
 * GitHub rechaza cualquier archivo de mas de 100 MB en el push, asi que un
 * catalogo que lo supere no es "grande": es impublicable.
 *
 * El valor por defecto son 92 MB, por debajo del limite DURO de GitHub, que son
 * 100 MB por archivo. Pero GitHub avisa mucho antes:
 *
 *   remote: warning: File united-states-01.sqlite3 is 84.25 MB; this is larger
 *   than GitHub's recommended maximum file size of 50.00 MB
 *
 * Por eso el workflow lo baja a 45 MB. Partir es caro para el usuario -obliga a
 * bajarse ese pais otra vez, porque las filas cambian de archivo y los deltas
 * dejan de encadenar- asi que no se parte por gusto; pero publicar archivos que
 * el propio alojamiento desaconseja tampoco sale gratis.
 *
 * Se puede bajar con `--max-part-mb=N`. Era una constante en el codigo, y el
 * workflow llegaba a decir "edita build-db.mjs" cuando un pais no cabia: un
 * parametro de operacion no deberia exigir tocar el algoritmo.
 */
const MAX_PART_BYTES = Number(args['max-part-mb'] ?? 92) * 1024 * 1024;

/**
 * Parte un catalogo en varios SQLite, cada uno completo y funcional.
 *
 * Se divide por RANGO DE CODIGO DE BARRAS y no por popularidad ni por
 * categoria: es lo unico que permite al cliente saber en que archivo buscar sin
 * consultarlos todos, que es justo la operacion que hace a cada escaneo.
 *
 * Los limites se comparan como CADENAS, no como numeros, porque es asi como
 * ordena e indexa SQLite. Rellenar con ceros para compararlos como enteros
 * daria un orden distinto del que tiene la tabla y los rangos no cuadrarian.
 *
 * Si se pasan limites previos se reutilizan tal cual. Es deliberado: recalcular
 * los cortes cada noche movería filas de un archivo a otro, y entonces el delta
 * diario dejaria de ser un diff de filas y habria que tratar las mudanzas. Los
 * cortes se congelan y solo se rehacen cuando una parte se sale de tamano, que
 * es un evento raro y que ya obliga a descargar de nuevo.
 */
function splitDb(sourcePath, country, outDir, previousBounds) {
  const src = new Database(sourcePath, { readonly: true });
  const total = src.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  const bytes = statSync(sourcePath).size;

  /**
   * Peso estimado de cada fila. Se calcula SIEMPRE, no solo al elegir cortes
   * nuevos, porque tambien hace falta para comprobar si los cortes anteriores
   * siguen valiendo.
   */
  const TEXTO = [
    'name', 'brands', 'quantity', 'image_url', 'ingredients_text',
    'additives', 'allergens', 'labels', 'nutriscore_grade', 'implausible',
    'estimados', 'drink_type',
  ];
  const BYTES_FIJOS = 120;
  const pesoSql = TEXTO.map((c) => `length(coalesce(${c},''))`).join(' + ');
  const filas = src
    .prepare(`SELECT barcode, ${pesoSql} + ${BYTES_FIJOS} AS peso FROM products ORDER BY barcode`)
    .all();
  const totalPeso = filas.reduce((t, f) => t + f.peso, 0);
  /** Bytes reales por unidad de peso estimado, para traducir una cosa en la otra. */
  const bytesPorPeso = totalPeso > 0 ? bytes / totalPeso : 0;

  /** Peso de cada tramo que definen unos cortes dados. */
  const pesoDeTramos = (cortes) => {
    const pesos = new Array(cortes.length + 1).fill(0);
    let i = 0;
    for (const f of filas) {
      while (i < cortes.length && f.barcode >= cortes[i]) i++;
      pesos[i] += f.peso;
    }
    return pesos;
  };

  let bounds = previousBounds;

  /**
   * Los cortes se congelan a proposito -moverlos cambia de archivo las filas y
   * rompe las cadenas de deltas- pero no pueden ser INTOCABLES: al bajar el
   * limite de 92 a 45 MB, Espana habria seguido publicando sus dos partes de
   * 51,5 MB, las dos por encima del nuevo maximo, sin que nada avisara.
   *
   * Se comprueba antes de escribir nada, porque partir borra el archivo de
   * origen y no se puede reintentar despues.
   */
  if (bounds && bounds.length) {
    const mayor = Math.max(...pesoDeTramos(bounds)) * bytesPorPeso;
    if (mayor > MAX_PART_BYTES) {
      console.log(
        `  ${country}: los cortes anteriores dejarian una parte de ` +
          `${(mayor / 1048576).toFixed(0)} MB, por encima del limite. Se recalculan.`,
      );
      bounds = [];
    }
  }

  if (!bounds || bounds.length === 0) {
    const nParts = Math.max(2, Math.ceil(bytes / MAX_PART_BYTES));

    /**
     * Los cortes se eligen por PESO, no por numero de productos.
     *
     * Repartir a partes iguales de filas daba trozos muy desiguales, porque una
     * fila con la lista de ingredientes entera pesa varias veces lo que una que
     * solo tiene nombre: Estados Unidos salia 74,1 MB contra 53,5 MB. Y lo que
     * importa no es el promedio sino el trozo MAYOR, que es el que puede pasarse
     * de los 100 MB por archivo de GitHub. Con partes desiguales hay que trocear
     * mas de la cuenta para que quepa el mas gordo.
     *
     * El peso se estima sumando la longitud de las columnas de texto mas una
     * constante por las numericas. No es exacto -falta la sobrecarga de pagina y
     * el indice FTS- pero es proporcional, que es lo unico que hace falta para
     * repartir, y se calcula en una sola pasada.
     */
    const objetivo = totalPeso / nParts;
    bounds = [];
    let acumulado = 0;
    let siguiente = 1;
    for (const f of filas) {
      if (siguiente >= nParts) break;
      acumulado += f.peso;
      if (acumulado >= objetivo * siguiente) {
        bounds.push(f.barcode);
        siguiente++;
      }
    }
    console.log(
      `  ${country}: ${(bytes / 1048576).toFixed(0)} MB y ${total.toLocaleString('es')} productos,` +
        ` se parte en ${nParts} por peso`,
    );
  } else {
    console.log(`  ${country}: se reutilizan los ${bounds.length + 1} cortes anteriores`);
  }

  const meta = src.prepare('SELECT key, value FROM meta').all();
  src.close();

  // Rangos [desde, hasta): el primero sin limite inferior, el ultimo sin superior.
  const rangos = [];
  for (let i = 0; i <= bounds.length; i++) {
    rangos.push({ from: i === 0 ? null : bounds[i - 1], to: i === bounds.length ? null : bounds[i] });
  }

  const parts = [];
  for (const [i, rango] of rangos.entries()) {
    const nombre = `${country}-${String(i + 1).padStart(2, '0')}.sqlite3`;
    const destino = resolve(outDir, nombre);
    if (existsSync(destino)) unlinkSync(destino);

    const db = new Database(destino);
    db.exec(SCHEMA);
    db.exec(FTS_SCHEMA);
    db.exec(`ATTACH DATABASE '${sourcePath.replace(/'/g, "''")}' AS origen`);

    const cond = [];
    if (rango.from !== null) cond.push(`barcode >= '${rango.from.replace(/'/g, "''")}'`);
    if (rango.to !== null) cond.push(`barcode < '${rango.to.replace(/'/g, "''")}'`);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    db.exec(`INSERT INTO products (${COLUMNS.join(',')})
             SELECT ${COLUMNS.join(',')} FROM origen.products ${where}`);
    // El indice se rehace desde las filas copiadas en vez de copiarlo: asi no
    // se arrastran los duplicados que pudiera tener el original.
    db.exec(`INSERT INTO products_fts (barcode, name, brands)
             SELECT barcode, name, COALESCE(brands, '') FROM products`);

    const escribirMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    for (const m of meta) escribirMeta.run(m.key, m.value);
    escribirMeta.run('part', String(i + 1));
    escribirMeta.run('part_from', rango.from ?? '');
    escribirMeta.run('part_to', rango.to ?? '');

    db.exec('VACUUM');
    db.exec('ANALYZE');
    const n = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
    db.close();

    const tam = statSync(destino).size;
    parts.push({ file: nombre, from: rango.from, to: rango.to, products: n, bytes: tam });
    console.log(
      `    ${nombre.padEnd(28)} ${String(n).padStart(7)} productos  ${(tam / 1048576).toFixed(1).padStart(6)} MB` +
        (tam > 100 * 1024 * 1024 ? '  AVISO: sigue por encima de 100 MB' : ''),
    );
  }

  // El archivo entero ya no se publica: lo sustituyen sus partes.
  unlinkSync(sourcePath);
  return parts;
}

async function main() {
  /**
   * Con `--split`, en lugar de una base con todos los paises se genera UNA POR
   * PAIS, en la misma pasada sobre el volcado.
   *
   * El motivo es de red, no de gusto: un SQLite comprime un 71%, asi que la
   * base entera de Venezuela son 0,3 MB por la red, menos que dos consultas por
   * rangos. Descargarla completa sale mas barato Y funciona sin conexion, que
   * es justo donde mas falta hace. Solo paises grandes como Espana (70 MB
   * comprimidos) siguen necesitando consulta por rangos.
   */
  const split = Boolean(args.split);
  const outDir = resolve(ROOT, args['out-dir'] ?? dirname(OUT));

  /** @type {Map<string, ReturnType<typeof createDb>>} */
  const targets = new Map();
  const targetFor = (country) => {
    if (!split) {
      if (!targets.has('_all')) targets.set('_all', { ...createDb(OUT), country: null });
      return targets.get('_all');
    }
    if (!targets.has(country)) {
      targets.set(country, {
        ...createDb(resolve(outDir, `${country}.sqlite3`)),
        country,
      });
    }
    return targets.get(country);
  };

  /**
   * Escritura por lotes.
   *
   * Sin transaccion, SQLite hace un fsync por fila: con cientos de miles de
   * productos el proceso pasaria de minutos a horas. Se acumula por destino y
   * se vuelca cada BATCH_SIZE filas dentro de una transaccion.
   */
  const BATCH_SIZE = 5000;

  const flush = (t) => {
    if (t.pending.length === 0) return;
    t.flushBatch(t.pending);
    t.pending = [];
  };

  const write = (row, countries) => {
    // En modo split un producto vendido en varios paises va a cada base: son
    // bases independientes, no particiones de una sola.
    const dests = split ? countries : ['_all'];
    for (const c of dests) {
      const t = targetFor(c);
      t.pending.push(row);
      t.count++;
      if (t.pending.length >= BATCH_SIZE) flush(t);
    }
  };

  const flushAll = () => {
    for (const t of targets.values()) flush(t);
  };

  const wanted = new Set(COUNTRIES);

  if (MODE === 'dump') {
    const useStdin = Boolean(args.stdin);
    const dumpPath = useStdin ? '-' : resolve(ROOT, args.dump ?? 'data/openfoodfacts-products.jsonl.gz');
    if (!useStdin && !existsSync(dumpPath)) {
      console.error(`No se encuentra el volcado en ${dumpPath}`);
      console.error('Descargalo con:');
      console.error('  curl -fL https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz \\');
      console.error('    | node scripts/build-db.mjs --mode=dump --stdin');
      process.exit(1);
    }
    console.log(useStdin ? 'Procesando el volcado desde la entrada estandar ...' : `Procesando ${dumpPath} ...`);
    if (split) console.log(`Una base por pais en ${outDir}`);

    const startedAt = Date.now();
    let seen = 0;
    let kept = 0;

    for await (const p of readDump(dumpPath)) {
      seen++;
      const tags = (p.countries_tags ?? []).map((c) => c.replace(/^en:/, ''));
      const matched = tags.filter((c) => wanted.has(c));
      if (matched.length === 0) continue;
      const mapped = mapProduct(p);
      if (!mapped) continue;
      write(mapped, matched);
      kept++;
      if (seen % 50000 === 0) {
        const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
        process.stdout.write(
          `\r  leidos ${seen.toLocaleString('es')}, guardados ${kept.toLocaleString('es')} (${mins} min)   `,
        );
      }
    }
    flushAll();
    console.log(`\r  leidos ${seen.toLocaleString('es')}, guardados ${kept.toLocaleString('es')}          `);
    console.log(ORIGENES.resumen());
  } else {
    console.log(`Recolectando desde la API para: ${COUNTRIES.join(', ')}`);
    const collected = await collectFromApi();
    // Cada producto va SOLO a la base del pais del que se obtuvo. Antes se
    // pasaba la lista entera de paises y todos los archivos salian identicos.
    for (const { row, country } of collected) write(row, [country]);
    flushAll();
  }

  /**
   * Tope opcional de productos por pais, con `--max-per-country=pais:N`.
   *
   * SIN tope por defecto. Lo tuvo -`united-states:300000`- de cuando un pais
   * grande no cabia en el limite de 100 MB por archivo de GitHub y no existia
   * el partido. Al quitarlo del workflow seguia aplicandose, porque estaba
   * tambien aqui como valor por defecto: Estados Unidos volvio a publicarse con
   * exactamente 300.000 productos de sus 970.565, y el unico indicio fue lo
   * redondo de la cifra.
   *
   * Un valor por defecto que recorta datos no deberia existir: si alguien
   * quiere recortar, que lo pida.
   */
  const caps = {};
  for (const pair of String(args['max-per-country'] ?? '').split(',')) {
    const [country, n] = pair.split(':');
    if (country && n) caps[country.trim()] = Number(n);
  }
  const results = [...targets.values()].map((t) => finalizeDb(t, caps[t.country ?? '']));

  /**
   * Cortes anteriores, para no mover filas de archivo entre noches.
   *
   * Se leen del indice publicado la vez anterior, que el workflow deja en
   * `--prev`. Sin el, la primera reconstruccion los calcula y las siguientes
   * los heredan.
   */
  const prevIndexPath = args.prev ? resolve(ROOT, String(args.prev), 'index.json') : undefined;
  const prevIndex =
    prevIndexPath && existsSync(prevIndexPath)
      ? JSON.parse(readFileSync(prevIndexPath, 'utf8'))
      : { countries: {} };

  // Los que no caben en un archivo de GitHub se parten en varios, completos.
  for (const r of results) {
    if (!r.country || r.bytes <= MAX_PART_BYTES) continue;
    const anterior = prevIndex.countries?.[r.country]?.parts;
    const bounds = anterior?.map((p) => p.to).filter((t) => t !== null && t !== undefined) ?? [];
    r.parts = splitDb(r.path, r.country, outDir, bounds);
    r.bytes = r.parts.reduce((t, p) => t + p.bytes, 0);
  }

  /**
   * Indice publicado junto a las bases.
   *
   * El cliente lo lee para decidir la estrategia de cada pais SIN tener que
   * adivinar: si el archivo es pequeno lo descarga entero (funciona despues sin
   * conexion), y si es grande lo consulta por rangos. Sin este indice habria
   * que cablear los tamanos en el codigo del cliente y quedarian obsoletos a la
   * primera reconstruccion.
   */
  if (split) {
    const index = {
      generated_at: new Date().toISOString(),
      source: 'Open Food Facts',
      license: 'ODbL-1.0',
      page_size: PAGE_SIZE,
      countries: Object.fromEntries(
        results
          .filter((r) => r.country)
          .map((r) => [
            r.country,
            {
              // `file` solo cuando hay un unico archivo. Un cliente que no
              // entienda `parts` se saltara los catalogos partidos, que es
              // mejor que intentar abrir uno incompleto.
              ...(r.parts ? {} : { file: `${r.country}.sqlite3` }),
              products: r.count,
              bytes: r.bytes,
              version: r.version,
              // Siempre hay `parts`, aunque sea una sola: asi el cliente tiene
              // un solo camino y no dos. Cada parte lleva DENTRO su cadena de
              // deltas, que es donde la escribe `build-delta.mjs` y donde la
              // lee el cliente.
              //
              // Aqui habia ademas un `deltas: []` a nivel de pais que nunca se
              // rellenaba. No rompia nada -el cliente lee las partes- pero el
              // indice publicado afirmaba que un catalogo no tenia deltas
              // teniendolos, y eso es una trampa para quien lo lea despues.
              parts: r.parts ?? [
                { file: `${r.country}.sqlite3`, from: null, to: null, products: r.count, bytes: r.bytes },
              ],
            },
          ]),
      ),
    };
    const indexPath = resolve(outDir, 'index.json');
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
    console.log(`\n  indice: ${indexPath}`);
  }

  console.log('');
  let total = 0;
  for (const r of results.sort((a, b) => b.bytes - a.bytes)) {
    const perProduct = r.count ? (r.bytes / r.count).toFixed(0) : 0;
    console.log(
      `  ${r.path.split('/').pop().padEnd(22)} ${String(r.count).padStart(8)} productos  ` +
        `${(r.bytes / 1024 / 1024).toFixed(2).padStart(8)} MB  ${perProduct} B/producto`,
    );
    total += r.bytes;
    if (r.bytes > 100 * 1024 * 1024) {
      console.log(`     aviso: supera los 100 MB, limite por archivo de GitHub.`);
    }
  }
  console.log(`\n  total: ${(total / 1024 / 1024).toFixed(2)} MB en ${results.length} archivo(s)`);
  if (results.every((r) => r.count === 0)) console.log('\n  Aviso: no se guardo ningun producto.');
}

// Solo se ejecuta si se invoca directamente. Al importarlo -lo hace
// `apply-off-delta.mjs` para reutilizar `mapProduct`- no debe construir nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
