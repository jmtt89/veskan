-- EXPERIMENTAL, SOLO PARA INVESTIGACION. No forma parte de la aplicacion ni
-- de la tuberia de datos. Ver docs/06-esquema-off.md.

-- Equivalencia relacional de la coleccion `off.products` de Open Food Facts.
--
-- SQLite, como todo el proyecto: los catalogos publicados son SQLite, el
-- navegador los lee con WASM y `better-sqlite3` ya es dependencia. Un servidor
-- aparte anadiria un motor mas y credenciales para nada; asi la tuberia puede
-- leer de aqui directamente con ATTACH. PostgreSQL seria mas rapido en las
-- consultas analiticas pesadas, y esa es la contrapartida que se acepta.
--
-- Se normaliza TODO lo que se puede equiparar. Nada de JSON: si hiciera falta
-- una columna JSON seria senal de no haber terminado de normalizar.
--
-- Dos decisiones que salieron de medir una carga de prueba, donde el 55% del
-- fichero eran indices y no datos:
--
--   * Clave sustituta entera. El codigo de barras son 13 caracteres y aparecia
--     en unas 374 filas hijas por producto, mas otra vez en cada indice.
--   * Vocabulario aparte. `'en:spain'`, `'categories'`, `'energy-kj'` se
--     repetirian cientos de millones de veces. Como tabla de terminos, cada
--     aparicion es un entero. Es la definicion de normalizar, y aqui vale la
--     diferencia entre 305 GB y algo manejable.
--
-- Las tablas hijas van WITHOUT ROWID: su clave primaria ES la fila, asi que
-- guardarla ademas en un indice aparte -que es lo que hace SQLite por defecto-
-- duplicaba todas ellas.
--
-- El modelo no sale campo por campo -serian 189.111- sino por FAMILIA DE FORMA.
-- Medido sobre el volcado completo, los 145 campos de primer nivel que importan
-- se reducen a nueve formas: escalar, texto por idioma, texto de OCR, lista
-- plana de etiquetas, mapa clave-valor, nutriente, ingrediente anidado, imagen
-- y fila de una lista de objetos. Cada forma es una tabla.
--
-- Ver docs/06-esquema-off.md para como se midio.
-- Datos de Open Food Facts bajo licencia ODbL-1.0. Lo derivado hereda ODbL.

DROP TABLE IF EXISTS carga_tabla;
DROP TABLE IF EXISTS nutriscore_componente;
DROP TABLE IF EXISTS nutriscore_version;
DROP TABLE IF EXISTS nova_marcador;
DROP TABLE IF EXISTS nivel_nutriente;
DROP TABLE IF EXISTS fuente_campo;
DROP TABLE IF EXISTS fuente;
DROP TABLE IF EXISTS imagen_tamano;
DROP TABLE IF EXISTS imagen;
DROP TABLE IF EXISTS envase;
DROP TABLE IF EXISTS ingrediente;
DROP TABLE IF EXISTS idioma_producto;
DROP TABLE IF EXISTS propiedad;
DROP TABLE IF EXISTS nutriente;
DROP TABLE IF EXISTS etiqueta;
DROP TABLE IF EXISTS ocr;
DROP TABLE IF EXISTS texto;
DROP TABLE IF EXISTS producto;
DROP TABLE IF EXISTS vocabulario;
DROP TABLE IF EXISTS carga;

-- De que noche es lo que hay aqui.
CREATE TABLE carga (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  origen        TEXT        NOT NULL,
  iniciada      INTEGER NOT NULL,
  terminada     INTEGER,
  notas         TEXT
);

