# Esquema real de `off.products`

Inferido sobre el volcado MongoDB completo de Open Food Facts del 17 de
septiembre de 2026: **4.753.871 documentos**, sin muestreo.

No es el esquema que Open Food Facts documenta, sino el que la colección tiene
de hecho, con sus incoherencias. La diferencia importa: un lector escrito contra
la documentación se rompe con los casos de abajo.

Cómo reproducirlo y por qué cada consulta está escrita así: `05-analisis-mongodb.md`.

---

## Lo primero: hay 189.111 nombres de campo, y 187.093 son basura

Contar campos distintos da una cifra que asusta y que no significa nada.

| capa | campos | |
|---|---|---|
| **Núcleo** | **36** (≥99,9%) + **35** (99–99,9%) | el contrato de hecho |
| Opcionales | ~400 (0,01–99%) | campos legítimos, no universales |
| **Residuo OCR** | **187.093** (98,9% del total) | `..._ocr_<timestamp>` y `..._ocr_<timestamp>_result` |

Open Food Facts escribe **dos campos de primer nivel por cada pasada de OCR**,
sobre cada imagen y en cada idioma, con la marca de tiempo Unix en el propio
nombre del campo, y no borra los anteriores:

```
ingredients_text_en_ocr_1700817279
ingredients_text_en_ocr_1700817279_result
ingredients_text_fr_ocr_1550241159
ingredients_text_fr_ocr_1550241159_result
```

93.523 del primer tipo y 93.570 del segundo. **Todo consumidor debe ignorar
`*_ocr_*`.** Sin ese filtro, cualquier análisis del esquema es inútil.

Distribución completa por frecuencia:

| presencia | campos |
|---|---|
| ≥ 99,9% | 36 |
| 99 – 99,9% | 35 |
| 90 – 99% | 6 |
| 50 – 90% | 31 |
| 10 – 50% | 124 |
| 1 – 10% | 93 |
| 0,1 – 1% | 142 |
| 0,01 – 0,1% | 246 |
| **< 0,01%** | **188.398** |

---

## Una sola forma de documento

`product_type` vale `food` en **4.753.697 documentos (100,00%)** y falta en 174.
No hay mezcla de cosmética, mascotas ni otros productos: **la colección no tiene
variantes de esquema por tipo**. Lo que sí tiene es una cola de campos
opcionales y una minoría de documentos rotos.

---

## Núcleo: los 36 campos universales (≥99,9%)

Todos con un único tipo salvo donde se indica.

| campo | tipo |
|---|---|
| `code` | string |
| `_id` | string *(52 excepciones, ver abajo)* |
| `id` | string |
| `product_type` | string |
| `lang`, `lc` | string |
| `languages`, `languages_codes` | object |
| `languages_tags`, `languages_hierarchy` | array |
| `created_t`, `last_modified_t`, `last_updated_t` | int |
| `creator`, `last_modified_by`, `last_editor` | string *(+ null)* |
| `rev` | int *(+ string)* |
| `complete` | int |
| `completeness` | double *(+ int)* |
| `popularity_key` | int *(+ long)* |
| `states`, `states_tags` | string / array |
| `_keywords`, `misc_tags`, `codes_tags` | array |
| `editors_tags`, `informers_tags`, `checkers_tags`, `correctors_tags`, `photographers_tags` | array |
| `entry_dates_tags`, `last_edit_dates_tags` | array |
| `main_countries_tags`, `added_countries_tags`, `removed_countries_tags` | array |
| `interface_version_created` | string |

