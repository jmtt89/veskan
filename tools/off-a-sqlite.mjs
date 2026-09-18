/**
 * EXPERIMENTAL, SOLO PARA INVESTIGACION.
 *
 * Esto no forma parte de la aplicacion ni de la tuberia de datos. La base
 * normalizada sirve para revisar y entender el volcado de Open Food Facts, no
 * para servirlo: se midio que no vale como formato de entrega -83 veces mas
 * grande, 75 archivos por pais, unas 815 peticiones por ficha frente a 4- ni
 * aporta nada a la construccion nocturna, porque GitHub Actions no tiene esta
 * base. Ver docs/06-esquema-off.md.
 */

/**
 * Carga el volcado de Open Food Facts desde MongoDB local a PostgreSQL.
 *
 *   node tools/off-a-sqlite.mjs [--limite=N]
 *
 * Por que existe: `off.products` son 85 GB para 11 GB de cache de WiredTiger y
 * ya tiene los 64 indices que MongoDB permite como maximo, asi que no admite
 * ninguno mas. Cualquier pregunta que no encaje en los que hay cuesta un
 * barrido de unos 6 minutos. La version SQL tiene tipos impuestos, indices
 * propios y relaciones, y responde en segundos.
 *
 * El reparto NO va campo por campo -serian 189.111- sino por forma. Cada clave
 * de primer nivel cae en una de nueve formas, y lo que no encaja en ninguna
 * termina en `propiedad`, que es una tabla como las demas. Nada se descarta:
 * si algo no aparece en PostgreSQL es un fallo, no una decision.
 */

import { MongoClient } from 'mongodb';
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const LIMITE = args.limite ? Number(args.limite) : 0;
const MONGO = args.mongo ?? 'mongodb://localhost:27017';
const SALIDA = args.out ?? 'data/off.sqlite3';
const LOTE = Number(args.lote ?? 2000);   // productos por transaccion

// --- conversiones -----------------------------------------------------------

/**
 * Numero tolerante. El mismo campo llega como int, long, double, cadena o nulo:
 * `serving_quantity` trae 425.330 cadenas y `product_quantity` 151.407. Lo que
 * no convierte queda en nulo; no se inventa.
 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') {
    const n = Number(v.toString());
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
const txt = (v) => {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};
const bul = (v) => (v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0);
const bulN = (v) => (v === undefined || v === null ? null : bul(v));
const fecha = (seg) => {
  const n = num(seg);
  // Hay marcas de tiempo absurdas (ano 1 y ano 50.000): fuera de rango se
  // descartan en vez de reventar la insercion.
  if (n === null || n <= 0 || n > 4102444800) return null;
  return n * 1000;   // milisegundos desde epoch, como los catalogos publicados
};
const trio = (v) => (['yes', 'no', 'maybe'].includes(v) ? v : null);

/** better-sqlite3 no acepta `undefined`: se normaliza a null. */
const v0 = (v) => (v === undefined ? null : v);

// --- clasificacion de claves ------------------------------------------------

/** Campos de texto que existen en variante por idioma. */
const CAMPOS_TEXTO = [
  'product_name', 'generic_name', 'ingredients_text', 'abbreviated_product_name',
  'conservation_conditions', 'preparation', 'recycling_instructions', 'warning',
  'customer_service', 'origin', 'packaging_text', 'serving_size', 'other_information',
  'ingredients_text_with_allergens', 'obsolete_since_date', 'producer_version_id',
  'nutrition_data_per', 'link', 'no_nutrition_data',
];
const RE_IDIOMA = /^[a-z]{2,3}(_[a-z]{2,4})?$/i;
const RE_OCR = /^(.+?)_([a-z]{2,3}(?:_[a-z]{2,4})?)_ocr_(\d+)(_result)?$/i;

/** Escalares que van a columnas de `producto`. No se repiten en `propiedad`. */
const EN_PRODUCTO = new Set([
  '_id', 'code', 'id', 'lang', 'lc', 'product_type', 'brands', 'quantity',
  'product_quantity', 'serving_size', 'serving_quantity', 'nutrition_data_per',
  'nutrition_data_prepared_per', 'no_nutrition_data', 'nova_group',
  'nutriscore_grade', 'nutriscore_score', 'nutriscore_version', 'nutrition_grade_fr',
  'pnns_groups_1', 'pnns_groups_2', 'ecoscore_grade', 'ecoscore_score',
  'created_t', 'last_modified_t', 'last_updated_t', 'rev', 'creator', 'last_editor',
  'unique_scans_n', 'popularity_key', 'completeness', 'complete', 'additives_n',
  'ingredients_n', 'unknown_ingredients_n', 'product_name', 'generic_name',
  'ingredients_text', 'image_front_url', 'image_front_small_url',
]);