-- El recuento por tabla es una relacion, no un documento.
CREATE TABLE carga_tabla (
  carga_id INTEGER NOT NULL REFERENCES carga(id) ON DELETE CASCADE,
  tabla    TEXT    NOT NULL,
  filas    INTEGER NOT NULL,
  PRIMARY KEY (carga_id, tabla)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 1. Escalares
-- ---------------------------------------------------------------------------

-- Terminos que se repiten: valores de etiqueta, nombres de nutriente, ambitos
-- y claves de propiedad, identificadores de ingrediente. Se guardan una vez.
CREATE TABLE vocabulario (
  id    INTEGER PRIMARY KEY,
  clase TEXT NOT NULL,   -- tag | tipo | nutriente | unidad | fuente | ambito | clave | campo | idioma | ingrediente
  valor TEXT NOT NULL
);
CREATE UNIQUE INDEX vocabulario_unico ON vocabulario (clase, valor);

CREATE TABLE producto (
  id                  INTEGER PRIMARY KEY,
  -- `code` y no `_id`: 52 documentos guardan `_id` como entero de 64 bits -el
  -- codigo de barras interpretado como numero- y uno como nulo. `code` es
  -- cadena en el 100% de la coleccion.
  code                TEXT NOT NULL UNIQUE,
  lang                TEXT,
  lc                  TEXT,
  tipo_producto       TEXT,

  -- Mejor variante disponible, ya resuelta. El detalle por idioma en `texto`.
  nombre              TEXT,
  nombre_idioma       TEXT,
  ingredientes        TEXT,
  ingredientes_idioma TEXT,
  marcas              TEXT,

  cantidad            TEXT,      -- del envase: "375 g (284,1 ml)"
  cantidad_g          REAL,   -- `product_quantity`, convertido
  racion              TEXT,      -- `serving_size`
  racion_g            REAL,   -- `serving_quantity`, convertido

  -- Base de los valores sin sufijo de `nutriments`.
  nutricion_base      TEXT CHECK (nutricion_base IN ('100g','serving')),
  nutricion_base_prep TEXT CHECK (nutricion_base_prep IN ('100g','serving')),
  sin_tabla           INTEGER NOT NULL DEFAULT 0,

  nova_group          INTEGER CHECK (nova_group BETWEEN 1 AND 4),
  nutriscore_grade    TEXT  CHECK (nutriscore_grade IN ('a','b','c','d','e')),
  nutriscore_score    INTEGER,
  nutriscore_version  TEXT,
  nutrition_grade_fr  TEXT,
  pnns_grupo_1        TEXT,
  pnns_grupo_2        TEXT,
  ecoscore_grade      TEXT,
  ecoscore_score      INTEGER,

  -- Banderas que necesita el Nutri-Score, ya resueltas por Open Food Facts.
  es_bebida           INTEGER NOT NULL DEFAULT 0,
  es_agua             INTEGER NOT NULL DEFAULT 0,
  es_queso            INTEGER NOT NULL DEFAULT 0,
  es_grasa_frutos     INTEGER NOT NULL DEFAULT 0,
  es_carne_roja       INTEGER NOT NULL DEFAULT 0,

  creado              INTEGER,
  modificado          INTEGER,
  actualizado         INTEGER,
  revision            INTEGER,
  creador             TEXT,
  ultimo_editor       TEXT,
  escaneos            INTEGER,   -- `unique_scans_n`
  popularidad         INTEGER,    -- `popularity_key`
  completitud         REAL,
  completo            INTEGER,
  aditivos_n          INTEGER,
  ingredientes_n      INTEGER,
  ingredientes_desconocidos_n INTEGER,

  -- Lo que no cumplia el esquema en origen, conservado en vez de descartado.
  id_no_era_cadena    INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 2. Textos por idioma
-- ---------------------------------------------------------------------------

-- Un producto puede tener SOLO la variante de su idioma: con columnas fijas se
-- perdia, y de hecho se perdia. `idioma = ''` es la variante principal.
CREATE TABLE texto (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  campo_id    INTEGER NOT NULL REFERENCES vocabulario(id),
  idioma_id   INTEGER NOT NULL REFERENCES vocabulario(id),
  valor       TEXT    NOT NULL,
  PRIMARY KEY (producto_id, campo_id, idioma_id)
) WITHOUT ROWID;

-- Open Food Facts escribe dos campos de primer nivel por cada pasada de OCR,
-- con la marca de tiempo en el NOMBRE del campo, y no borra los anteriores:
-- 187.093 nombres distintos. Aqui la marca de tiempo es una columna, que es lo
-- que deberia haber sido siempre.
CREATE TABLE ocr (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  campo_id    INTEGER NOT NULL REFERENCES vocabulario(id),
  idioma_id   INTEGER NOT NULL REFERENCES vocabulario(id),
  ejecutado   INTEGER NOT NULL,
  texto       TEXT,
  resultado   TEXT,
  PRIMARY KEY (producto_id, campo_id, idioma_id, ejecutado)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 3. Listas planas de etiquetas
-- ---------------------------------------------------------------------------

-- Las 120 listas de cadenas -`*_tags`, `*_hierarchy`, `editors`...- comparten
-- forma exacta. Una tabla por cada una no anadiria informacion: anadiria 120
-- tablas identicas.
CREATE TABLE etiqueta (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  tipo_id     INTEGER NOT NULL REFERENCES vocabulario(id),
  orden       INTEGER NOT NULL,   -- el orden importa en las jerarquias
  valor_id    INTEGER NOT NULL REFERENCES vocabulario(id),
  PRIMARY KEY (producto_id, tipo_id, orden)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 4. Nutrientes
-- ---------------------------------------------------------------------------

-- Como filas y no como columnas porque Open Food Facts los guarda en tres
-- sitios a la vez y anade nutrientes nuevos con regularidad. Cada fila dice de
-- donde salio, asi que se puede desconfiar de una fuente sin recargar nada.
CREATE TABLE nutriente (
  producto_id  INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  nutriente_id INTEGER NOT NULL REFERENCES vocabulario(id),
  base         TEXT    NOT NULL CHECK (base IN ('100g','serving','declarado')),
  origen       TEXT    NOT NULL CHECK (origen IN
              ('aggregated_set','nutriments_100g','nutriments_base','nutriscore_data','estimado')),
  valor        REAL    NOT NULL,
  unidad_id    INTEGER REFERENCES vocabulario(id),
  -- Procedencia declarada por Open Food Facts: un valor estimado no es un valor
  -- de etiqueta.
  fuente_id    INTEGER REFERENCES vocabulario(id),
  preparado    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (producto_id, nutriente_id, base, origen, preparado)
) WITHOUT ROWID;

CREATE TABLE nivel_nutriente (
  producto_id  INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  nutriente_id INTEGER NOT NULL REFERENCES vocabulario(id),
  nivel        TEXT    NOT NULL CHECK (nivel IN ('low','moderate','high')),
  PRIMARY KEY (producto_id, nutriente_id)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 5. Nutri-Score, por version
-- ---------------------------------------------------------------------------

CREATE TABLE nutriscore_version (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  version     TEXT    NOT NULL,          -- '2021' | '2023'
  score       INTEGER,
  grade       TEXT,
  aplicable   INTEGER,
  calculado   INTEGER,
  estimado    INTEGER,
  preparacion TEXT,
  es_bebida   INTEGER,
  es_agua     INTEGER,
  es_queso    INTEGER,
  es_grasa_frutos INTEGER,
  es_carne_roja   INTEGER,
  puntos_negativos INTEGER,
  puntos_positivos INTEGER,
  cuenta_proteinas INTEGER,
  cuenta_proteinas_motivo TEXT,
  PRIMARY KEY (producto_id, version)
) WITHOUT ROWID;

CREATE TABLE nutriscore_componente (
  producto_id INTEGER NOT NULL,
  version     TEXT NOT NULL,
  lado        TEXT NOT NULL CHECK (lado IN ('positive','negative')),
  componente  TEXT NOT NULL,             -- energy, sugars, salt, ...
  valor       REAL,
  unidad      TEXT,
  puntos      INTEGER,
  puntos_max  INTEGER,
  PRIMARY KEY (producto_id, version, lado, componente),
  FOREIGN KEY (producto_id, version) REFERENCES nutriscore_version(producto_id, version) ON DELETE CASCADE
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 6. Ingredientes, con su anidamiento
-- ---------------------------------------------------------------------------

-- Los ingredientes se anidan: un compuesto lleva dentro su propia lista. La
-- jerarquia se guarda con `ruta` ('0.2.1') y `padre`, que permite reconstruir
-- el arbol con una consulta recursiva y ordenar por posicion real.
CREATE TABLE ingrediente (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  ruta             TEXT NOT NULL,
  padre            TEXT,
  profundidad      INTEGER NOT NULL,
  orden            INTEGER NOT NULL,
  id               TEXT,                 -- 'en:sugar'
  texto            TEXT,                 -- tal y como lo escribe el envase
  porcentaje       REAL,
  porcentaje_min   REAL,
  porcentaje_max   REAL,
  porcentaje_est   REAL,              -- `percent_estimate`
  cantidad_est     REAL,              -- `quantity_estimate`
  vegano           TEXT CHECK (vegano IN ('yes','no','maybe')),
  vegetariano      TEXT CHECK (vegetariano IN ('yes','no','maybe')),
  del_aceite_palma TEXT,
  procesamiento    TEXT,
  en_taxonomia     INTEGER,
  ciqual_code      TEXT,
  ciqual_proxy_code TEXT,
  ecobalyse_code   TEXT,
  PRIMARY KEY (producto_id, ruta)
) WITHOUT ROWID;

-- Marcadores que llevaron a un grupo NOVA: {"4": [["additives","en:e322"], ...]}
CREATE TABLE nova_marcador (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  grupo  INTEGER NOT NULL CHECK (grupo BETWEEN 1 AND 4),
  tipo   TEXT     NOT NULL,   -- additives | ingredients | categories
  valor  TEXT     NOT NULL,
  PRIMARY KEY (producto_id, grupo, tipo, valor)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 7. Imagenes
-- ---------------------------------------------------------------------------

CREATE TABLE imagen (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  clase     TEXT NOT NULL CHECK (clase IN ('selected','uploaded')),
  tipo      TEXT NOT NULL,   -- front | ingredients | nutrition | packaging | <imgid>
  idioma    TEXT NOT NULL,   -- '' en las subidas, que no tienen idioma
  imgid     TEXT,
  revision  TEXT,
  subida    INTEGER,
  subida_por TEXT,
  PRIMARY KEY (producto_id, clase, tipo, idioma)
) WITHOUT ROWID;

CREATE TABLE imagen_tamano (
  producto_id INTEGER NOT NULL,
  clase  TEXT NOT NULL,
  tipo   TEXT NOT NULL,
  idioma TEXT NOT NULL,
  tamano TEXT NOT NULL,      -- 100 | 200 | 400 | full
  ancho  INTEGER,
  alto   INTEGER,
  PRIMARY KEY (producto_id, clase, tipo, idioma, tamano),
  FOREIGN KEY (producto_id, clase, tipo, idioma) REFERENCES imagen(producto_id, clase, tipo, idioma) ON DELETE CASCADE
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 8. Envases
-- ---------------------------------------------------------------------------

CREATE TABLE envase (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  orden             INTEGER NOT NULL,
  forma             TEXT,
  material          TEXT,
  reciclaje         TEXT,
  contacto_alimento INTEGER,
  unidades          INTEGER,
  cantidad_unidad   TEXT,
  cantidad_valor    REAL,
  cantidad_unidad_medida TEXT,
  peso_medido       REAL,
  peso_estimado     REAL,
  peso_especificado REAL,
  PRIMARY KEY (producto_id, orden)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 9. Procedencia de los datos importados
-- ---------------------------------------------------------------------------

CREATE TABLE fuente (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  orden       INTEGER NOT NULL,
  id          TEXT,
  nombre      TEXT,
  url         TEXT,
  fabricante  INTEGER,
  importado   INTEGER,
  licencia    TEXT,
  PRIMARY KEY (producto_id, orden)
) WITHOUT ROWID;

CREATE TABLE fuente_campo (
  producto_id INTEGER NOT NULL,
  orden INTEGER NOT NULL,
  campo TEXT     NOT NULL,
  PRIMARY KEY (producto_id, orden, campo),
  FOREIGN KEY (producto_id, orden) REFERENCES fuente(producto_id, orden) ON DELETE CASCADE
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 10. Idiomas del producto
-- ---------------------------------------------------------------------------

-- `languages` cuenta cuantos campos hay en cada idioma.
CREATE TABLE idioma_producto (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  idioma TEXT NOT NULL,      -- 'en:spanish' o 'es', segun la forma
  codigo INTEGER NOT NULL,   -- true si viene de `languages_codes`
  campos INTEGER NOT NULL,
  PRIMARY KEY (producto_id, idioma, codigo)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 11. Atributos heterogeneos
-- ---------------------------------------------------------------------------

-- Los 25 objetos restantes -`environmental_score_data`, `categories_properties`,
-- `data_quality_dimensions`, `recipe_estimator`...- son mapas clave-valor con
-- claves distintas en cada producto y que Open Food Facts cambia a menudo.
--
-- Una tabla por cada uno seria inmantenible y se quedaria vieja en la siguiente
-- version; una columna JSON renunciaria a poder consultarlos. Van como
-- atributos con su ambito, que SI se une y se filtra con SQL corriente. El
-- valor se guarda ademas como numero cuando lo es, para no tener que convertir
-- en cada consulta.
CREATE TABLE propiedad (
  producto_id INTEGER NOT NULL REFERENCES producto(id) ON DELETE CASCADE,
  ambito_id   INTEGER NOT NULL REFERENCES vocabulario(id),
  clave_id    INTEGER NOT NULL REFERENCES vocabulario(id),
  valor       TEXT,
  valor_num   REAL,
  PRIMARY KEY (producto_id, ambito_id, clave_id)
) WITHOUT ROWID;

-- SQLite no tiene tipos estrictos por defecto; con STRICT los tendria, pero
-- rechaza REAL en columnas INTEGER y Open Food Facts mezcla ambos. Se prefiere
-- cargar el dato y que el CHECK vigile los dominios cerrados.
