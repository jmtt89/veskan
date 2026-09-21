/*
 * Nivel de gravedad de cada aditivo, a partir de la evidencia ya cargada.
 *
 * La escala NO ordena por dosis sino por NATURALEZA DEL DANO. Se llego a ella
 * porque la dosis no discrimina: se comprobo que los tramos de IDA no
 * reproducen las clasificaciones de EFSA -las medianas de «alto» y «moderado»
 * coinciden en 5,0 mg/kg-, y no es un fallo del dato sino de la pregunta:
 * riesgo = peligro x exposicion, y la IDA solo mide lo primero.
 *
 *   E123 amaranto    teratogeno, IDA 0,15   casi no se usa  -> EFSA: sin riesgo
 *   E250 nitrito     reversible,  IDA 0,1   muy consumido   -> EFSA: alto
 *
 * Igual de potentes, extremos opuestos. Un teratogeno no es equiparable a una
 * alteracion reversible de la hemoglobina aunque la dosis sea parecida.
 *
 * EL NIVEL 1 NO SALE DE OPENFOODTOX, y no por falta de datos: en las catorce
 * etiquetas de efecto critico de las 753 sustancias no aparece NI UNA
 * relacionada con cancer o genotoxicidad. Es estructural -a un carcinogeno
 * genotoxico no se le asigna IDA porque no se le supone dosis segura-, asi que
 * nunca tendra «efecto critico». Ese nivel lo pueblan otras dos senales:
 *
 *   - IARC grupo 1, 2A o 2B
 *   - clasificacion CMR del Anexo VI del CLP (`Carc.`, `Muta.`)
 *   - `sin_ida_motivo = genotoxicidad` en OpenFoodTox
 *
 * Las dos entran por fuera y cubren justo el hueco que la escala no puede ver.
 *
 * La IDA NO es el nivel: es el modulador dentro de el. Entre dos teratogenos
 * pesa mas el de dosis menor, y sin esa modulacion el nivel solo engaña:
 *
 *   E523 alumbre amonico   IDA 0,14   <- el mas potente del nivel 2
 *   E123 amaranto          IDA 0,15
 *   E100 curcumina         IDA 3      <- 20 veces menos potente
 *
 * Los tres «afectan al desarrollo o la reproduccion», y tratar el colorante
 * del curry igual que el alumbre seria el mismo error de categoria que llevamos
 * corrigiendo toda la sesion. `posicion_en_nivel` la calcula a partir de los
 * datos, no de un criterio: donde cae su IDA entre las del mismo nivel.
 *
 * NIVEL Y CERTEZA SON DOS COSAS DISTINTAS. El nivel dice QUE TIPO de dano es;
 * la certeza, CUANTO se sabe. Mezclarlos dejaba sin nivel a seis de los siete
 * aditivos con IARC 2B -aspartamo, dioxido de titanio, bromato potasico- que
 * acababan valiendo lo mismo que uno sin ningun dato. «Posiblemente
 * cancerigeno» no es ausencia de datos: la naturaleza del dano esta
 * identificada y lo que falta es confirmacion.
 *
 *   IARC 1   -> nivel 1, certeza confirmada
 *   IARC 2A  -> nivel 1, certeza probable
 *   IARC 2B  -> nivel 1, certeza posible
 *   efecto critico de EFSA -> nivel 2-8, certeza establecida (esta medido)
 *
 * Cuando hay las dos cosas manda la naturaleza mas grave: el BHA es 2B y su
 * efecto critico es del desarrollo, asi que va a nivel 1 con certeza posible,
 * y el efecto del desarrollo queda anotado.
 *
 * DOS FUENTES INDEPENDIENTES PARA EL NIVEL 1: IARC y el Anexo VI del CLP. No
 * dicen siempre lo mismo -el orto-fenilfenol (E231) es «no clasificable» para
 * IARC y `Carc. 2` para la UE- y por eso conviene tener las dos. Manda la mas
 * grave, y la discrepancia queda anotada en vez de elegirse en silencio.
 *
 * VEREDICTO CONTRA VEREDICTO NO ES LO MISMO QUE VEREDICTO CONTRA SILENCIO:
 *
 *   - El grupo 3 de IARC significa «evaluado y no clasificable». Es una
 *     conclusion. Que la UE diga `Carc. 2` sobre lo mismo SI es un desacuerdo.
 *   - No tener entrada en el Anexo VI significa que no se ha evaluado. Eso no
 *     contradice a nadie; solo dice que una fuente callo.
 *
 * Se marcan por separado, `desacuerdo` y `solo_una_fuente`, porque piden cosas
 * distintas: el primero, mirar quien tiene razon; el segundo, saber que el
 * dato se apoya en una sola pata.
 *
 * `Repr.` va al nivel 2, no al 1: es toxicidad para la reproduccion, que es la
 * naturaleza del nivel 2, no cancerigena.
 *
 * CADA NIVEL GUARDA DE DONDE SALE (`gravedad.via`). Sin eso no se puede
 * auditar un veredicto ni explicarlo en la ficha.
 */