/** Objetos con tabla propia. El resto de objetos va a `propiedad`. */
const OBJETOS_PROPIOS = new Set([
  'images', 'nutriments', 'nutrition', 'nutriscore', 'nutriscore_data',
  'nutrient_levels', 'nova_groups_markers', 'languages', 'languages_codes',
  'nutriments_estimated',
]);
/** Arrays de objetos con tabla propia. */
const ARRAYS_PROPIOS = new Set(['ingredients', 'packagings', 'sources']);

/**
 * Duplicados internos de Open Food Facts. Guardarlos seria denormalizar, que es
 * justo lo contrario del objetivo: son el MISMO hecho escrito varias veces.
 *
 * Medido sobre 5.000 productos, quitarlos baja de 2.600 millones de filas
 * previstas a un orden de magnitud menos, sin perder ni un dato:
 *
 *   `*_hierarchy`      los ancestros en la taxonomia, derivables de `*_tags`
 *   `*_original_tags`  la lista antes de normalizar, que ya esta en `*_tags`
 *   `*_prev_tags`      la version anterior de la misma lista
 *   `*_old_tags`       idem, de una migracion vieja
 *   `*_debug_tags`     rastro del analizador, no informacion del producto
 *   `_keywords`        indice de busqueda que Open Food Facts genera solo
 *   `ecoscore_data`    el mismo calculo que `environmental_score_data`, con el
 *                      nombre anterior
 *
 * Con `--todo` se guardan igualmente, para quien quiera el bruto.
 */
const TODO = Boolean(args.todo);
const RE_DUPLICADO = /(_hierarchy|_original_tags|_prev_tags|_old_tags|_debug_tags)$/;
const DUPLICADOS = new Set(['_keywords', 'ecoscore_data', 'ecoscore_extended_data',
  'ingredients_debug', 'ingredients_ids_debug', 'debug_param_sorted_langs',
  'nova_group_debug', 'nutrition_score_debug', 'ingredients_text_debug',
  'ingredients_percent_analysis', 'ingredients_original_tags']);
const esDuplicado = (k) => !TODO && (DUPLICADOS.has(k) || RE_DUPLICADO.test(k));

// --- extractores por forma --------------------------------------------------

function* nutrientes(p) {
  const visto = new Set();
  const dar = (nid, valor, unidad, base, origen, fuente, prep) => {
    const v = num(valor);
    if (v === null || !nid) return;
    const k = `${nid}|${base}|${origen}|${prep}`;
    if (visto.has(k)) return;
    visto.add(k);
    return { nid, v, unidad: txt(unidad), base, origen, fuente: txt(fuente), prep };
  };
  const ag = p.nutrition?.aggregated_set?.nutrients;
  if (ag && typeof ag === 'object') {
    for (const [nid, x] of Object.entries(ag)) {
      if (!x || typeof x !== 'object') continue;
      const f = dar(nid, x.value ?? x.value_computed, x.unit, '100g', 'aggregated_set', x.source, false);
      if (f) yield f;
    }
  }
  const n = p.nutriments;
  if (n && typeof n === 'object') {
    const base = p.nutrition_data_per === 'serving' ? 'serving' : '100g';
    for (const [k, v] of Object.entries(n)) {
      if (/_(unit|label)$/.test(k)) continue;
      const prep = k.includes('_prepared');
      const limpio = k.replace('_prepared', '');
      if (limpio.endsWith('_100g')) {
        const f = dar(limpio.slice(0, -5), v, null, '100g', 'nutriments_100g', null, prep);
        if (f) yield f;
      } else if (limpio.endsWith('_serving')) {
        const f = dar(limpio.slice(0, -8), v, null, 'serving', 'nutriments_base', null, prep);
        if (f) yield f;
      } else if (limpio.endsWith('_value')) {
        const nid = limpio.slice(0, -6);
        const f = dar(nid, v, n[`${nid}_unit`], 'declarado', 'nutriments_base', null, prep);
        if (f) yield f;
      } else {
        const f = dar(limpio, v, n[`${limpio}_unit`], base, 'nutriments_base', null, prep);
        if (f) yield f;
      }
    }
  }
  const est = p.nutriments_estimated;
  if (est && typeof est === 'object') {
    for (const [k, v] of Object.entries(est)) {
      const f = dar(k.replace(/_100g$/, ''), v, null, '100g', 'estimado', 'estimate', false);
      if (f) yield f;
    }
  }
  const comp = p.nutriscore_data?.components;
  if (comp && typeof comp === 'object') {
    for (const lado of ['negative', 'positive']) {
      for (const x of Array.isArray(comp[lado]) ? comp[lado] : []) {
        if (!x || typeof x.id !== 'string') continue;
        const f = dar(x.id.replace(/_/g, '-'), x.value, x.unit, '100g', 'nutriscore_data', null, false);
        if (f) yield f;
      }
    }
  }
}

