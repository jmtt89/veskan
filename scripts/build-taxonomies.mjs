/**
 * Descarga la taxonomia de aditivos de Open Food Facts y la compacta a lo
 * minimo que necesita el motor de puntuacion.
 *
 * El original pesa ~906 kB, casi todo nombres en 100+ idiomas. Conservando solo
 * espanol e ingles y los campos de evaluacion de EFSA, baja a una fraccion y
 * se puede precachear en el Service Worker sin penalizar la primera carga.
 *
 * SE LE FUNDE ENCIMA NUESTRA BASE DE PELIGRO, si esta disponible. Open Food
 * Facts solo trae una cosa: si EFSA encontro riesgo de SOBREEXPOSICION. Eso
 * responde «¿la gente supera la IDA?», que no es lo mismo que «¿esto es
 * peligroso?». Y de 683 aditivos, 618 no tienen esa evaluacion: el 79% de las
 * apariciones del catalogo caia en un unico cubo plano donde el dioxido de
 * titanio prohibido valia lo mismo que el acido citrico.
 *
 * Se funde en el MISMO fichero en vez de publicar otro aparte porque la
 * aplicacion ya lo descarga: un segundo fetch y un segundo formato serian dos
 * cosas que pueden fallar por separado, para 40 kB de datos.
 *
 * La base completa -con la evidencia detras de cada veredicto- se publica en
 * Parquet en la rama `aditivos` del repositorio de datos. Aqui solo baja lo
 * RESUELTO, que es lo unico que el motor sabe usar.
 *
 * Datos: Open Food Facts (ODbL-1.0) mas las fuentes de `tools/aditivos/`.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://static.openfoodfacts.org/data/taxonomies/additives.json';
const OUT = resolve(ROOT, 'public/data/additives.json');
// Nuestra base de peligro, generada por `tools/aditivos/publicar.mjs`. Si no
// esta, la taxonomia se genera igual: el motor tiene que seguir funcionando
// con solo lo de Open Food Facts.
const PELIGRO = resolve(ROOT, 'data/aditivos/aditivos.sqlite3');
// Identificacion ante Open Food Facts. No es autenticacion ni lleva datos
// personales: solo el nombre del proyecto y una URL publica de contacto.
const UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)';

/** Extrae el valor de un campo multilingue, priorizando espanol. */
function pick(field, langs = ['es', 'en', 'xx']) {
  if (!field) return undefined;
  for (const l of langs) if (field[l]) return field[l];
  return undefined;
}