// Etiqueta de OpenFoodTox -> nivel. Vocabulario completo de las 753
// sustancias; si aparece una etiqueta nueva queda sin nivel y se avisa, en vez
// de asignarle uno por defecto.
const NIVEL_POR_EFECTO = {
  teratogenic: 2, reproductive: 2, developmental: 2,
  endocrine: 3,
  neurotoxicity: 4,
  hepatotoxicity: 5, nephrotoxicity: 5, 'pulmonary and cardiac': 5,
  immunotoxicity: 6, hemopoietic: 6, 'musclo-skeletal': 6,
  systemic: 7,
  irritation: 8,
  // `not reported` no tiene nivel: es ausencia de dato, no un efecto leve.
};

const DESCRIPCION = {
  1: 'genotóxico o carcinogénico',
  2: 'afecta al desarrollo o la reproducción',
  3: 'endocrino',
  4: 'neurotóxico',
  5: 'daño a órgano diana',
  6: 'inmunotóxico o hematopoyético',
  7: 'sistémico reversible',
  8: 'local o digestivo',
};

// Certeza segun quien lo diga. No es el nivel: lo matiza dentro de el.
const CERTEZA_IARC = {'1': 'confirmada', '2A': 'probable', '2B': 'posible'};
// El CLP usa su propia escala de categorias para lo mismo.
const CERTEZA_CLP = {'1A': 'confirmada', '1B': 'probable', '2': 'posible'};
const FUERZA = {confirmada: 3, probable: 2, posible: 1, establecida: 0};

const a = db.aditivos;
let asignados = 0, porIarc = 0, porGenotox = 0, porEfecto = 0;
const sinMapear = {};

