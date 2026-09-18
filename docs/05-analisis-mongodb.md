# Analizar el volcado de Open Food Facts con MongoDB

Open Food Facts publica un `mongodump` real
(`openfoodfacts-mongodbdump.gz`, 15,7 GB) además del JSONL. Para **investigar**
—no para construir los catálogos— restaurarlo en local es la vía correcta: una
pregunta que en streaming cuesta 50 minutos y 12 GB de descarga se responde aquí
en minutos y sin red.

```bash
curl -fsSL https://static.openfoodfacts.org/data/openfoodfacts-mongodbdump.gz \
  | docker exec -i <contenedor> mongorestore --archive --gzip --drop
```

Crea la base `off` con la colección `products`. No colisiona con nada existente.

La **tubería de datos sigue usando el JSONL en streaming**, y eso es correcto:
GitHub Actions no tiene MongoDB y es una sola pasada.

---

## Perfil real de esta instancia

Medido, no estimado. Todo lo de abajo depende de estos números.

| | |
|---|---|
| mongod | 8.0.6 |
| Documentos | 4.753.871 |
| Tamaño medio de documento | **18,4 kB** |
| Datos sin comprimir | 85,5 GB |
| En disco | 33,2 GB (Snappy, ~2,6×) |
| Caché WiredTiger | **11,15 GB** |
| RAM del host | 23 GB |
| Índices | 8,8 GB en **64** |

**La caché cabe el 13% de los datos.** Cualquier barrido completo desaloja la
caché y lee de disco. Un `$group` sobre toda la colección tarda ~6 minutos y no
va a bajar de ahí por mucho que se afine la consulta.

---

## Límites que aquí duelen de verdad

Citas del manual, con lo que implican en este caso.

### La colección está en el máximo de índices

> *"A single collection can have no more than 64 indexes."*

`off.products` tiene **exactamente 64**. Comprobado:

```
CannotCreateIndex :: add index fails, too many indexes for off.products
```

**No se puede indexar nada nuevo.** O la consulta encaja en un índice existente
—`code`, `countries_tags`, `states_tags`, `nova_groups_tags`,
`ingredients_tags`, `popularity_key`, `unique_scans_n`, `last_modified_t`— o es
un barrido completo. No hay tercera opción sobre esta colección.

### 100 MB por etapa bloqueante, y 16 MB de salida

> *"Pipeline stages requiring more than 100 megabytes of memory write temporary
> files to disk by default."* — y con `allowDiskUse: false` fallan.

`$group`, `$sort` y `$facet` son bloqueantes. Con 4,75 M de documentos casi
cualquier `$group` interesante los pasa: **`allowDiskUse: true` siempre**.

Y el que más muerde:

> *"The final output document is subject to the 16 mebibyte BSON document size
> limit."*

`$facet` devuelve **un solo documento** con todos los resultados dentro. Un
`$facet` que agrupe por clave sobre `nutriments` —miles de claves distintas—
revienta por los 16 MB aunque cada sub-pipeline respete sus 100 MB. Hay que
recortar dentro de cada rama (`$match` por frecuencia, `$limit`) o no usar
`$facet`.

### Los operadores de consulta recorren los arrays; las expresiones, no

> *"For documents where field is an array, `$type` returns documents in which at
> least one array element matches a type."*

Esto rompió una agregación mía con
`$objectToArray requires a document input, found: array`: el `$match` con
`{'kv.v': {$type: 'object'}}` dejaba pasar **arrays de objetos**, porque el
operador mira dentro del array.

```js
// MAL: deja pasar arrays cuyos elementos son objetos
{ $match: { 'kv.v': { $type: 'object' } } }

// BIEN: `$expr` usa la expresion de agregacion, que no recorre arrays
{ $match: { $expr: { $eq: [{ $type: '$kv.v' }, 'object'] } } }
```

### `$sample` solo es barato por debajo del 5%

> *"$sample uses a pseudo-random cursor if: $sample is the first stage, N is less
> than 5% of the total documents, and the collection contains more than 100
> documents."* Si no, *"performs a top-k sort by a generated random value"*.

Aquí el 5% son ~237.000 documentos. Por encima de eso, `$sample` deja de ser un
atajo y se convierte en barrido más ordenación.

---

## Tres errores que cometí, y por qué lo eran

