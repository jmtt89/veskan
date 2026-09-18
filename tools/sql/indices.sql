-- Indices, DESPUES de cargar.
--
-- No se indexa `code` en las hijas: su clave primaria ya empieza por
-- `producto_id`, asi que un indice suelto sobre esa columna seria una copia
-- inutil. Medido: eran 90 MB en una carga de prueba de 25.000 productos.
CREATE INDEX IF NOT EXISTS producto_nova_idx        ON producto (nova_group)       WHERE nova_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS producto_grade_idx       ON producto (nutriscore_grade) WHERE nutriscore_grade IS NOT NULL;
CREATE INDEX IF NOT EXISTS producto_popularidad_idx ON producto (popularidad);
CREATE INDEX IF NOT EXISTS producto_modificado_idx  ON producto (modificado);
CREATE INDEX IF NOT EXISTS producto_lang_idx        ON producto (lang);

-- El camino inverso: de un termino a los productos que lo llevan. Es la
-- consulta util ("productos de este pais", "que llevan este aditivo").
CREATE INDEX IF NOT EXISTS etiqueta_inverso_idx     ON etiqueta (valor_id, producto_id);
CREATE INDEX IF NOT EXISTS nutriente_inverso_idx    ON nutriente (nutriente_id, origen);
CREATE INDEX IF NOT EXISTS propiedad_inverso_idx    ON propiedad (clave_id);
CREATE INDEX IF NOT EXISTS ingrediente_id_idx       ON ingrediente (id);
CREATE INDEX IF NOT EXISTS nova_marcador_valor_idx  ON nova_marcador (valor);

ANALYZE;