let porClp = 0, discrepan = 0;
for (const d of a.find({$or: [
  {'oft.critico.toxicidad': {$ne: null}},
  {'oft.valor.sin_ida_motivo': 'genotoxicidad'},
  {'iarc.grupo': {$in: ['1', '2A', '2B']}},
  {'clp.clases.0': {$exists: true}},
]}).toArray()) {
  let nivel = null, certeza = null, via = null, detalle = null, ademas = null;
  // De QUE FILA sale el veredicto. `via` dice de que fuente; esto dice de que
  // registro, para poder volver a el sin reconstruir el cruce por CAS. Hace
  // falta porque hay veredictos que NO se pueden reproducir cruzando CAS: los
  // nitratos y nitritos los clasifico IARC por la CONDICION de exposicion
  // -«ingested nitrate or nitrite under conditions that result in endogenous
  // nitrosation»-, no por la sal, asi que no hay CAS que case.
  let origen = null;

  const tox = d.oft && d.oft.critico && d.oft.critico.toxicidad;
  const nivelEfecto = tox ? NIVEL_POR_EFECTO[tox] : null;
  if (tox && !nivelEfecto && tox !== 'not reported') {
    sinMapear[tox] = (sinMapear[tox] || 0) + 1;
  }

  // Nivel 1: siempre por fuera de OpenFoodTox, que no lo puede ver.
  const grupoIarc = d.iarc && CERTEZA_IARC[d.iarc.grupo] ? d.iarc.grupo : null;
  const genotox = d.oft && d.oft.valor && d.oft.valor.sin_ida_motivo === 'genotoxicidad';

  // CLP: `Carc.` y `Muta.` son nivel 1; `Repr.` es nivel 2.
  let clpNivel = null, clpCerteza = null, clpDetalle = null;
  if (d.clp && d.clp.clases && d.clp.clases.length) {
    const cmr = d.clp.clases.filter(x => x.tipo === 'Carc' || x.tipo === 'Muta');
    const rep = d.clp.clases.filter(x => x.tipo === 'Repr');
    const elegida = cmr.length ? cmr[0] : (rep.length ? rep[0] : null);
    if (elegida) {
      clpNivel = elegida.tipo === 'Repr' ? 2 : 1;
      clpCerteza = CERTEZA_CLP[elegida.categoria];
      clpDetalle = 'CLP ' + d.clp.clases.map(x => x.codigo).join(', ');
    }
  }

  // Entre IARC y CLP manda la mas grave; la discrepancia se anota.
  const iarcNivel = grupoIarc ? 1 : null;
  const iarcCerteza = grupoIarc ? CERTEZA_IARC[grupoIarc] : null;
  const iarcHabloAlgo = d.iarc && d.iarc.grupo;      // incluye el grupo 3
  let desacuerdo = null, soloUna = null;

  if (iarcNivel && clpNivel && FUERZA[iarcCerteza] !== FUERZA[clpCerteza]) {
    desacuerdo = 'IARC grupo ' + grupoIarc + ' frente a ' + clpDetalle;
    discrepan++;
  } else if (iarcHabloAlgo && !iarcNivel && clpNivel) {
    // IARC evaluo y no pudo clasificar; la UE si clasifico. Es el caso del
    // orto-fenilfenol (E231): grupo 3 frente a `Carc. 2`.
    desacuerdo = 'IARC grupo ' + d.iarc.grupo + ' («' + d.iarc.significado +
                 '») frente a ' + clpDetalle;
    discrepan++;
  }

  // Una sola fuente respalda el nivel 1. No es contradiccion, es fragilidad.
  if (iarcNivel && !clpNivel) soloUna = 'solo IARC; sin entrada en el Anexo VI del CLP';
  else if (clpNivel && !iarcHabloAlgo) soloUna = 'solo CLP; IARC no lo ha evaluado';
  const ganaClp = clpNivel && (!iarcNivel ||
      clpNivel < iarcNivel || FUERZA[clpCerteza] > FUERZA[iarcCerteza]);

  if (ganaClp) {
    nivel = clpNivel; certeza = clpCerteza;
    via = 'clp'; detalle = clpDetalle;
    origen = d.clp.cas || null;
    porClp++;
    if (nivelEfecto) ademas = {nivel: nivelEfecto, efecto: tox,
                               descripcion: DESCRIPCION[nivelEfecto]};
  } else if (grupoIarc) {
    nivel = 1; certeza = CERTEZA_IARC[grupoIarc];
    via = 'iarc'; detalle = 'IARC grupo ' + grupoIarc;
    origen = d.iarc.nombre || null;
    porIarc++;
    // El efecto critico no desaparece por haber algo mas grave encima.
    if (nivelEfecto) ademas = {nivel: nivelEfecto, efecto: tox,
                               descripcion: DESCRIPCION[nivelEfecto]};
  } else if (genotox) {
    nivel = 1; certeza = 'probable'; via = 'sin-ida-genotoxicidad';
    detalle = d.oft.valor.sin_ida_justificacion;
    origen = d.oft.valor_de || null;
    porGenotox++;
    if (nivelEfecto) ademas = {nivel: nivelEfecto, efecto: tox,
                               descripcion: DESCRIPCION[nivelEfecto]};
  } else if (nivelEfecto) {
    nivel = nivelEfecto; certeza = 'establecida';
    via = 'efecto-critico'; detalle = tox;
    origen = (d.oft.critico && d.oft.critico.estudio_uuid) || d.oft.valor_de || null;
    porEfecto++;
  }
  if (!nivel) continue;

  a.updateOne({_id: d._id}, {$set: {gravedad: {
    nivel,
    descripcion: DESCRIPCION[nivel],
    certeza,
    via,
    // La clave del registro concreto del que sale: uuid de OpenFoodTox, nombre
    // de la fila de IARC, o CAS del Anexo VI del CLP. Segun la `via`.
    origen,
    detalle,
    ademas,
    desacuerdo,
    solo_una_fuente: soloUna,
    // Modulador dentro del nivel, no el nivel.
    ida: (d.oft && d.oft.valor && d.oft.valor.ida) || null,
  }}});
  asignados++;
}

