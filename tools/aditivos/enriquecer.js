/*
 * El paso que faltaba: pegar cada fuente a su aditivo.
 *
 * POR QUE EXISTE ESTE FICHERO. Los extractores dejan cada fuente en su propia
 * coleccion -`cellar`, `oft`, `iarc`, `clp`, `off`- y `enlazar.py` calcula QUE
 * registro corresponde a cada aditivo. Pero nadie hacia la union. Se hizo a
 * mano en la consola, y eso significaba que la base NO se podia regenerar:
 * borrar `aditivos` costaba una tarde de comandos que nadie habia escrito.
 *
 * Se noto porque los seis parabenos aparecian enlazados y sin un solo dato
 * detras. Al tirar del hilo, 215 de 326 enlaces a OpenFoodTox apuntaban a
 * registros que nunca se habian cargado.
 *
 * ES IDEMPOTENTE, y tiene que serlo. Primero borra los campos derivados y
 * despues los reconstruye. Si en vez de eso fuera añadiendo, un dato retirado
 * en la fuente seguiria vivo aqui para siempre, que es justo el fallo que
 * tuvimos con el E556 y el E559.
 *
 * LO QUE NO TOCA: `enlaces` y `revisar`, que los produce `enlazar.py`, y los
 * items de Wikidata. Este script solo escribe lo que se puede volver a
 * derivar.
 *
 * EL ORDEN IMPORTA en un solo punto: la herencia de familias se aplica DESPUES
 * del enlace directo, y solo donde el directo no dejo nada. Un dato medido
 * sobre la sustancia manda siempre sobre uno prestado por un hermano.
 *
 * Uso:
 *   mongoimport --db aditivos --collection prohibiciones --drop --jsonArray < prohibiciones-planas.json
 *   mongosh aditivos < enriquecer.js
 */

const a = db.aditivos;

// Campos derivados. Se borran en bloque antes de reconstruir.
const DERIVADOS = ['legal', 'oft', 'iarc', 'clp', 'off', 'prohibiciones', 'gravedad'];

print('limpiando campos derivados...');
const borrado = {};
DERIVADOS.forEach(c => { borrado[c] = ''; });
const limpio = a.updateMany({}, {$unset: borrado});
print(`   ${limpio.modifiedCount} documentos limpiados\n`);

// ---------------------------------------------------------------- utilidades

/** Los CAS que declara el item de Wikidata (P231). */
function casDe(d) {
  const c = (d.claims && d.claims.P231) || [];
  return c.map(s => s.mainsnak && s.mainsnak.datavalue && s.mainsnak.datavalue.value)
          .filter(Boolean);
}

/** El primer tag de Open Food Facts, que es por el que se busca en `off`. */
function tagDe(d) {
  const o = (d.enlaces && d.enlaces.off) || [];
  return o.length ? o[0].tag : null;
}

/**
 * El numero E de la lista de la Union.
 *
 * `enlaces.off[].e_number` NO sirve tal cual: Open Food Facts le da el mismo
 * numero -340- a `en:e340` y a `en:e340i`, asi que buscar por el numero
 * confundiria la familia con sus miembros. El tag si distingue, de modo que el
 * sufijo se saca de ahi.
 */
function numeroE(d) {
  const t = tagDe(d);
  const m = t && /^en:e(\d{3,4}[a-z]*)$/.exec(t);
  return m ? m[1] : null;
}

// ------------------------------------------------------------- 1. estado legal

let nLegal = 0;
a.find({'enlaces.off.0': {$exists: true}}).forEach(d => {
  const n = numeroE(d);
  if (!n) return;
  const c = db.cellar.findOne({numero_e: n});
  // Ausente de la lista NO es lo mismo que retirado, y la diferencia decide si
  // penaliza. Se guardan los dos casos, distinguidos.
  const legal = c
    ? {autorizado: c.autorizado, via: c.via, retirado: c.retirado,
       listado_parte_b: c.listado_parte_b, nombre_reglamento: c.nombre_reglamento,
       celex: c.fuente && c.fuente.celex}
    : {autorizado: false, via: null, retirado: false, listado_parte_b: false,
       ausente: true};
  a.updateOne({_id: d._id}, {$set: {legal}});
  nLegal++;
});
print(`estado legal (Cellar)      : ${nLegal}`);

// ------------------------------------------------------- 2. OpenFoodTox directo

