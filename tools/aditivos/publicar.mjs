/**
 * Publica la base de aditivos en sus dos niveles.
 *
 * DOS NIVELES PORQUE SON DOS PUBLICOS DISTINTOS.
 *
 *   Parquet   el conjunto de datos completo, en el repositorio de datos, para
 *             que cualquiera pueda consultarlo sin conocer nuestro modelo.
 *   SQLite    el corte que baja NUESTRO webapp: solo lo resuelto, por tag.
 *
 * POR QUE PARQUET Y NO JSON, a esta escala. No es por el tamaño -el fichero
 * mayor ronda los 3 MB- sino porque es columnar y TIPADO: un `float` es un
 * float y no una cadena, va comprimido, y lo leen pandas, DuckDB, Spark, R y
 * Polars sin que nadie tenga que entender como lo guardamos nosotros. Para un
 * conjunto de datos publico eso es exactamente lo que se quiere.
 *
 * SE PUEDE CONSULTAR SIN SERVIDOR, y esta comprobado contra GitHub:
 *
 *     HEAD                      200 · content-length · CORS *
 *     GET Range: bytes=0-99     206 · content-range   · CORS *
 *     GET Range: bytes=-8       206 con curl, pero PREFLIGHT 403
 *
 * El ultimo es la trampa: `Range` solo esta en la lista blanca de CORS si
 * lleva INICIO EXPLICITO. Un rango sufijo -que es lo primero que pediria un
 * lector de Parquet para leer el pie- dispara un preflight, y
 * raw.githubusercontent.com responde 403. Hay que averiguar el tamaño con un
 * HEAD y pedir despues rangos explicitos. Es justo lo que ya hace nuestro
 * `range-reader.ts` para SQLite.
 *
 * MODELO RELACIONAL, no un solo fichero gordo. Las columnas de Parquet son
 * planas, asi que lo anidado se reparte en tablas en vez de meterse como JSON
 * dentro de una celda: asi se puede consultar. `aditivo_tags` resuelve que un
 * item de Wikidata puede llevar varios numeros E, y que un numero E puede
 * estar reclamado por varios items -hay 135 asi-.
 *
 * LO QUE NO SE PUBLICA: el blob `claims` crudo de Wikidata, que son 54 KB de
 * cada 65 y del que solo leemos seis propiedades. Quitarlo baja la tabla de
 * aditivos de 37 MB a 1,3.
 *
 * LICENCIAS de lo que se mezcla, que no son la misma:
 *   Wikidata                CC0
 *   Open Food Facts         ODbL-1.0
 *   EFSA OpenFoodTox        CC-BY-ND   <- la delicada
 *   Legislacion de la UE    reutilizable sin restriccion (2011/833/UE)
 *   Regulacion federal EEUU dominio publico
 *   IARC                    uso con atribucion
 *
 * El «ND» de OpenFoodTox es «no derivatives» y aqui se publica una base
 * derivada. Se sostiene porque lo que se extrae son HECHOS -una IDA, un
 * NOAEL, una especie- y los hechos no son objeto de derecho de autor; y
 * porque cada fila cita su fuente. Pero es la pieza mas fragil del paquete y
 * conviene saberlo antes de publicar, no despues.
 *
 * SE GENERA EN LOCAL, no en CI. La base vive en un Mongo de la maquina y los
 * volcados se hacen a mano; automatizar la publicacion antes de que las
 * decisiones esten asentadas convertiria un error de criterio en un error
 * desplegado.
 *
 * Uso:
 *   docker exec <contenedor> mongoexport --db aditivos --collection <c> ...
 *   npm run aditivos:publicar -- <dir-jsonl> [dir-salida]
 *
 * La salida por defecto es `data/aditivos/`, que esta en .gitignore igual que
 * el resto de artefactos de construccion: de ahi se copia al repositorio de
 * datos cuando se decida publicar.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parquetWriteBuffer } from 'hyparquet-writer';

// Identificadores de Wikidata que si usamos. El resto del item se descarta.
const IDS = {
  P231: 'cas', P628: 'numero_e_wikidata', P662: 'pubchem',
  P3117: 'dsstox', P2566: 'echa', P652: 'unii',
};

const leer = (dir, n) =>
  readFileSync(join(dir, `${n}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Valor de una propiedad de Wikidata, como lista de cadenas. */
function claim(d, p) {
  return ((d.claims && d.claims[p]) || [])
    .map((s) => s.mainsnak?.datavalue?.value)
    .filter((v) => typeof v === 'string');
}

