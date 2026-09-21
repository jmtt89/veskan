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

/*
 * PRECEDENCIA, y por que es explicita. Un aditivo puede llegar a varias
 * sustancias de EFSA a la vez: la suya por CAS y la de su dictamen de grupo.
 * El dato ESPECIFICO manda. El acido fosforico (E338) tiene IDA 2,25 propia y
 * 40 por el grupo de los fosfatos: vale 2,25.
 *
 * Esto estaba escrito y se perdio al traer el paso aqui: la version anterior
 * cogia el PRIMER enlace con registro y cortaba. Funcionaba de rebote, porque
 * `oft.py` solo cargaba sustancias CON valores y un enlace a una vacia no
 * encontraba registro y dejaba pasar al siguiente. Al empezar a cargar tambien
 * las que solo traen veredicto de genotoxicidad, ese corte se disparaba antes
 * de llegar al dato y se perdian IDAs. El orden del array no es una regla.
 *
 * Cada rama elige por separado, porque no tienen por que salir de la misma
 * sustancia: la IDA puede ser propia y el veredicto de genotoxicidad, del
 * grupo.
 */
const PESO = {'cas': 2, 'numero-e-en-nombre': 1, 'manual-grupo': 1, 'familia': 0};
let nOft = 0, nRoto = 0;
a.find({'enlaces.oft.0': {$exists: true}}).forEach(d => {
  const hits = [];
  for (const l of d.enlaces.oft) {
    const o = db.oft.findOne({_id: l.uuid});
    if (!o) { nRoto++; continue; }
    hits.push({o: o, via: l.via, peso: PESO[l.via] || 0});
  }
  if (!hits.length) return;

  // Primero por especificidad; a igualdad, la IDA mas baja, que es la mas
  // protectora.
  const mejor = (filtra, valor) => filtra
    .sort((x, y) => (y.peso - x.peso) || (valor(x) - valor(y)))[0];

  const set = {};
  const conValor = mejor(hits.filter(h => h.o.valor && h.o.valor.ida != null),
                         h => h.o.valor.ida);
  if (conValor) {
    set['oft.valor'] = conValor.o.valor;
    set['oft.valor_de'] = conValor.o._id;
    // `via` es la RUTA del enlace -cas, numero-e-en-nombre, manual-grupo-,
    // no si el dato es propio o heredado. Eso lo dice `heredado_de`.
    set['oft.valor_via'] = conValor.via;
    set['oft.nombre'] = conValor.o.nombre;
    // Si ademas hay evaluacion de grupo con otra IDA, se conserva: informa.
    const otras = hits.filter(h => h.o.valor && h.o.valor.ida != null
                                && h.o.valor.ida !== conValor.o.valor.ida)
                      .map(h => ({ida: h.o.valor.ida, via: h.via,
                                  sustancia: h.o.nombre}));
    if (otras.length) set['oft.tambien'] = otras;
  } else {
    const soloValor = mejor(hits.filter(h => h.o.valor), () => 0);
    if (soloValor) {
      set['oft.valor'] = soloValor.o.valor;
      set['oft.valor_de'] = soloValor.o._id;
      set['oft.valor_via'] = soloValor.via;
      set['oft.nombre'] = soloValor.o.nombre;
    }
  }

  /*
   * Se prefiere el estudio que traiga ETIQUETA de toxicidad, pero no se
   * descarta el que no la trae: sigue llevando especie, dosis y descriptor, y
   * exigir la etiqueta tiraba 54 de los 101 registros.
   */
  const conCrit = hits.filter(h => h.o.critico)
    .sort((x, y) => (Number(!!y.o.critico.toxicidad) - Number(!!x.o.critico.toxicidad))
                 || (y.peso - x.peso))[0];
  if (conCrit) {
    set['oft.critico'] = conCrit.o.critico;
    set['oft.critico_via'] = conCrit.via;
  }

  /*
   * Los hallazgos de geno/carcinogenicidad de los expedientes de EFSA. NO son
   * la conclusion del panel -vease la nota en `oft.py`- y por eso no tocan la
   * gravedad. Se prefiere el que DIGA algo: que una sustancia se haya
   * estudiado no se hereda a la inversa desde una que no.
   */
  const conGen = hits.filter(h => h.o.genotox && h.o.genotox.estudiado)
                     .sort((x, y) => y.peso - x.peso)[0]
             || hits.filter(h => h.o.genotox).sort((x, y) => y.peso - x.peso)[0];
  if (conGen) {
    set['oft.genotox'] = conGen.o.genotox;
    set['oft.genotox_via'] = conGen.via;
  }

  const otros = mejor(hits.filter(h => h.o.otros_valores), () => 0);
  if (otros) set['oft.otros_valores'] = otros.o.otros_valores;
  const motivo = hits.find(h => h.o.sin_dosis_motivo);
  if (motivo) set['oft.sin_dosis_motivo'] = motivo.o.sin_dosis_motivo;
  if (!set['oft.nombre']) set['oft.nombre'] = hits[0].o.nombre;

  if (Object.keys(set).length) { a.updateOne({_id: d._id}, {$set: set}); nOft++; }
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
      // Que abarca la clasificacion. Sin esto, el 2A del talco se lee como si
      // fuera del talco alimentario y no de lo que IARC evaluo de verdad.
      comentario: i.comentario || null,
      en_preparacion: !!i.en_preparacion,
    }}});
    nIarc++;
  }
  const c = db.clp.findOne({cas: {$in: cs}});
  if (c) {
    a.updateOne({_id: d._id}, {$set: {clp: {
      // El CAS se conserva para poder citar la fila exacta del Anexo VI de la
      // que sale el veredicto, no solo decir «lo dice el CLP».
      cas: c.cas,
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

// -------------------------------------- 8. detector: retiradas de colorantes

/*
 * `cfr81` NO es una fuente de verdad, es una ALARMA.
 *
 * La decision sobre cada aditivo vive en `prohibiciones.json`, escrita
 * leyendo la norma. Lo que la § 81.10 del CFR aporta es detectar la
 * SIGUIENTE: si un dia la FDA retira otro colorante de alimentos, aparece
 * aqui y avisa de que falta recogerlo, en vez de descubrirse por casualidad
 * como paso con el amaranto.
 *
 * Solo mira los parrafos cuyo alcance incluye ALIMENTOS. Los `D&C` y
 * `Ext. D&C` son farmacos y cosmetica: un colorante de barra de labios no
 * tiene por que penalizar una galleta.
 *
 * `aplica_a` vacio en el mapeo significa COMPROBADO que no tiene numero E
 * -se busco su CAS entre nuestros items y no esta-, no que falte revisarlo.
 * Por eso esos no se avisan.
 */
if (db.cfr81.countDocuments() === 0) {
  print('\ncfr81: coleccion vacia, no se comprueban retiradas de colorantes');
} else {
  const mapa = {};
  db.cfr81_manual.find({}).forEach(m => { mapa[m.seccion] = m; });
  const faltan = [], sinMapear = [];
  db.cfr81.find({alimentos: true}).forEach(c => {
    const m = mapa[c.seccion];
    if (!m) { sinMapear.push(`${c.seccion} ${c.nombre}`); return; }
    (m.aplica_a || []).forEach(tag => {
      const d = a.findOne({'enlaces.off.tag': tag});
      const tiene = d && (d.prohibiciones || []).some(
        p => p.jurisdiccion === 'Estados Unidos');
      if (!tiene) faltan.push(`${c.seccion} ${c.nombre} -> ${tag}`);
    });
  });
  const n = db.cfr81.countDocuments({alimentos: true});
  print(`\nretiradas de colorantes en EE.UU. (21 CFR 81.10): ${n} en alimentos`);
  if (sinMapear.length) {
    print('   SIN MAPEAR a un numero E, hay que decidirlo a mano:');
    sinMapear.forEach(x => print(`      ${x}`));
  }
  if (faltan.length) {
    print('   RETIRADA NO RECOGIDA en prohibiciones.json:');
    faltan.forEach(x => print(`      ${x}`));
  }
  if (!sinMapear.length && !faltan.length) {
    print('   todas mapeadas y recogidas');
  }
  // Los parrafos que retiran LACAS y no el colorante directo: es la trampa
  // del (u), que retiro las lacas del Red No. 3 en 1990 pero no el colorante
  // en alimentos, que aguanto hasta 2025.
  const lacas = db.cfr81.countDocuments({'revisar.0': {$exists: true}});
  if (lacas) print(`   parrafos con aviso de revision: ${lacas}`);
}

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