**1. Recorrer la colección con un cursor en `mongosh`.**
`cursor.forEach()` y la iteración manual **se ejecutan en el cliente**: cada
documento viaja entero por el socket. 4,75 M × 18,4 kB = **85 GB** movidos para
contar claves. Lo mismo con una agregación ocurre dentro del servidor y no mueve
nada. Regla: si el resultado es un recuento o un resumen, **nunca** debe salir
un documento del servidor.

**2. Escribir a mano un inferidor de esquemas.**
Existe `mongodb-schema`, que es lo que usa la pestaña Schema de Compass:

```bash
npx @mongodb-js/mongodb-schema mongodb://localhost:27017 off.products \
  -n 50000 -f table --no-values
```

Muestreo aleatorio sobre toda la colección, no lectura de la cabecera de un
fichero ordenado: son cosas distintas y solo la segunda está prohibida por
sesgada.

**3. Leer únicamente los campos que ya conocía.**
`nutriments` estaba vacío y di por perdido el dato. Estaba en
`nutrition.aggregated_set.nutrients`, una estructura v3 documentada. Mirar el
esquema completo **antes** de concluir habría ahorrado tres iteraciones.

---

## Cómo hay que trabajar aquí: materializar

La consecuencia de «64 índices ocupados» + «85 GB para 11 GB de caché» es que
**no se debe consultar `off.products` repetidamente**. Se proyecta una vez lo
que interesa a una colección propia, y esa sí se indexa y cabe en caché.

```js
db.products.aggregate([
  { $project: {
      code: 1, countries_tags: 1, lang: 1,
      nutriments: 1, nutrition: '$nutrition.aggregated_set.nutrients',
      nutriscore_data: 1, no_nutrition_data: 1,
      nutrition_data_per: 1, serving_quantity: 1,
  } },
  { $out: 'analisis' },
], { allowDiskUse: true });
```

> *"`$out` completely replaces the output collection"* y *"must be the last stage
> in the pipeline"*. Para actualizaciones incrementales, `$merge`.

Un documento recortado ronda 1-2 kB frente a 18,4: la colección resultante cabe
en la caché y **admite índices propios**, porque el límite de 64 es por
colección. A partir de ahí cada pregunta son segundos, no seis minutos.

---

## Lo que MongoDB no va a hacer por nosotros

- **No hay esquema.** Ningún campo está garantizado. `nutriments` puede venir
  vacío, `product_name` puede no existir, `nutrition` puede faltar. Todo lector
  tiene que tolerar la ausencia; el volcado es lo que Open Food Facts tenga esa
  noche, con sus fallos de exportación incluidos.
- **No hay «todos los campos» indexable.** Averiguar qué campos existen es
  siempre un barrido; por eso se hace una vez y se escribe el resultado.
- **`$lookup` no es un JOIN de base relacional**: sin índice en la colección
  externa es un barrido por documento de entrada.
- **`explain()` es la única forma de saber si se usó un índice.** Suponerlo no
  vale: con 64 índices y ninguno pensado para nuestras consultas, la respuesta
  por defecto es que no.

---

## Recetas

```js
// Frecuencia de claves de primer nivel, dentro del servidor
db.products.aggregate([
  { $project: { kv: { $objectToArray: '$$ROOT' } } },
  { $unwind: '$kv' },
  { $group: { _id: '$kv.k', n: { $sum: 1 }, t: { $addToSet: { $type: '$kv.v' } } } },
  { $sort: { n: -1 } },
], { allowDiskUse: true });

// Inventario de un sub-objeto que es un MAPA (nutrientes, por ejemplo)
db.products.aggregate([
  { $match: { 'nutrition.aggregated_set.nutrients': { $exists: true } } },
  { $project: { kv: { $objectToArray: '$nutrition.aggregated_set.nutrients' } } },
  { $unwind: '$kv' },
  { $group: { _id: '$kv.k', n: { $sum: 1 },
              unidades: { $addToSet: '$kv.v.unit' },
              fuentes: { $addToSet: '$kv.v.source' } } },
  { $sort: { n: -1 } },
], { allowDiskUse: true });

// Comprobar que una consulta usa indice
db.products.find({ countries_tags: 'en:spain' }).explain('executionStats')
  .executionStats.executionStages.stage;   // IXSCAN o COLLSCAN

// Matar una agregacion que se fue de tiempo
db.adminCommand({ currentOp: 1 }).inprog
  .filter(o => o.ns === 'off.products')
  .forEach(o => db.adminCommand({ killOp: 1, op: o.opid }));
```

Datos de Open Food Facts bajo licencia ODbL-1.0.