const texto = (v) => (v == null ? null : String(v));
const lista = (v) => (Array.isArray(v) && v.length ? v.join('|') : null);
const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Escribe una tabla. `cols` es una lista de [nombre, tipo, extractor], y se
 * declara explicitamente en vez de deducirse de la primera fila: el esquema de
 * un conjunto de datos publico no deberia depender de que traiga el primer
 * registro.
 */
function tabla(salida, nombre, filas, cols) {
  const columnData = cols.map(([name, type, get]) => ({
    name, type, data: filas.map(get),
  }));
  const buf = parquetWriteBuffer({ columnData });
  const ruta = join(salida, `${nombre}.parquet`);
  writeFileSync(ruta, Buffer.from(buf));
  TABLAS.push({
    nombre, fichero: `${nombre}.parquet`, bytes: statSync(ruta).size,
    filas: filas.length, columnas: cols.map(([n]) => n),
  });
  const kb = Math.round(statSync(ruta).size / 1024);
  console.log(`   ${nombre.padEnd(22)}${String(filas.length).padStart(6)} filas${String(kb).padStart(7)} KB`);
  return filas.length;
}

/*
 * Lo que se ha escrito, para el indice. Se acumula segun se generan las tablas
 * en vez de listarse aparte: un indice escrito a mano se queda viejo en cuanto
 * se añade una tabla, y eso ya paso -se publicaron tres tablas nuevas y el
 * indice siguio anunciando trece-.
 */
const TABLAS = [];