// --- Modulacion por IDA dentro de cada nivel ---
//
// Se calcula DESPUES de asignar los niveles porque necesita ver a todos los
// del mismo nivel. No cambia el nivel: lo situa.
for (let n = 1; n <= 8; n++) {
  const enNivel = a.find({'gravedad.nivel': n, 'gravedad.ida': {$ne: null}},
                         {'gravedad.ida': 1}).toArray();
  if (enNivel.length < 2) continue;
  const idas = enNivel.map(x => x.gravedad.ida).sort((p, q) => p - q);
  for (const x of enNivel) {
    const i = idas.indexOf(x.gravedad.ida);
    a.updateOne({_id: x._id}, {$set: {
      // 0 = el mas potente del nivel, 1 = el menos.
      'gravedad.posicion_en_nivel': Number((i / (idas.length - 1)).toFixed(2)),
      'gravedad.ida_min_del_nivel': idas[0],
      'gravedad.ida_max_del_nivel': idas[idas.length - 1],
    }});
  }
}

// --- IDA derivada sin margen de seguridad ---
//
// Lo habitual es un factor de incertidumbre de 100 sobre el NOAEL. Un factor
// de 1 significa que no se aplico margen, y eso cambia como hay que leer la
// cifra: no es una dosis segura con colchon, es el dato crudo.
const sinMargen = a.find({'oft.valor.incertidumbre': {$lte: 1}},
                         {'enlaces.off': 1}).toArray();
for (const x of sinMargen) {
  a.updateOne({_id: x._id}, {$set: {'gravedad.ida_sin_margen': true}});
}

print('aditivos con nivel de gravedad: ' + asignados);
print('   con posicion dentro del nivel: ' +
      a.countDocuments({'gravedad.posicion_en_nivel': {$ne: null}}));
print('   con IDA SIN margen de seguridad: ' + sinMargen.length);
print('   nivel 1 por IARC            : ' + porIarc);
print('   por clasificacion CLP       : ' + porClp);
print('   con desacuerdo IARC/CLP     : ' + discrepan);
print('   apoyados en UNA sola fuente : ' +
      a.countDocuments({'gravedad.solo_una_fuente': {$ne: null}}));
print('   nivel 1 por genotoxicidad   : ' + porGenotox);
print('   niveles 2-8 por efecto      : ' + porEfecto);
print('');
print('reparto por nivel:');
for (let n = 1; n <= 8; n++) {
  const c = a.countDocuments({'gravedad.nivel': n});
  if (!c) continue;
  let det = '';
  if (n === 1) {
    det = '   (' + ['confirmada', 'probable', 'posible']
      .map(x => x + ': ' + a.countDocuments({'gravedad.nivel': 1, 'gravedad.certeza': x}))
      .join(', ') + ')';
  }
  print('   ' + n + '  ' + String(c).padStart(4) + '  ' + DESCRIPCION[n] + det);
}
const nuevas = Object.keys(sinMapear);
if (nuevas.length) {
  print('');
  print('ETIQUETAS SIN NIVEL (revisar, pueden ser nuevas):');
  for (const k of nuevas) print('   ' + sinMapear[k] + '  ' + k);
}