let nOft = 0, nRoto = 0;
a.find({'enlaces.oft.0': {$exists: true}}).forEach(d => {
  for (const l of d.enlaces.oft) {
    const o = db.oft.findOne({_id: l.uuid});
    if (!o) { nRoto++; continue; }
    const set = {};
    if (o.valor) {
      set['oft.valor'] = o.valor;
      set['oft.valor_de'] = o._id;
      // `via` es la RUTA del enlace -cas, numero-e-en-nombre, manual-grupo-,
      // no si el dato es propio o heredado. Eso lo dice `heredado_de`.
      set['oft.valor_via'] = l.via;
    }
    if (o.critico) { set['oft.critico'] = o.critico; set['oft.critico_via'] = l.via; }
    if (o.otros_valores) set['oft.otros_valores'] = o.otros_valores;
    if (o.sin_dosis_motivo) set['oft.sin_dosis_motivo'] = o.sin_dosis_motivo;
    set['oft.nombre'] = o.nombre;
    if (Object.keys(set).length) { a.updateOne({_id: d._id}, {$set: set}); nOft++; }
    break;
  }
});
print(`OpenFoodTox directo        : ${nOft}   (enlaces sin registro: ${nRoto})`);

// -------------------------------------------------- 3. herencia entre familias

/*
 * Una familia -`E331 citratos de sodio`- no es una sustancia y por eso no
 * tiene CAS ni datos propios. Sus miembros si. `familias.py` decide de cual se
 * hereda; aqui solo se aplica, y SOLO si la familia se quedo sin dato propio.
 *
 * Se marca `heredado_de` porque no es lo mismo: que un difosfato concreto
 * tenga IDA no dice que todos se comporten igual.
 */
let nHered = 0;
db.familias.find({heredado: {$ne: null}}).forEach(f => {
  const d = a.findOne({'enlaces.off.tag': f.tag});
  if (!d || (d.oft && d.oft.valor)) return;
  for (const u of (f.heredado.oft_uuid || [])) {
    const o = db.oft.findOne({_id: u});
    if (!o || !o.valor) continue;
    a.updateOne({_id: d._id}, {$set: {
      'oft.valor': o.valor,
      'oft.valor_de': o._id,
      'oft.valor_via': 'familia',
      'oft.heredado_de': f.heredado.de,
      'oft.heredado_miembros': `${f.heredado.miembros_con_dato} de ${f.heredado.miembros_totales}`,
    }});
    nHered++;
    break;
  }
});
print(`heredado de la familia     : ${nHered}`);

// ------------------------------------------------------------ 4. IARC y 5. CLP

let nIarc = 0, nClp = 0;
a.find({'enlaces.off.0': {$exists: true}}).forEach(d => {
  const cs = casDe(d);
  if (!cs.length) return;
  const i = db.iarc.findOne({cas: {$in: cs}});
  if (i) {
    a.updateOne({_id: d._id}, {$set: {iarc: {
      grupo: i.grupo, significado: i.significado, nombre: i.nombre,
      volumen: i.volumen, anio: i.anio, via: 'cas',
    }}});
    nIarc++;
  }
  const c = db.clp.findOne({cas: {$in: cs}});
  if (c) {
    a.updateOne({_id: d._id}, {$set: {clp: {
      clases: c.clases, peor: c.peor, cancerigeno: c.cancerigeno,
      mutagenico: c.mutagenico, repro: c.repro,
      celex: c.fuente && c.fuente.celex, via: 'cas',
    }}});
    nClp++;
  }
});
/*
 * IARC A MANO. IARC clasifica a veces una EXPOSICION y no una sustancia, y esas
 * entradas no llevan CAS: «nitrate or nitrite (ingested) under conditions that
 * result in endogenous nitrosation» no se puede cruzar con nada. De las 173
 * entradas sin CAS solo UNA aplica a aditivos, y cubre cuatro: E249 a E252.
 *
 * Va despues del cruce por CAS y no lo pisa: si el CAS ya resolvio, ese dato es
 * mas especifico que una asignacion escrita a mano.
 */
let nIarcManual = 0;
db.iarc_manual.find({}).forEach(m => {
  (m.aplica_a || []).forEach(tag => {
    const d = a.findOne({'enlaces.off.tag': tag});
    if (!d || d.iarc) return;
    a.updateOne({_id: d._id}, {$set: {iarc: {
      grupo: m.grupo, significado: m.significado || null,
      nombre: m.entrada_iarc, volumen: [m.volumen], anio: m.anio,
      via: 'manual',
      // La entrada de IARC no habla de la sustancia sin mas, sino de una
      // condicion de exposicion. Sin esto el veredicto se lee mal.
      condicionado_a: m.condicionado_a || null,
    }}});
    nIarcManual++;
  });
});

print(`IARC                       : ${nIarc}   (+${nIarcManual} a mano)`);
print(`CLP anexo VI               : ${nClp}`);

// ------------------------------------------------- 6. exposicion de Open Food Facts