/** Ingredientes con su anidamiento, aplanados a (ruta, padre, profundidad). */
function* ingredientes(lista, padre = null, prof = 0) {
  if (!Array.isArray(lista)) return;
  for (const [i, x] of lista.entries()) {
    if (!x || typeof x !== 'object') continue;
    const ruta = padre === null ? String(i) : `${padre}.${i}`;
    yield { ruta, padre, prof, orden: i, x };
    if (Array.isArray(x.ingredients)) yield* ingredientes(x.ingredients, ruta, prof + 1);
  }
}

/**
 * Umbral a partir del cual un mapa se guarda como VALOR POR DEFECTO mas
 * excepciones, con la clave `*` para el defecto.
 *
 * Open Food Facts guarda el Eco-Score por pais: 63 claves, una por pais, y
 * medido sobre 5.000 productos el `grades` trae **un unico valor distinto por
 * producto** -el mismo repetido 63 veces- y los `transportation_scores` son
 * cero en el 98,5%. Escribir 63 filas para un solo hecho es denormalizar.
 *
 * Con esto, quien consulte lee `*` como el valor del producto y las claves
 * concretas como las excepciones. No se pierde nada y se reconstruye exacto.
 */
const MAPA_MIN = 8;

/** Aplana un objeto anidado a pares (ambito, clave), colapsando los mapas
 *  uniformes a `*` mas sus excepciones. */
function* aplanar(obj, ambito, prof = 0) {
  if (prof > 4 || !obj || typeof obj !== 'object') return;

  if (!Array.isArray(obj)) {
    const ent = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
    if (ent.length >= MAPA_MIN && ent.length === Object.keys(obj).length) {
      const cuenta = new Map();
      for (const [, v] of ent) cuenta.set(String(v), (cuenta.get(String(v)) ?? 0) + 1);
      const [modal, n] = [...cuenta].sort((a, b) => b[1] - a[1])[0];
      // Solo compensa si la mayoria comparte valor; si no, se guarda entero.
      if (n > ent.length / 2) {
        yield { ambito, clave: '*', valor: modal, num: num(modal) };
        for (const [k, v] of ent) {
          if (String(v) !== modal) yield { ambito, clave: k, valor: String(v), num: num(v) };
        }
        return;
      }
    }
  }

  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length && v.every((y) => typeof y !== 'object')) {
        yield { ambito, clave: k, valor: v.join(','), num: null };
      } else {
        for (const [i, y] of v.entries()) {
          if (y && typeof y === 'object') yield* aplanar(y, `${ambito}.${k}[${i}]`, prof + 1);
          else if (y !== null) yield { ambito: `${ambito}.${k}`, clave: String(i), valor: String(y), num: num(y) };
        }
      }
    } else if (typeof v === 'object') {
      yield* aplanar(v, `${ambito}.${k}`, prof + 1);
    } else {
      yield { ambito, clave: k, valor: String(v), num: num(v) };
    }
  }
}

// --- carga ------------------------------------------------------------------