function splitTags(value) {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function normalizeRisk(value) {
  if (!value) return undefined;
  const v = value.replace(/^en:/, '').toLowerCase();
  if (v === 'high') return 'high';
  if (v === 'moderate') return 'moderate';
  if (v === 'no') return 'no';
  return undefined;
}

console.log(`Descargando ${SOURCE} ...`);
const res = await fetch(SOURCE, { headers: { 'User-Agent': UA } });
if (!res.ok) throw new Error(`Descarga fallida: HTTP ${res.status}`);
const raw = await res.json();
const rawBytes = Buffer.byteLength(JSON.stringify(raw));
console.log(`  ${Object.keys(raw).length} aditivos, ${(rawBytes / 1024).toFixed(0)} kB`);

const out = {};
const stats = { high: 0, moderate: 0, no: 0, unknown: 0, anses: 0, sweeteners: 0 };

for (const [tag, entry] of Object.entries(raw)) {
  const e = pick(entry.e_number);
  const name = pick(entry.name);
  const risk = normalizeRisk(pick(entry.efsa_evaluation_overexposure_risk));
  const anses = pick(entry.anses_additives_of_interest) === 'yes';
  const sweetener = pick(entry.sweetener) === 'yes';
  const nonNutritiveSweetener = pick(entry.non_nutritive_sweetener) === 'yes';

  const compact = {};
  if (e) compact.e = e;
  compact.name = name ?? (e ? `E${e}` : tag.replace(/^en:/, ''));
  const classes = splitTags(pick(entry.additives_classes));
  if (classes) compact.classes = classes;
  if (risk) compact.risk = risk;
  const meanOver = splitTags(pick(entry.efsa_evaluation_exposure_mean_greater_than_adi));
  if (meanOver) compact.meanOver = meanOver;
  const p95Over = splitTags(pick(entry.efsa_evaluation_exposure_95th_greater_than_adi));
  if (p95Over) compact.p95Over = p95Over;
  if (anses) compact.anses = true;
  if (sweetener) compact.sweetener = true;
  if (nonNutritiveSweetener) compact.nonNutritiveSweetener = true;
  const url = pick(entry.efsa_evaluation_url);
  if (url) compact.url = url;
  const date = pick(entry.efsa_evaluation_date);
  if (date) compact.date = date;
  const desc = pick(entry.description);
  if (desc) compact.desc = desc;

  out[tag.toLowerCase()] = compact;

  stats[risk ?? 'unknown']++;
  if (anses) stats.anses++;
  if (sweetener) stats.sweeteners++;
}

// --------------------------------------------------- base de peligro ------
const peligro = { aditivos: 0, prohibidos: 0, nivel: 0, motivo: 0 };
if (existsSync(PELIGRO)) {
  const db = new DatabaseSync(PELIGRO);
  for (const r of db.prepare('SELECT * FROM aditivo').all()) {
    const c = out[r.tag];
    // Un tag que la base de peligro conoce y la taxonomia no: no se inventa
    // una entrada, porque sin nombre ni clases el motor no sabria que hacer
    // con ella. Se cuenta aparte para que se vea.
    if (!c) continue;
    if (r.prohibido) { c.prohibido = true; peligro.prohibidos++; }
    if (r.nivel != null) {
      c.nivel = r.nivel;
      c.nivelDesc = r.descripcion ?? undefined;
      c.certeza = r.certeza ?? undefined;
      // Modula dentro del nivel: entre dos teratogenos pesa mas el de dosis
      // menor. 1 es el mas potente del nivel, 0 el menos.
      if (r.posicion_en_nivel != null) c.posNivel = r.posicion_en_nivel;
      peligro.nivel++;
    }
    if (r.ida != null) c.ida = r.ida;
    // IDA derivada con factor de incertidumbre <= 1: sin margen de seguridad.
    if (r.ida_sin_margen) c.sinMargen = true;
    if (r.sin_dosis_motivo) { c.sinDosis = r.sin_dosis_motivo; peligro.motivo++; }
    if (r.iarc) c.iarc = r.iarc;
    if (r.clp) c.clp = r.clp;
    if (r.legal_ue) c.legalUe = r.legal_ue;
    peligro.aditivos++;
  }
  // Las prohibiciones con su norma, para poder citarlas en la ficha en vez de
  // decir «prohibido» sin mas.
  for (const r of db.prepare(
    'SELECT tag, jurisdiccion, referencia, verbo, alcance FROM prohibicion WHERE penaliza = 1'
  ).all()) {
    const c = out[r.tag];
    if (!c) continue;
    (c.normas ??= []).push({
      j: r.jurisdiccion, ref: r.referencia ?? undefined,
      verbo: r.verbo ?? undefined,
      alcance: r.alcance === 'parcial' ? 'parcial' : undefined,
    });
  }
  db.close();
}

mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(OUT, json);

console.log(`\nEscrito ${OUT}`);
console.log(`  ${(json.length / 1024).toFixed(0)} kB (reduccion del ${(100 - (json.length / rawBytes) * 100).toFixed(0)}%)`);
if (peligro.aditivos) {
  console.log('\nBase de peligro fundida:');
  console.log(`  aditivos enriquecidos:              ${peligro.aditivos}`);
  console.log(`  con prohibicion:                    ${peligro.prohibidos}`);
  console.log(`  con nivel de gravedad:              ${peligro.nivel}`);
  console.log(`  con motivo de no tener dosis:       ${peligro.motivo}`);
} else {
  console.log('\nSin base de peligro (data/aditivos/aditivos.sqlite3 no esta).');
}

console.log('\nCobertura de evaluacion EFSA:');
console.log(`  riesgo alto de sobreexposicion:     ${stats.high}`);
console.log(`  riesgo moderado:                    ${stats.moderate}`);
console.log(`  sin riesgo identificado:            ${stats.no}`);
console.log(`  sin evaluacion:                     ${stats.unknown}`);
console.log(`  marcados por ANSES:                 ${stats.anses}`);
console.log(`  edulcorantes:                       ${stats.sweeteners}`);