let nOff = 0;
a.find({'enlaces.off.0': {$exists: true}}).forEach(d => {
  const t = tagDe(d);
  const o = t && db.off.findOne({_id: t});
  if (!o) return;
  a.updateOne({_id: d._id}, {$set: {off: {
    riesgo: o.riesgo_sobreexposicion,
    supera_medio: o.supera_ida_consumo_medio,
    supera_p95: o.supera_ida_percentil95,
    vulnerables: o.grupos_vulnerables_afectados,
    anses: o.anses_vigilancia,
    dictamen: o.dictamen,
    clases: o.clases,
  }}});
  nOff++;
});
print(`exposición (Open Food Facts): ${nOff}`);

// ------------------------------------------------- 7. prohibiciones y retiradas

/*
 * LA DISTINCION QUE DECIDE LA PENALIZACION. Una prohibicion dice que la
 * sustancia no puede usarse; una retirada solo la borra del listado. En seis de
 * las nueve retiradas el motivo no es la sustancia sino que nadie pago la
 * reevaluacion o que dejo de venderse.
 *
 * Las dos se guardan en el mismo campo, con `tipo`, para que la ficha pueda
 * explicar por que un aditivo retirado NO penaliza.
 */
let nProh = 0, nRet = 0, sinItem = [], compartidos = [];
db.prohibiciones.find({}).forEach(p => {
  const d = a.findOne({'enlaces.off.tag': p.tag});
  if (!d) { sinItem.push(p.tag); return; }
  /*
   * A QUE TAG se aplica, y no es redundante. Un item de Wikidata puede llevar
   * varios numeros E: el del bromato potasico (Q409241) lleva `en:e924`,
   * `en:e924a` y `en:e924b`, pero el E 924b es bromato de CALCIO, otra
   * sustancia. Sin guardar el tag, la prohibicion del potasico se leeria como
   * si cubriera al calcico.
   */
  /*
   * QUE TAGS CUBRE, leido de la norma y no deducido por descarte.
   *
   * Deducirlo fallaba, y al reves: la version anterior marcaba `no_cubre` como
   * «todos los demas tags del item», con lo que la prohibicion del fosfato de
   * aluminio decia cubrir `en:e541` y NO `en:e541i`, cuando el reglamento
   * nombra exactamente `INS 541 i`.
   *
   * Resulta que `en:e541` y `en:e541i` son la MISMA sustancia con dos
   * convenciones: la UE no usa romanos y llama «E 541 Fosfato acido de sodio y
   * aluminio» a lo que Codex llama `541 i`. El alcalino -`541 ii`- la UE ni lo
   * autoriza. Eso no se deduce de la estructura: hay que leer las dos normas.
   */
  const cubre = p.cubre && p.cubre.length ? p.cubre : [p.tag];
  const otros = (d.enlaces.off || []).map(x => x.tag)
                                     .filter(x => cubre.indexOf(x) < 0);
  const entrada = {
    tag: p.tag,
    cubre,
    // Numeros E del mismo item que esta prohibicion NO cubre: son otra
    // sustancia aunque compartan documento de Wikidata.
    no_cubre: otros.length ? otros : null,
    tipo: p.tipo,
    jurisdiccion: p.jurisdiccion,
    referencia: p.referencia,
    fecha: p.fecha,
    cumplimiento: p.cumplimiento || null,
    // La frase literal de la norma. Sin ella el veredicto no es comprobable.
    verbo: p.verbo,
    alcance: p.alcance || null,
    alcance_detalle: p.alcance_detalle || null,
    motivo: p.motivo || null,
    base_legal: p.base_legal || null,
    matiz: p.matiz || null,
    tambien: p.tambien || null,
    penaliza: p.tipo === 'prohibicion',
  };
  a.updateOne({_id: d._id}, {$push: {prohibiciones: entrada}});
  if (p.tipo === 'prohibicion') nProh++; else nRet++;
  if (otros.length) compartidos.push(`${p.tag} comparte item con ${otros.join(', ')}`);
});
print(`prohibiciones              : ${nProh}`);
print(`retiradas (no penalizan)   : ${nRet}`);
if (sinItem.length) print(`   SIN ITEM en la coleccion: ${sinItem.join(', ')}`);
compartidos.forEach(x => print(`   revisar: ${x}`));

// ------------------------------------------------------------------- resumen

print('\nresumen:');
[['legal', 'estado legal'], ['oft.valor', 'IDA o valor OFT'],
 ['oft.critico', 'efecto crítico'], ['oft.sin_dosis_motivo', 'motivo de no-dosis'],
 ['iarc', 'IARC'], ['clp', 'CLP'], ['off', 'exposición'],
 ['prohibiciones.0', 'con prohibición o retirada']].forEach(([f, n]) => {
  const q = {}; q[f] = {$exists: true};
  print(`   ${n.padEnd(28)} ${String(a.countDocuments(q)).padStart(5)}`);
});
print('\nahora toca: mongosh aditivos < gravedad.js');
