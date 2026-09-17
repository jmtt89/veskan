# Licencias

Este proyecto se distribuye bajo un **modelo dual**, y los datos siguen una licencia distinta al código. Conviene tener clara la diferencia antes de reutilizar nada.

---

## 1. El código: AGPL-3.0 o licencia comercial

### Opción por defecto — AGPL-3.0

Todo el código de este repositorio está bajo la [GNU Affero General Public License v3.0](LICENSE). Puedes usarlo, estudiarlo, modificarlo y redistribuirlo libremente, con una condición: **si distribuyes una versión modificada, o la ofreces a terceros a través de una red, tienes que publicar su código fuente bajo esta misma licencia.**

Esa cláusula es deliberada y es coherente con la razón de ser del proyecto. Todo el argumento frente a las alternativas cerradas es que **la puntuación debe poder auditarse**: un algoritmo de salud cuyo funcionamiento nadie puede revisar no merece confianza. La AGPL extiende esa exigencia a cualquiera que construya sobre este trabajo.

### Opción alternativa — licencia comercial

Si quieres integrar este código en un producto propietario y no puedes cumplir la AGPL, existe una licencia comercial que exime de la obligación de publicar el código derivado.

Consultas sobre esta vía: abre una *issue* en el repositorio con la etiqueta `licensing`.

---

## 2. Los datos: ODbL-1.0

**Esto no es una elección nuestra, es una obligación heredada.**

Los datos de producto proceden de [Open Food Facts](https://world.openfoodfacts.org) y [Open Beauty Facts](https://world.openbeautyfacts.org), publicados bajo la [Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1-0/). La ODbL es *share-alike*: cualquier base de datos derivada que se distribuya **debe publicarse también bajo ODbL y con atribución al origen**.

Esto afecta a dos cosas concretas:

| Elemento | Licencia | Dónde vive |
|---|---|---|
| `public/data/additives.json` | **ODbL-1.0** | dentro de este repositorio |
| `snapshot.sqlite3` | **ODbL-1.0** | repositorio de datos aparte |

El archivo de aditivos está dentro de un repositorio cuyo código es AGPL, pero **no es código: es una base de datos derivada y se rige por ODbL**. Se genera con `scripts/build-taxonomies.mjs` a partir de la taxonomía de Open Food Facts.

El snapshot se mantiene en un repositorio separado precisamente para que esta distinción no dependa de que alguien lea este documento.

Las imágenes de producto de Open Food Facts están bajo Creative Commons Attribution ShareAlike. Esta aplicación no las redistribuye: enlaza a las originales.

---

## 3. Por qué el modelo dual exige un acuerdo de contribución

Para poder conceder una licencia comercial hace falta ser **titular de los derechos de todo el código**. Si alguien aporta código sin ceder esos derechos, su aportación queda solo bajo AGPL y bloquea la vía comercial para siempre — no de forma parcial, sino para el proyecto entero.

Por eso toda aportación externa requiere firmar el acuerdo descrito en [CONTRIBUTING.md](CONTRIBUTING.md). No es burocracia por gusto: sin él, el modelo dual deja de funcionar el día que llegue el primer *pull request*.

---

## 4. Dependencias de terceros

Se auditó el árbol completo (402 paquetes) y **no contiene ninguna dependencia GPL, AGPL ni SSPL**, lo que mantiene despejada la vía comercial.

Las que se distribuyen dentro de la aplicación:

| Paquete | Licencia | Para qué |
|---|---|---|
| `dexie` | Apache-2.0 | IndexedDB |
| `zxing-wasm` | MIT | lectura de códigos de barras |
| `@sqlite.org/sqlite-wasm` | Apache-2.0 | consulta del snapshot |

El resto del árbol: 353 MIT, 19 ISC, 11 Apache-2.0, 7 BlueOak-1.0.0, 8 BSD y algún dual permisivo.

---

## 5. Resumen para quien tenga prisa

| Quiero… | Puedo |
|---|---|
| Usar la app | Sí, sin condiciones |
| Leer y estudiar el código | Sí |
| Modificarlo para mí | Sí |
| Publicar una versión modificada | Sí, publicando tu código bajo AGPL-3.0 |
| Integrarlo en un producto cerrado | Solo con licencia comercial |
| Reutilizar el snapshot de datos | Sí, bajo ODbL y citando a Open Food Facts |