const TABLAS = {
  producto: '(id,code,lang,lc,tipo_producto,nombre,nombre_idioma,ingredientes,ingredientes_idioma,marcas,cantidad,cantidad_g,racion,racion_g,nutricion_base,nutricion_base_prep,sin_tabla,nova_group,nutriscore_grade,nutriscore_score,nutriscore_version,nutrition_grade_fr,pnns_grupo_1,pnns_grupo_2,ecoscore_grade,ecoscore_score,es_bebida,es_agua,es_queso,es_grasa_frutos,es_carne_roja,creado,modificado,actualizado,revision,creador,ultimo_editor,escaneos,popularidad,completitud,completo,aditivos_n,ingredientes_n,ingredientes_desconocidos_n,id_no_era_cadena)',
  texto: '(producto_id,campo_id,idioma_id,valor)',
  ocr: '(producto_id,campo_id,idioma_id,ejecutado,texto,resultado)',
  etiqueta: '(producto_id,tipo_id,orden,valor_id)',
  nutriente: '(producto_id,nutriente_id,base,origen,valor,unidad_id,fuente_id,preparado)',
  nivel_nutriente: '(producto_id,nutriente_id,nivel)',
  nutriscore_version: '(producto_id,version,score,grade,aplicable,calculado,estimado,preparacion,es_bebida,es_agua,es_queso,es_grasa_frutos,es_carne_roja,puntos_negativos,puntos_positivos,cuenta_proteinas,cuenta_proteinas_motivo)',
  nutriscore_componente: '(producto_id,version,lado,componente,valor,unidad,puntos,puntos_max)',
  ingrediente: '(producto_id,ruta,padre,profundidad,orden,id,texto,porcentaje,porcentaje_min,porcentaje_max,porcentaje_est,cantidad_est,vegano,vegetariano,del_aceite_palma,procesamiento,en_taxonomia,ciqual_code,ciqual_proxy_code,ecobalyse_code)',
  nova_marcador: '(producto_id,grupo,tipo,valor)',
  imagen: '(producto_id,clase,tipo,idioma,imgid,revision,subida,subida_por)',
  imagen_tamano: '(producto_id,clase,tipo,idioma,tamano,ancho,alto)',
  envase: '(producto_id,orden,forma,material,reciclaje,contacto_alimento,unidades,cantidad_unidad,cantidad_valor,cantidad_unidad_medida,peso_medido,peso_estimado,peso_especificado)',
  fuente: '(producto_id,orden,id,nombre,url,fabricante,importado,licencia)',
  fuente_campo: '(producto_id,orden,campo)',
  idioma_producto: '(producto_id,idioma,codigo,campos)',
  propiedad: '(producto_id,ambito_id,clave_id,valor,valor_num)',
};

