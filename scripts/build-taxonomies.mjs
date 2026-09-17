/**
 * Descarga la taxonomia de aditivos de Open Food Facts y la compacta a lo
 * minimo que necesita el motor de puntuacion.
 *
 * El original pesa ~906 kB, casi todo nombres en 100+ idiomas. Conservando solo
 * espanol e ingles y los campos de evaluacion de EFSA, baja a una fraccion y
 * se puede precachear en el Service Worker sin penalizar la primera carga.
 *
 * Datos bajo licencia ODbL de Open Food Facts.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://static.openfoodfacts.org/data/taxonomies/additives.json';
const OUT = resolve(ROOT, 'public/data/additives.json');
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

mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(OUT, json);

console.log(`\nEscrito ${OUT}`);
console.log(`  ${(json.length / 1024).toFixed(0)} kB (reduccion del ${(100 - (json.length / rawBytes) * 100).toFixed(0)}%)`);
console.log('\nCobertura de evaluacion EFSA:');
console.log(`  riesgo alto de sobreexposicion:     ${stats.high}`);
console.log(`  riesgo moderado:                    ${stats.moderate}`);
console.log(`  sin riesgo identificado:            ${stats.no}`);
console.log(`  sin evaluacion:                     ${stats.unknown}`);
console.log(`  marcados por ANSES:                 ${stats.anses}`);
console.log(`  edulcorantes:                       ${stats.sweeteners}`);