function main(dir, salida) {
  mkdirSync(salida, { recursive: true });
  const D = Object.fromEntries(
    ['aditivos', 'cellar', 'oft', 'iarc', 'clp', 'off', 'fda', 'cfr81',
     'familias', 'prohibiciones', 'motivos'].map((n) => [n, leer(dir, n)]));

  console.log('PARQUET — conjunto de datos completo\n');

  // --- el aditivo, una fila por item de Wikidata ---------------------------
  tabla(salida, 'aditivos', D.aditivos, [
    ['wikidata', 'STRING', (d) => d._id],
    ['nombre_en', 'STRING', (d) => texto(d.labels?.en?.value)],
    ['nombre_es', 'STRING', (d) => texto(d.labels?.es?.value)],
    ['descripcion_en', 'STRING', (d) => texto(d.descriptions?.en?.value)],
    ...Object.entries(IDS).map(([p, n]) => [n, 'STRING', (d) => lista(claim(d, p))]),
  ]);

  // --- tags, que es la relacion que de verdad importa ----------------------
  // Un item puede llevar varios numeros E y un numero E puede estar reclamado
  // por varios items. Sin esta tabla no se puede auditar ninguna de las dos
  // cosas.
  const tags = [];
  for (const d of D.aditivos) {
    for (const t of d.enlaces?.off || []) {
      tags.push({ wikidata: d._id, ...t });
    }
  }
  tabla(salida, 'aditivo_tags', tags, [
    ['wikidata', 'STRING', (r) => r.wikidata],
    ['tag', 'STRING', (r) => r.tag],
    ['numero_e', 'STRING', (r) => texto(r.e_number)],
    ['nombre', 'STRING', (r) => texto(r.nombre)],
    ['nombre_en', 'STRING', (r) => texto(r.nombre_en)],
    ['via', 'STRING', (r) => texto(r.via)],
  ]);

  // --- gravedad ------------------------------------------------------------
  const grav = D.aditivos.filter((d) => d.gravedad);
  tabla(salida, 'gravedad', grav, [
    ['wikidata', 'STRING', (d) => d._id],
    ['nivel', 'INT32', (d) => d.gravedad.nivel],
    ['descripcion', 'STRING', (d) => texto(d.gravedad.descripcion)],
    ['certeza', 'STRING', (d) => texto(d.gravedad.certeza)],
    ['via', 'STRING', (d) => texto(d.gravedad.via)],
    ['detalle', 'STRING', (d) => texto(d.gravedad.detalle)],
    ['ida', 'DOUBLE', (d) => numero(d.gravedad.ida)],
    ['posicion_en_nivel', 'DOUBLE', (d) => numero(d.gravedad.posicion_en_nivel)],
    ['desacuerdo', 'STRING', (d) => texto(d.gravedad.desacuerdo)],
    ['solo_una_fuente', 'STRING', (d) => texto(d.gravedad.solo_una_fuente)],
  ]);

  // --- diccionarios: la escala entera, no solo lo que esta poblado --------
  /*
   * LOS OCHO NIVELES, incluidos los que estan VACIOS.
   *
   * Hoy solo hay aditivos en 1, 2, 4, 5, 6 y 7. Publicar unicamente esos seis
   * haria que una interfaz pintase una escala de seis peldaños, y la escala es
   * de ocho: el 3 y el 8 estan vacios, que no es lo mismo que no existir.
   */
  const NIVELES = [
    [1, 'genotóxico o carcinogénico', 'Alguien evaluó y concluyó que puede causar cáncer o dañar el ADN. No sale de OpenFoodTox: a un carcinógeno genotóxico no se le asigna IDA, precisamente porque no se le supone dosis segura.'],
    [2, 'afecta al desarrollo o la reproducción', 'Efectos sobre el feto, el desarrollo o la función reproductora.'],
    [3, 'endocrino', 'Altera el sistema hormonal.'],
    [4, 'neurotóxico', 'Daña el sistema nervioso.'],
    [5, 'daño a órgano diana', 'Hígado, riñón, pulmón o corazón.'],
    [6, 'inmunotóxico o hematopoyético', 'Sistema inmunitario o formación de la sangre.'],
    [7, 'sistémico reversible', 'Efecto general que remite al cesar la exposición.'],
    [8, 'local o digestivo', 'Irritación o efecto local en el tubo digestivo.'],
  ];
  tabla(salida, 'niveles', NIVELES, [
    ['nivel', 'INT32', (r) => r[0]],
    ['etiqueta', 'STRING', (r) => r[1]],
    ['descripcion', 'STRING', (r) => r[2]],
    ['poblado', 'BOOLEAN',
     (r) => D.aditivos.some((d) => d.gravedad && d.gravedad.nivel === r[0])],
  ]);

  /*
   * ORDEN DE `certeza`, y un aviso que importa mas que el orden.
   *
   * `confirmada`, `probable` y `posible` son UN eje: cuanto de seguro se esta
   * de que causa cancer, y salen de IARC (1, 2A, 2B) o del CLP (1A, 1B, 2).
   * Esas tres si se ordenan entre si.
   *
   * `establecida` es OTRA COSA y no compite con ellas. Significa que el efecto
   * esta MEDIDO: es el que fijo la IDA en un estudio de OpenFoodTox. Decir que
   * «establecida» va antes o despues de «posible» es un error de categoria,
   * como preguntar si un kilo pesa mas que un martes.
   *
   * Por eso van `eje` y `rango`: dentro de un eje el rango ordena; entre ejes
   * no se comparan. Una interfaz que las mezcle en una sola escala mentira.
   */
  const CERTEZAS = [
    ['confirmada', 'sospecha-de-cancer', 3, 'Evaluado y confirmado: IARC grupo 1, o CLP categoría 1A.'],
    ['probable', 'sospecha-de-cancer', 2, 'IARC grupo 2A, o CLP categoría 1B.'],
    ['posible', 'sospecha-de-cancer', 1, 'IARC grupo 2B, o CLP categoría 2. No es ausencia de datos: la naturaleza del daño está identificada y lo que falta es confirmación.'],
    ['establecida', 'efecto-medido', 0, 'El efecto está medido: es el que fijó la ingesta diaria admisible en un estudio. No se compara con las tres anteriores.'],
  ];
  tabla(salida, 'certezas', CERTEZAS, [
    ['certeza', 'STRING', (r) => r[0]],
    ['eje', 'STRING', (r) => r[1]],
    ['rango', 'INT32', (r) => r[2]],
    ['descripcion', 'STRING', (r) => r[3]],
  ]);

  // --- de donde sale cada veredicto de gravedad ---------------------------
  /*
   * El puente que permite decir «este nivel sale de AQUI» sin reconstruir el
   * cruce por CAS. Hace falta porque hay cuatro veredictos que NO se pueden
   * reproducir asi: los nitratos y nitritos (E249-E252) los clasifico IARC por
   * la CONDICION de exposicion -«ingested nitrate or nitrite under conditions
   * that result in endogenous nitrosation»- y no por la sal, de modo que no hay
   * ningun CAS que case.
   */
  const origen = D.aditivos.filter((d) => d.gravedad);
  tabla(salida, 'gravedad_origen', origen, [
    ['wikidata', 'STRING', (d) => d._id],
    ['fuente', 'STRING', (d) => d.gravedad.via],
    // Segun la fuente: uuid de OpenFoodTox, nombre de la fila de IARC, o CAS
    // del Anexo VI del CLP.
    ['clave_origen', 'STRING', (d) => texto(d.gravedad.origen)],
    ['detalle', 'STRING', (d) => texto(d.gravedad.detalle)],
    // `manual` avisa de que el enlace se escribio a mano y no se puede
    // reproducir cruzando identificadores.
    // Un aditivo puede tener efecto critico SIN tener IDA -son cuatro-, y
    // entonces `valor_via` no existe: la ruta del enlace la lleva
    // `critico_via`. Leer solo la primera dejaba esos cuatro en nulo.
    ['via_enlace', 'STRING',
     (d) => texto(d.gravedad.via === 'iarc' ? (d.iarc && d.iarc.via)
                : d.gravedad.via === 'clp' ? (d.clp && d.clp.via)
                : (d.oft && (d.oft.valor_via || d.oft.critico_via)))],
  ]);

  // --- prohibiciones y retiradas, una fila por jurisdiccion ----------------
  // Las secundarias de `tambien` se aplanan aqui: el bromato tiene ocho y
  // dejarlas anidadas las haria invisibles a una consulta.
  const proh = [];
  for (const p of D.prohibiciones) {
    proh.push({ ...p, principal: true });
    for (const t of p.tambien || []) {
      proh.push({ tag: p.tag, numero_e: p.numero_e, nombre: p.nombre,
                  tipo: p.tipo, ...t, principal: false });
    }
  }
  tabla(salida, 'prohibiciones', proh, [
    ['tag', 'STRING', (r) => r.tag],
    ['numero_e', 'STRING', (r) => texto(r.numero_e)],
    ['nombre', 'STRING', (r) => texto(r.nombre)],
    ['tipo', 'STRING', (r) => r.tipo],
    ['jurisdiccion', 'STRING', (r) => r.jurisdiccion],
    ['referencia', 'STRING', (r) => texto(r.referencia)],
    ['fecha', 'STRING', (r) => texto(r.fecha)],
    ['cumplimiento', 'STRING', (r) => texto(r.cumplimiento)],
    // La frase literal de la norma. Es lo que permite comprobar el veredicto
    // sin releer el reglamento entero, asi que va en el dato publicado.
    ['verbo', 'STRING', (r) => texto(r.verbo)],
    ['alcance', 'STRING', (r) => texto(r.alcance)],
    ['alcance_detalle', 'STRING', (r) => texto(r.alcance_detalle)],
    ['motivo', 'STRING', (r) => texto(r.motivo)],
    ['base_legal', 'STRING', (r) => texto(r.base_legal)],
    ['principal', 'BOOLEAN', (r) => r.principal],
  ]);

  // --- evidencia: una tabla por fuente -------------------------------------
  tabla(salida, 'oft', D.oft, [
    ['uuid', 'STRING', (d) => d._id],
    ['nombre', 'STRING', (d) => texto(d.nombre)],
    ['cas', 'STRING', (d) => texto(d.cas)],
    ['param_code', 'STRING', (d) => texto(d.param_code)],
    ['ida', 'DOUBLE', (d) => numero(d.valor?.ida)],
    ['ida_unidad', 'STRING', (d) => texto(d.valor?.unidad)],
    // BOOLEAN, no cadena. Venia del xlsx como "1", se arreglo en `oft.py`...
    // y aqui se volvia a convertir en texto con `texto()`, que hacia
    // String(true) = "true". Peor que antes: "true" invita a `Boolean(x)`, y
    // eso tambien daria true para la cadena "false" el dia que aparezca.
    ['sin_ida', 'BOOLEAN', (d) => (d.valor?.sin_ida == null ? null : !!d.valor.sin_ida)],
    ['sin_ida_motivo', 'STRING', (d) => texto(d.valor?.sin_ida_motivo)],
    ['sin_dosis_motivo', 'STRING', (d) => texto(d.sin_dosis_motivo)],
    ['incertidumbre', 'DOUBLE', (d) => numero(d.valor?.incertidumbre)],
    ['critico_toxicidad', 'STRING', (d) => texto(d.critico?.toxicidad)],
    ['critico_efecto', 'STRING', (d) => texto(d.critico?.efecto)],
    ['critico_especie', 'STRING', (d) => texto(d.critico?.especie)],
    ['critico_dosis', 'DOUBLE', (d) => numero(d.critico?.dosis)],
    ['critico_descriptor', 'STRING', (d) => texto(d.critico?.descriptor)],
    /*
     * Hallazgos de geno/carcinogenicidad de los expedientes de EFSA.
     *
     * `hallazgo` NO ES LA CONCLUSION DEL PANEL. Resume lo que reportaron los
     * ESTUDIOS del expediente, y puede decir lo contrario que el dictamen: el
     * indigo carmin (E132) sale `positivo` y ese mismo dictamen
     * —doi:10.2903/j.efsa.2023.8103— confirma su IDA de 5 mg/kg y concluye
     * que «no hay preocupacion de seguridad». Por eso no alimenta `gravedad`.
     *
     * COMO SE LEE SIN MENTIR: junto a `ida`. Un hallazgo positivo con IDA
     * vigente es «los estudios reportaron algo y EFSA mantiene una ingesta
     * admisible»; sin IDA, y con `sin_ida_motivo`, es preocupacion. Y eso no
     * es deduccion nuestra: cuando EFSA tiene esa preocupacion lo codifica,
     * `sin_ida_motivo = genotoxicidad`, y no asigna IDA.
     *
     * Los tres puntos finales llevan prefijo `hallazgo_` a proposito, para no
     * colisionar con el trio de `clp`, que es otra cosa —clasificacion legal
     * del Anexo VI— con los mismos nombres. Y no son booleanos: son el termino
     * literal de EFSA (Positive, Negative, Ambiguous, No data, Not determined,
     * Not applicable, Other), porque «negativo» y «nadie lo miro» no se pueden
     * meter en el mismo booleano sin perder justamente lo que aportan.
     */
    ['hallazgo', 'STRING', (d) => texto(d.genotox?.hallazgo)],
    // null = no hay ningun expediente. false = los hay y ninguno lo midio.
    ['estudiado', 'BOOLEAN', (d) => (d.genotox == null ? null : !!d.genotox.estudiado)],
    ['hallazgo_genotoxico', 'STRING', (d) => texto(d.genotox?.genotoxic)],
    ['hallazgo_mutagenico', 'STRING', (d) => texto(d.genotox?.mutagenic)],
    ['hallazgo_carcinogenico', 'STRING', (d) => texto(d.genotox?.carcinogenic)],
    ['hallazgo_fecha', 'STRING', (d) => texto(d.genotox?.fecha)],
    ['hallazgo_dictamen', 'STRING', (d) => texto(d.genotox?.dictamen)],
    ['hallazgo_doi', 'STRING', (d) => texto(d.genotox?.doi)],
    /*
     * Lo que fijo ESE MISMO dictamen, cuando lo fijo: 623 de 5.434. Son
     * hechos, no un juicio sintetizado. Se intento sintetizar uno y se cayo
     * solo: mapear el descriptor `margin of safety` a «preocupacion»
     * etiquetaba asi los dictamenes de 2004 y 2016 sobre el dioxido de
     * titanio, que concluyeron que era aceptable. Ese descriptor dice como se
     * expreso el valor de referencia, no lo que opina el panel.
     */
    ['ida_dictamen', 'DOUBLE', (d) => numero(d.genotox?.ida_dictamen)],
    ['sin_ida_motivo_dictamen', 'STRING',
     (d) => texto(d.genotox?.sin_ida_motivo_dictamen)],
    ['dictamenes_total', 'INT32', (d) => numero(d.genotox?.dictamenes)],
    // ¿Hay dictamenes en desacuerdo? Y cuales fueron los otros hallazgos.
    ['dictamenes_discrepan', 'BOOLEAN',
     (d) => (d.genotox == null ? null : !!d.genotox.discrepan)],
    ['hallazgos_previos', 'STRING', (d) => lista(d.genotox?.discrepan)],
  ]);

  /*
   * El historial: una fila por dictamen anterior.
   *
   * Sin esta tabla la columna `hallazgo` es un dato sin contexto. Con ella se
   * ve por que el dioxido de titanio cambio: negativo en 2004, 2016, 2018 y
   * 2019, positivo en 2021 —y fue ese ultimo el que llevo a retirarlo de la
   * lista de la Union—. Aplastar los seis dictamenes en uno daba la conclusion
   * contraria segun el orden en que se leyeran las filas.
   */
  const historial = [];
  for (const d of D.oft) {
    for (const h of d.genotox?.historial || []) {
      historial.push({ uuid: d._id, ...h });
    }
  }
  tabla(salida, 'oft_historial', historial, [
    ['uuid', 'STRING', (r) => r.uuid],
    ['fecha', 'STRING', (r) => texto(r.fecha)],
    // Mismo vocabulario que `oft.hallazgo`: positivo, ambiguo, negativo,
    // sin-dato.
    ['hallazgo', 'STRING', (r) => texto(r.hallazgo)],
    // El TITULO del dictamen, no un identificador. El identificador es el doi.
    ['dictamen', 'STRING', (r) => texto(r.titulo)],
    ['doi', 'STRING', (r) => texto(r.doi)],
    ['ida_dictamen', 'DOUBLE', (r) => numero(r.ida_dictamen)],
    ['sin_ida_motivo_dictamen', 'STRING', (r) => texto(r.sin_ida_motivo_dictamen)],
  ]);

  tabla(salida, 'iarc', D.iarc, [
    ['nombre', 'STRING', (d) => texto(d.nombre)],
    ['grupo', 'STRING', (d) => texto(d.grupo)],
    ['significado', 'STRING', (d) => texto(d.significado)],
    ['cas', 'STRING', (d) => lista(d.cas)],
    ['volumen', 'STRING', (d) => lista(d.volumen)],
    ['anio', 'STRING', (d) => texto(d.anio)],
    ['anio_evaluacion', 'INT32', (d) => numero(d.anio_evaluacion)],
    // 95 registros aclaran QUE abarca la clasificacion, y eso cambia como se
    // leen: el del talco dice que el termino incluye fibras asbestiformes.
    ['comentario', 'STRING', (d) => texto(d.comentario)],
    // Monografia anunciada pero sin publicar.
    ['en_preparacion', 'BOOLEAN', (d) => !!d.en_preparacion],
  ]);

  tabla(salida, 'clp', D.clp, [
    ['cas', 'STRING', (d) => texto(d.cas)],
    ['nombre', 'STRING', (d) => texto(d.nombre)],
    ['codigos', 'STRING', (d) => lista((d.clases || []).map((c) => c.codigo))],
    ['peor', 'STRING', (d) => texto(d.peor)],
    ['cancerigeno', 'BOOLEAN', (d) => !!d.cancerigeno],
    ['mutagenico', 'BOOLEAN', (d) => !!d.mutagenico],
    ['repro', 'BOOLEAN', (d) => !!d.repro],
  ]);

  tabla(salida, 'legal_ue', D.cellar, [
    ['numero_e', 'STRING', (d) => texto(d.numero_e)],
    ['nombre_reglamento', 'STRING', (d) => texto(d.nombre_reglamento)],
    ['autorizado', 'BOOLEAN', (d) => !!d.autorizado],
    ['via', 'STRING', (d) => texto(d.via)],
    ['listado_parte_b', 'BOOLEAN', (d) => !!d.listado_parte_b],
    ['retirado', 'BOOLEAN', (d) => !!d.retirado],
    ['caducado_el', 'STRING', (d) => texto(d.caducado_el)],
    /*
     * El estado en una sola palabra, para no obligar a nadie a combinar tres
     * booleanos y equivocarse. Los cuatro casos son distintos:
     *
     *   autorizado       esta en la parte E, o en un grupo de la C
     *   retirado         estaba y un acto lo saco, o su nota al pie caduco
     *   listado-sin-uso  sigue en la parte B pero sin uso alimentario. Es el
     *                    caso del E171 y del E161g: figuran porque colorean
     *                    medicamentos. `retirado` es false y eso confunde.
     *   ausente          no esta en el reglamento. NO es una prohibicion.
     */
    ['estado', 'STRING', (d) => (
      d.autorizado ? 'autorizado'
        : d.retirado ? 'retirado'
        : d.listado_parte_b ? 'listado-sin-uso'
        : 'ausente')],
    ['celex', 'STRING', (d) => texto(d.fuente?.celex)],
  ]);

  const eeuu = [
    ...D.fda.map((d) => ({ seccion: d.seccion, nombre: d.nombre, parte: 189,
                           alimentos: true, motivo: null })),
    ...D.cfr81.map((d) => ({ seccion: d.seccion, nombre: d.nombre, parte: 81,
                             alimentos: !!d.alimentos, motivo: d.motivo })),
  ];
  tabla(salida, 'legal_eeuu', eeuu, [
    ['seccion', 'STRING', (d) => d.seccion],
    ['nombre', 'STRING', (d) => texto(d.nombre)],
    ['parte', 'INT32', (d) => d.parte],
    ['alimentos', 'BOOLEAN', (d) => d.alimentos],
    ['motivo', 'STRING', (d) => texto(d.motivo)],
  ]);

  tabla(salida, 'exposicion', D.off, [
    ['tag', 'STRING', (d) => d._id],
    ['numero_e', 'STRING', (d) => texto(d.numero_e)],
    ['riesgo', 'STRING', (d) => texto(d.riesgo_sobreexposicion)],
    ['supera_media', 'STRING', (d) => lista(d.supera_ida_consumo_medio)],
    ['supera_p95', 'STRING', (d) => lista(d.supera_ida_percentil95)],
    ['vulnerables', 'STRING', (d) => lista(d.grupos_vulnerables_afectados)],
    ['anses', 'BOOLEAN', (d) => !!d.anses_vigilancia],
    ['dictamen_titulo', 'STRING', (d) => texto(d.dictamen?.titulo)],
    ['dictamen_fecha', 'STRING', (d) => texto(d.dictamen?.fecha)],
    ['dictamen_url', 'STRING', (d) => texto(d.dictamen?.url)],
  ]);

  const miembros = [];
  for (const f of D.familias) {
    for (const m of f.miembros || []) {
      miembros.push({ familia: f.tag, ...m });
    }
  }
  tabla(salida, 'familias', D.familias, [
    ['tag', 'STRING', (d) => d.tag],
    ['nombre', 'STRING', (d) => texto(d.nombre)],
    ['wikidata', 'STRING', (d) => texto(d.wikidata)],
    ['hereda_de', 'STRING', (d) => lista(d.heredado?.de)],
    ['revisar', 'STRING', (d) => lista(d.revisar)],
  ]);
  tabla(salida, 'familia_miembros', miembros, [
    ['familia', 'STRING', (r) => r.familia],
    ['tag', 'STRING', (r) => r.tag],
    ['nombre', 'STRING', (r) => texto(r.nombre)],
    ['wikidata', 'STRING', (r) => texto(r.wikidata)],
  ]);

  tabla(salida, 'motivos_retirada', D.motivos, [
    ['numero_e', 'STRING', (d) => texto(d.numero_e)],
    ['nombre', 'STRING', (d) => texto(d.nombre)],
    ['jurisdiccion', 'STRING', (d) => texto(d.jurisdiccion)],
    ['celex', 'STRING', (d) => texto(d.celex)],
    ['motivo', 'STRING', (d) => texto(d.motivo)],
  ]);

  // ------------------------------------------------------------- SQLite ----
  /*
   * Solo lo RESUELTO, y por tag, que es lo unico que sabe leer el scoring.
   * No lleva la evidencia: quien quiera saber de donde sale un nivel tiene el
   * Parquet. Aqui cabe el corte entero en unos cientos de kilobytes, asi que
   * no hay que trocear nada -el limite de 45 MB era para los catalogos de
   * producto, que son tres ordenes de magnitud mayores-.
   */
  console.log('\nSQLITE — el corte que baja el webapp\n');
  const rutaDb = join(salida, 'aditivos.sqlite3');
  try { unlinkSync(rutaDb); } catch { /* no existia */ }
  const db = new DatabaseSync(rutaDb);
  db.exec(`
    CREATE TABLE aditivo (
      tag TEXT PRIMARY KEY,
      numero_e TEXT, nombre TEXT, wikidata TEXT,
      nivel INTEGER, descripcion TEXT, certeza TEXT, via TEXT,
      ida REAL, posicion_en_nivel REAL, ida_sin_margen INTEGER,
      critico TEXT, sin_dosis_motivo TEXT,
      iarc TEXT, clp TEXT,
      legal_ue TEXT, retirado_ue INTEGER,
      riesgo_exposicion TEXT, vulnerables TEXT, anses INTEGER,
      prohibido INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE prohibicion (
      tag TEXT NOT NULL, jurisdiccion TEXT NOT NULL,
      referencia TEXT, fecha TEXT, verbo TEXT, alcance TEXT, tipo TEXT,
      penaliza INTEGER NOT NULL
    );
    CREATE INDEX prohibicion_tag ON prohibicion(tag);
  `);

  const insA = db.prepare(`INSERT OR REPLACE INTO aditivo VALUES
    (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insP = db.prepare(`INSERT INTO prohibicion VALUES (?,?,?,?,?,?,?,?)`);

  let nA = 0, nP = 0;
  for (const d of D.aditivos) {
    for (const t of d.enlaces?.off || []) {
      // Un tag puede estar reclamado por varios items -hay 135 asi-. Gana el
      // que trae datos: insertar el vacio encima borraria los del bueno.
      const tieneDatos = !!(d.gravedad || d.oft?.valor || d.iarc || d.clp ||
                            (d.prohibiciones || []).length);
      const ya = db.prepare('SELECT nivel, prohibido FROM aditivo WHERE tag=?').get(t.tag);
      if (ya && !tieneDatos) continue;

      const p = (d.prohibiciones || []).filter((x) => x.penaliza);
      insA.run(
        t.tag, texto(t.e_number), texto(t.nombre), d._id,
        d.gravedad?.nivel ?? null, texto(d.gravedad?.descripcion),
        texto(d.gravedad?.certeza), texto(d.gravedad?.via),
        numero(d.gravedad?.ida), numero(d.gravedad?.posicion_en_nivel),
        d.gravedad?.ida_sin_margen ? 1 : 0,
        texto(d.oft?.critico?.toxicidad), texto(d.oft?.sin_dosis_motivo),
        texto(d.iarc?.grupo), texto(d.clp?.peor),
        d.legal ? (d.legal.ausente ? 'ausente' : (d.legal.autorizado ? 'si' : 'no')) : null,
        d.legal?.retirado ? 1 : 0,
        texto(d.off?.riesgo), lista(d.off?.vulnerables), d.off?.anses ? 1 : 0,
        p.length ? 1 : 0,
      );
      nA++;
      for (const x of d.prohibiciones || []) {
        // Solo las que cubren ESTE tag. El resto son otra sustancia del mismo
        // item: la prohibicion del bromato potasico no alcanza al calcico.
        const cubre = x.cubre && x.cubre.length ? x.cubre : [x.tag];
        if (!cubre.includes(t.tag)) continue;
        insP.run(t.tag, x.jurisdiccion, texto(x.referencia), texto(x.fecha),
                 texto(x.verbo), texto(x.alcance), x.tipo, x.penaliza ? 1 : 0);
        nP++;
        for (const o of x.tambien || []) {
          insP.run(t.tag, o.jurisdiccion, texto(o.referencia), texto(o.fecha),
                   texto(o.verbo), texto(o.alcance), x.tipo, x.penaliza ? 1 : 0);
          nP++;
        }
      }
    }
  }
  db.exec('VACUUM');
  db.close();
  const kb = Math.round(statSync(rutaDb).size / 1024);

  // ------------------------------------------------------------ indice ----
  const indice = {
    generado: new Date().toISOString(),
    descripcion:
      'Base de peligro de aditivos alimentarios. Prohibicion y retirada son ' +
      'cosas distintas: ver la columna tipo de prohibiciones, y estado en legal_ue.',
    base: 'https://raw.githubusercontent.com/jmtt89/veskan-data/aditivos/',
    formato: 'parquet',
    licencias: {
      wikidata: 'CC0', 'open-food-facts': 'ODbL-1.0',
      'efsa-openfoodtox': 'CC-BY-ND',
      'legislacion-ue': 'Decision 2011/833/UE',
      'regulacion-eeuu': 'dominio publico', iarc: 'atribucion',
    },
    tablas: Object.fromEntries(TABLAS.map((t) => [t.nombre, t])),
    total_bytes: TABLAS.reduce((a, t) => a + t.bytes, 0),
    total_filas: TABLAS.reduce((a, t) => a + t.filas, 0),
    sqlite: {
      fichero: 'aditivos.sqlite3', bytes: statSync(rutaDb).size,
      nota: 'corte resuelto por numero E que consume la aplicacion; sin la evidencia',
    },
  };
  writeFileSync(join(salida, 'index.json'), JSON.stringify(indice, null, 2) + '\n');
  console.log(`\n   ${'index.json'.padEnd(22)}${TABLAS.length} tablas · ` +
              `${indice.total_filas} filas · ` +
              `${Math.round(indice.total_bytes / 1024)} KB`);
  console.log(`   aditivo               ${String(nA).padStart(6)} filas`);
  console.log(`   prohibicion           ${String(nP).padStart(6)} filas`);
  console.log(`   ${'aditivos.sqlite3'.padEnd(22)}${String(kb).padStart(13)} KB`);
}

const dirJsonl = process.argv[2];
if (!dirJsonl) {
  console.error('uso: npm run aditivos:publicar -- <dir-jsonl> [dir-salida]');
  process.exit(1);
}
main(dirJsonl, process.argv[3] ?? 'data/aditivos');
