-- Rebanada de OpenFoodTox. Una categoria de la base de peligros de EFSA.
CREATE TABLE sustancias (uuid TEXT PRIMARY KEY, nombre TEXT NOT NULL);
CREATE TABLE valores (
  sustancia TEXT REFERENCES sustancias(uuid),
  ida TEXT, unidad TEXT, sin_ida TEXT, incertidumbre TEXT,
  endpoint_critico TEXT, poblacion TEXT
);
CREATE TABLE estudios (
  uuid TEXT PRIMARY KEY, sustancia TEXT REFERENCES sustancias(uuid),
  tipo TEXT, toxicidad TEXT, efecto TEXT, especie TEXT
);
CREATE INDEX idx_valores_sustancia ON valores(sustancia);
CREATE INDEX idx_estudios_sustancia ON estudios(sustancia);
CREATE INDEX idx_estudios_critico ON estudios(uuid);