Y los 35 del tramo 99–99,9%, que en la práctica también se pueden dar por
presentes: `countries_tags`, `allergens_tags`, `traces_tags`, los cinco
`data_quality_*_tags`, `packagings` y los cuatro `packaging*`, `nutrient_levels`
y `nutrient_levels_tags`, los `pnns_groups_*`, `food_groups_tags`,
`categories_properties` y `categories_properties_tags`, `nova_groups_tags`,
`nova_group_debug`, `nutrition_score_debug`, `nutrition_score_beverage`,
`nutrition_grade_fr`, `nutrition_grades`, `nutrition_grades_tags`,
`nutriscore`, `nutriscore_grade`, `nutriscore_version`, `nutriscore_tags`,
`nutriscore_2021_tags`, `nutriscore_2023_tags`.

---

## Documentos que no cumplen

Dos criterios, ambos derivados de los datos y no de un juicio previo: **falta un
campo que tiene el ≥99,9% de la colección**, o **el tipo difiere del dominante
de ese campo**.

### Por campos ausentes: 1.710 documentos (0,036%)

| campos que faltan | documentos |
|---|---|
| 1 | 1.060 |
| 2 | 580 |
| 4 | 33 |
| 5 | 12 |
| 6 | 15 |
| 7 | 6 |
| **19 – 25** | **4** |

Los más ausentes:

```
1423  interface_version_created      174  product_type
 531  id                             165  last_updated_t
  70  main_countries_tags             37  popularity_key
  70  added_countries_tags            24  completeness
  70  removed_countries_tags          10  misc_tags
```

`interface_version_created` explica el 83% de los casos y está en el 99,97%:
está justo en el borde del umbral. Los cuatro documentos a los que les faltan de
19 a 25 campos sí son restos rotos de verdad.

### Por tipo: números guardados como cadena

Este es el que rompe lectores, y no es marginal:

| campo | tipo dominante | desviaciones |
|---|---|---|
| `serving_quantity` | double ×571.827 | **string ×425.330**, null ×23.678, long ×3 |
| `product_quantity` | int ×782.822 | **string ×151.407**, double ×512.315 |
| `unknown_ingredients_n` | double ×921.425 | **string ×30.805**, int ×364.815 |
| `ingredients_n` | double ×924.316 | **string ×5.134**, int ×387.576 |
| `max_imgid` | string ×3.003.623 | int ×563.001, double ×26.948 |
| `nova_group` | int ×1.161.309 | string ×3 |
| `nutriscore_score` | int ×1.408.064 | string ×2, double ×8 |
| `popularity_key` | int ×4.498.283 | long ×255.551 |

**Ningún campo numérico se puede leer asumiendo que es numérico.**

### El caso más grave: 52 claves primarias rotas

50 documentos tienen `_id` como **entero de 64 bits** en vez de cadena, más uno
`null` y uno `int`:

```
_id = Long("7340011495437")   code = "7340011495437"
_id = null                    code = ""
```

Es el código de barras interpretado como número. Son además de los 174 que
carecen de `product_type`. Un `_id` numérico y el mismo código como cadena
**pueden coexistir**: quien indexe por `_id` debe normalizar a cadena.

---

## Reglas para quien lea esta colección

1. **Filtrar `*_ocr_*`** antes de cualquier recorrido de campos.
2. **No fiarse del tipo de ningún campo numérico**: convertir siempre, tolerando
   cadena, int, long, double y null.
3. **Normalizar `_id` a cadena**, o usar `code`, que sí es string en el 100%.
4. **Tratar como opcional todo lo que no esté en los 71 del núcleo**, incluida
   la nutrición: `nutriments` puede venir vacío.
5. La documentación oficial describe un contrato más limpio que el que el
   volcado cumple. Ante discrepancia, mandan los datos.

---

## Resultados materializados

Para no repetir barridos de ~6 minutos:

| colección | qué contiene |
|---|---|
| `off.esquema_campos` | 189.111 documentos: campo → presencia total y recuento por tipo |
| `off.no_conformes` | 1.710 documentos: `code`, `idNoCadena`, `faltan[]` |

Ambas son pequeñas, caben en caché y admiten índices propios — el límite de 64
índices es por colección y `off.products` ya lo agotó.

Datos de Open Food Facts bajo licencia ODbL-1.0.
