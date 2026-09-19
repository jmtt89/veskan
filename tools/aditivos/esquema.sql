-- Base de aditivos de Veskan.
--
-- Se indexa por el tag de Open Food Facts (`en:e415`), que es la clave con la
-- que llegan los aditivos de un producto. Todo lo demas cuelga de ahi.
--
-- DECISION CENTRAL: la clasificacion es DERIVADA, no primaria. Cada veredicto
-- se sostiene en filas de `evidencia`, cada una con su fuente y su enlace. Sin
-- eso acabariamos como las aplicaciones que dan una nota y no pueden decir de
-- donde sale -- que es justo lo que no queremos ser.
--
-- Datos derivados de la taxonomia de Open Food Facts (ODbL-1.0). Evidencia
-- cientifica de EFSA y otras fuentes, citada en `fuentes`.

CREATE TABLE fuentes (
  id        TEXT PRIMARY KEY,   -- 'efsa-oft', 'off-taxonomy', 'eu-1333', 'anses'
  nombre    TEXT NOT NULL,
  version   TEXT,               -- version o fecha del conjunto usado
  url       TEXT,
  licencia  TEXT,
  obtenido  TEXT                -- cuando lo descargamos
);

CREATE TABLE evidencia (
  tag       TEXT NOT NULL,      -- en:e415
  fuente    TEXT NOT NULL REFERENCES fuentes(id),
  -- que tipo de hallazgo es: 'ida', 'sobreexposicion', 'autorizacion',
  -- 'genotoxicidad', 'vigilancia', 'dictamen'
  tipo      TEXT NOT NULL,
  valor     TEXT,               -- el hallazgo, tal como lo dice la fuente
  unidad    TEXT,
  anio      TEXT,
  url       TEXT,               -- enlace al documento concreto
  nota      TEXT                -- una frase, no el documento entero
);

CREATE INDEX idx_evidencia_tag ON evidencia(tag);

CREATE TABLE aditivos (
  tag       TEXT PRIMARY KEY,
  e_number  TEXT,
  nombre_es TEXT,
  nombre_en TEXT,
  -- Nuestra clasificacion. Derivada de `evidencia` por reglas documentadas.
  clase     TEXT,               -- 'alto' | 'moderado' | 'bajo' | 'ninguno' | 'sin-datos' | 'prohibido'
  -- En que se apoya, en corto: 'EFSA 2017 sin IDA necesaria; ANSES no lo marca'
  base      TEXT,
  resumen   TEXT,               -- una frase para el usuario
  revisado  TEXT                -- cuando lo revisamos nosotros
);

-- Metadatos de la propia base, como en los catalogos de pais.
CREATE TABLE meta (clave TEXT PRIMARY KEY, valor TEXT);