async function main() {
  const mongo = new MongoClient(MONGO);
  await mongo.connect();
  const col = mongo.db('off').collection('products');

  if (existsSync(SALIDA)) rmSync(SALIDA);
  mkdirSync(dirname(SALIDA), { recursive: true });
  const db = new Database(SALIDA);

  // Durante la carga no hay nada que proteger: si falla, se repite. Con el
  // diario y la sincronizacion puestos, insertar cientos de millones de filas
  // tardaria varias veces mas.
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -400000');   // 400 MB

  console.log('Creando el esquema ...');
  db.exec(readFileSync(new URL('./sql/esquema.sql', import.meta.url), 'utf8'));
  const carga = db.prepare('INSERT INTO carga (origen, iniciada, notas) VALUES (?,?,?)')
    .run('mongodb://off.products', Date.now(), LIMITE ? `prueba, limite ${LIMITE}` : 'carga completa')
    .lastInsertRowid;

  // Una sentencia preparada por tabla, y las filas se acumulan para meterlas
  // por transacciones: en SQLite el coste esta en la transaccion, no en la fila.
  const f = {};
  for (const [t, cols] of Object.entries(TABLAS)) {
    const nombres = cols.slice(1, -1).split(',');
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${t} ${cols} VALUES (${nombres.map(() => '?').join(',')})`);
    f[t] = { stmt, buf: [], n: 0 };
  }
  const w = (t, campos) => { f[t].buf.push(campos.map(v0)); f[t].n++; };

  // Vocabulario en memoria. Una tabla de terminos solo sirve si resolverlos no
  // cuesta una consulta por fila: se cachea y se inserta al vuelo.
  const voc = new Map();
  const insVoc = db.prepare('INSERT INTO vocabulario (id, clase, valor) VALUES (?,?,?)');
  const vocBuf = [];
  let vocId = 0;
  const V = (clase, valor) => {
    if (valor === null || valor === undefined) return null;
    const k = clase + '\u0000' + valor;
    let id = voc.get(k);
    if (id === undefined) { id = ++vocId; voc.set(k, id); vocBuf.push([id, clase, String(valor)]); }
    return id;
  };
  const volcar = db.transaction(() => {
    for (const v of vocBuf) insVoc.run(v);
    vocBuf.length = 0;
    for (const t of Object.keys(f)) {
      for (const fila of f[t].buf) f[t].stmt.run(fila);
      f[t].buf.length = 0;
    }
  });

  let pid = 0;
  const cursor = col.find({}, { batchSize: 200 });
  if (LIMITE) cursor.limit(LIMITE);
  const t0 = Date.now();
  let vistos = 0;

  for await (const p of cursor) {
    const code = txt(p.code);
    if (!code) continue;
    vistos++;
    const PID = ++pid;

    const textos = [];
    const etiquetas = [];
    const props = [];

    for (const [k, v] of Object.entries(p)) {
      if (v === null || v === undefined || v === '') continue;

      const ocr = RE_OCR.exec(k);
      if (ocr) continue;                      // se tratan aparte, mas abajo
      if (esDuplicado(k)) continue;
      if (EN_PRODUCTO.has(k)) continue;       // van a columnas
      if (OBJETOS_PROPIOS.has(k) || ARRAYS_PROPIOS.has(k)) continue;

      if (Array.isArray(v)) {
        if (v.every((x) => typeof x !== 'object' || x === null)) {
          const tipo = k.replace(/_tags$/, '');
          v.forEach((x, i) => { const s = txt(x); if (s) etiquetas.push([tipo, i, s]); });
        } else {
          for (const [i, x] of v.entries()) props.push(...aplanar(x, `${k}[${i}]`));
        }
        continue;
      }
      if (typeof v === 'object') { props.push(...aplanar(v, k)); continue; }

      // Escalar: o es una variante por idioma de un texto, o es una propiedad.
      const base = CAMPOS_TEXTO.find((cc) => k === cc || k.startsWith(cc + '_'));
      if (base) {
        const suf = k.slice(base.length).replace(/^_/, '');
        if (suf === '' || RE_IDIOMA.test(suf)) {
          const s = txt(v);
          if (s) textos.push([base, suf.toLowerCase(), s]);
          continue;
        }
      }
      const s = txt(v);
      if (s !== null) props.push({ ambito: '', clave: k, valor: s, num: num(v) });
    }

    // Textos base que si estan en `producto` tambien se guardan por idioma.
    for (const cc of ['product_name', 'generic_name', 'ingredients_text']) {
      const s = txt(p[cc]);
      if (s) textos.push([cc, '', s]);
    }

    const de = (campo) => {
      const x = textos.find((t) => t[0] === campo && t[1] === '')
        ?? textos.find((t) => t[0] === campo && t[1] === String(p.lang ?? '').toLowerCase())
        ?? textos.filter((t) => t[0] === campo).sort((a, b) => a[1].localeCompare(b[1]))[0];
      return x ? { v: x[2], i: x[1] || txt(p.lang) } : { v: null, i: null };
    };
    const nom = de('product_name');
    const gen = nom.v ? { v: null, i: null } : de('generic_name');
    const ing = de('ingredients_text');
    const nd = p.nutriscore_data ?? {};

    w('producto', [
      PID, code, txt(p.lang), txt(p.lc), txt(p.product_type),
      nom.v ?? gen.v, nom.v ? nom.i : gen.i, ing.v, ing.i, txt(p.brands),
      txt(p.quantity), num(p.product_quantity), txt(p.serving_size), num(p.serving_quantity),
      ['100g', 'serving'].includes(p.nutrition_data_per) ? p.nutrition_data_per : null,
      ['100g', 'serving'].includes(p.nutrition_data_prepared_per) ? p.nutrition_data_prepared_per : null,
      bul(p.no_nutrition_data),
      [1, 2, 3, 4].includes(num(p.nova_group)) ? num(p.nova_group) : null,
      /^[abcde]$/.test(String(p.nutriscore_grade)) ? p.nutriscore_grade : null,
      num(p.nutriscore_score), txt(p.nutriscore_version),
      /^[abcde]$/.test(String(p.nutrition_grade_fr)) ? p.nutrition_grade_fr : null,
      txt(p.pnns_groups_1), txt(p.pnns_groups_2), txt(p.ecoscore_grade), num(p.ecoscore_score),
      bul(nd.is_beverage), bul(nd.is_water), bul(nd.is_cheese),
      bul(nd.is_fat_oil_nuts_seeds), bul(nd.is_red_meat_product),
      fecha(p.created_t), fecha(p.last_modified_t), fecha(p.last_updated_t),
      num(p.rev), txt(p.creator), txt(p.last_editor),
      num(p.unique_scans_n), num(p.popularity_key), num(p.completeness), bulN(p.complete),
      num(p.additives_n), num(p.ingredients_n), num(p.unknown_ingredients_n),
      typeof p._id !== 'string' ? 1 : 0,
    ]);

    const puestos = new Set();
    for (const [campo, idioma, valor] of textos) {
      const k = campo + '|' + idioma;
      if (puestos.has(k)) continue;
      puestos.add(k);
      w('texto', [PID, V('campo', campo), V('idioma', idioma), valor]);
    }
    const et = new Set();
    for (const [tipo, orden, valor] of etiquetas) {
      const k = tipo + '|' + orden;
      if (et.has(k)) continue;
      et.add(k);
      w('etiqueta', [PID, V('tipo', tipo), orden, V('tag', valor)]);
    }
    const pr = new Set();
    for (const x of props) {
      const k = (x.ambito || '') + '|' + x.clave;
      if (pr.has(k)) continue;
      pr.add(k);
      w('propiedad', [PID, V('ambito', x.ambito || ''), V('clave', x.clave), x.valor, x.num]);
    }

    for (const n of nutrientes(p)) {
      w('nutriente', [PID, V('nutriente', n.nid), n.base, n.origen, n.v, V('unidad', n.unidad), V('fuente', n.fuente), n.prep ? 1 : 0]);
    }
    for (const [nid, nivel] of Object.entries(p.nutrient_levels ?? {})) {
      if (['low', 'moderate', 'high'].includes(nivel)) w('nivel_nutriente', [PID, V('nutriente', nid), nivel]);
    }

    for (const [ver, d] of Object.entries(p.nutriscore ?? {})) {
      if (!d || typeof d !== 'object') continue;
      const dd = d.data ?? {};
      w('nutriscore_version', [PID, ver, num(d.score), txt(d.grade), bulN(d.nutriscore_applicable),
        bulN(d.nutriscore_computed), bulN(d.estimated), txt(d.preparation),
        bulN(dd.is_beverage), bulN(dd.is_water), bulN(dd.is_cheese),
        bulN(dd.is_fat_oil_nuts_seeds), bulN(dd.is_red_meat_product),
        num(dd.negative_points), num(dd.positive_points),
        bulN(dd.count_proteins), txt(dd.count_proteins_reason)]);
      for (const lado of ['positive', 'negative']) {
        for (const x of Array.isArray(dd.components?.[lado]) ? dd.components[lado] : []) {
          if (!x || typeof x.id !== 'string') continue;
          w('nutriscore_componente', [PID, ver, lado, x.id, num(x.value), txt(x.unit), num(x.points), num(x.points_max)]);
        }
      }
    }

    for (const { ruta, padre, prof, orden, x } of ingredientes(p.ingredients)) {
      w('ingrediente', [PID, ruta, padre, prof, orden, txt(x.id), txt(x.text),
        num(x.percent), num(x.percent_min), num(x.percent_max), num(x.percent_estimate),
        num(x.quantity_estimate), trio(x.vegan), trio(x.vegetarian),
        txt(x.from_palm_oil), txt(x.processing), bulN(x.is_in_taxonomy),
        txt(x.ciqual_food_code), txt(x.ciqual_proxy_food_code), txt(x.ecobalyse_code)]);
    }

    for (const [grupo, marcas] of Object.entries(p.nova_groups_markers ?? {})) {
      const g = num(grupo);
      if (!g || !Array.isArray(marcas)) continue;
      const vistos2 = new Set();
      for (const m of marcas) {
        if (!Array.isArray(m) || m.length < 2) continue;
        const k = m[0] + '|' + m[1];
        if (vistos2.has(k)) continue;
        vistos2.add(k);
        w('nova_marcador', [PID, g, String(m[0]), String(m[1])]);
      }
    }

    const im = p.images ?? {};
    for (const [tipo, porIdioma] of Object.entries(im.selected ?? {})) {
      for (const [idioma, d] of Object.entries(porIdioma ?? {})) {
        if (!d || typeof d !== 'object') continue;
        w('imagen', [PID, 'selected', tipo, idioma, txt(d.imgid), txt(d.rev), null, null]);
        for (const [tam, s] of Object.entries(d.sizes ?? {})) {
          w('imagen_tamano', [PID, 'selected', tipo, idioma, tam, num(s?.w), num(s?.h)]);
        }
      }
    }
    for (const [imgid, d] of Object.entries(im.uploaded ?? {})) {
      if (!d || typeof d !== 'object') continue;
      w('imagen', [PID, 'uploaded', imgid, '', imgid, null, fecha(d.uploaded_t), txt(d.uploader)]);
      for (const [tam, s] of Object.entries(d.sizes ?? {})) {
        w('imagen_tamano', [PID, 'uploaded', imgid, '', tam, num(s?.w), num(s?.h)]);
      }
    }

    for (const [i, e] of (Array.isArray(p.packagings) ? p.packagings : []).entries()) {
      if (!e || typeof e !== 'object') continue;
      w('envase', [PID, i, txt(e.shape), txt(e.material), txt(e.recycling), bulN(e.food_contact),
        num(e.number_of_units), txt(e.quantity_per_unit), num(e.quantity_per_unit_value),
        txt(e.quantity_per_unit_unit), num(e.weight_measured), num(e.weight_estimated), num(e.weight_specified)]);
    }

    for (const [i, s] of (Array.isArray(p.sources) ? p.sources : []).entries()) {
      if (!s || typeof s !== 'object') continue;
      w('fuente', [PID, i, txt(s.id), txt(s.name), txt(s.url), bulN(s.manufacturer),
        fecha(s.import_t), txt(s.source_licence)]);
      const cs = new Set();
      for (const campo of Array.isArray(s.fields) ? s.fields : []) {
        const t = txt(campo);
        if (t && !cs.has(t)) { cs.add(t); w('fuente_campo', [PID, i, t]); }
      }
    }

    for (const [forma, campo] of [[false, 'languages'], [true, 'languages_codes']]) {
      for (const [idioma, n] of Object.entries(p[campo] ?? {})) {
        const v = num(n);
        if (v !== null) w('idioma_producto', [PID, idioma, forma ? 1 : 0, v]);
      }
    }

    // OCR: la marca de tiempo estaba en el NOMBRE del campo; aqui es columna.
    const ocrs = new Map();
    for (const [k, v] of Object.entries(p)) {
      const m = RE_OCR.exec(k);
      if (!m) continue;
      const clave = `${m[1]}|${m[2].toLowerCase()}|${m[3]}`;
      const e = ocrs.get(clave) ?? { campo: m[1], idioma: m[2].toLowerCase(), ts: m[3] };
      if (m[4]) e.resultado = txt(v); else e.texto = txt(v);
      ocrs.set(clave, e);
    }
    for (const e of ocrs.values()) {
      const f2 = fecha(e.ts);
      if (f2) w('ocr', [PID, V('campo', e.campo), V('idioma', e.idioma), f2, e.texto ?? null, e.resultado ?? null]);
    }

    if (vistos % LOTE === 0) volcar();
    if (vistos % 50000 === 0) {
      const min = (Date.now() - t0) / 60000;
      console.log(`  ${vistos.toLocaleString('es')} productos · ${min.toFixed(1)} min · ${(vistos / min / 1000).toFixed(1)}k/min`);
    }
  }

  volcar();

  const cuenta = Object.fromEntries(Object.entries(f).map(([t, x]) => [t, x.n]));
  const marcar = db.prepare('INSERT INTO carga_tabla (carga_id, tabla, filas) VALUES (?,?,?)');
  db.transaction(() => {
    for (const [t, n] of Object.entries(cuenta)) marcar.run(carga, t, n);
  })();
  db.prepare('UPDATE carga SET terminada = ? WHERE id = ?').run(Date.now(), carga);

  console.log('\nCreando indices ...');
  db.exec(readFileSync(new URL('./sql/indices.sql', import.meta.url), 'utf8'));

  console.log(`\nCargado en ${((Date.now() - t0) / 60000).toFixed(1)} min en ${SALIDA}:`);
  for (const [t, n] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(22)} ${n.toLocaleString('es').padStart(14)}`);
  }
  db.close();
  await mongo.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
