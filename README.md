# Veskan

PWA que escanea el código de barras de un producto y devuelve una **puntuación de salud de 0 a 100, abierta y auditable**, basada en Nutri-Score 2023, la clasificación NOVA, las evaluaciones de aditivos de EFSA y el modelo de perfil de nutrientes de la OPS/OMS.

**Sin instalación desde ninguna tienda. Sin servidor propio. Sin cuenta.** Todo el análisis se ejecuta en el navegador.

---

## Por qué existe

Yuka funciona bien pero su algoritmo es cerrado, penaliza aditivos por peligro teórico sin considerar la dosis, y regala un 10% de bonificación al sello "orgánico" que no tiene respaldo en resultados de salud. Open Food Facts tiene la base de datos abierta más grande del mundo pero no fusiona sus indicadores en una cifra que sirva de un vistazo en un pasillo de supermercado.

Veskan hace lo segundo con el método del primero, pero **con el algoritmo publicado, versionado y verificable**, y añadiendo el marco regulatorio que reconoce el usuario latinoamericano: los sellos octogonales de la OPS.

---

## Cómo funciona sin servidor

```
ESCANEO
   ↓
L0  IndexedDB — lo ya visto                          ~1 ms
   ↓ fallo
L1  SQLite estático sobre HTTP Range (CDN)          ~50–300 ms
   ↓ fallo
L2  API de Open Food Facts (CORS abierto)           ~300–900 ms
   ↓ fallo
L3  Lo añade el usuario
```

La pieza que lo hace posible: `world.openfoodfacts.org` responde con `access-control-allow-origin: *`, así que el navegador la consulta directamente. No hay backend.

La capa L1 es la interesante: un archivo `.sqlite3` en un repositorio público, servido por CDN, que se consulta con peticiones `Range`. El navegador descarga **solo las páginas que toca cada consulta**. Medido en navegador real: una búsqueda transfiere el 15% de un archivo de 1,18 MB; la proporción mejora cuanto más grande es la base.

---

## Puesta en marcha

```bash
npm install
npm run build:taxonomies   # taxonomía de aditivos de OFF → public/data/
npm run db:build           # snapshot SQLite desde la API de OFF
npm run dev
```

### Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | servidor de desarrollo |
| `npm run build` | compila la PWA a `dist/` |
| `npm test` | 951 tests del motor de puntuación |
| `npm run db:build` | construye el snapshot SQLite |
| `npm run db:serve` | servidor estático con soporte real de `Range` y CORS |

### Construir el snapshot

```bash
# Rápido: desde la API, sin descargar el volcado completo
node scripts/build-db.mjs --countries=spain,mexico,venezuela,colombia --limit=250

# Producción: desde el volcado nocturno de OFF.
# El JSONL pesa 12 GB comprimidos (el que ronda 1 GB es el CSV, otro archivo),
# así que conviene transmitirlo en vez de guardarlo:
curl -fL https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz \
  | node scripts/build-db.mjs --mode=dump --stdin \
      --countries=spain,mexico,colombia,venezuela
```

Pesa **~1 kB por producto**. 100.000 productos ≈ 110 MB, que supera el límite de 100 MB por archivo de GitHub: a partir de ahí hay que partir por región o servirlo desde Cloudflare R2.

### Desplegar

La app es estática: GitHub Pages, Cloudflare Pages o cualquier CDN.
El snapshot va en **un repositorio aparte**, por dos motivos: mantiene el repo de la app pequeño y aísla la licencia ODbL de los datos de la licencia MIT del código.

El host del snapshot **debe** soportar HTTP 206 y exponer `Content-Range` por CORS. Verificado que lo hacen: `raw.githubusercontent.com`, `cdn.jsdelivr.net` (máx. 20 MB/archivo), GitHub Pages, Cloudflare Pages (máx. 25 MB/archivo), Cloudflare R2.

---

## Verificación

El motor no se valida "a ojo".

**Nutri-Score 2023** — portado desde la implementación de referencia de Open Food Facts (`Nutriscore.pm`), no desde artículos. **923 aserciones contra 228 productos reales** comprueban coincidencia exacta de puntos, score y grado con lo que publica OFF, en las cinco categorías de reglas especiales (89 generales, 55 bebidas, 32 grasas/aceites, 31 quesos, 21 carne roja).

**Umbrales de la OPS** — transcritos del PDF oficial y comprobados justo en el borde de cada criterio: son inclusivos, y confundir `>` con `>=` cambiaría el veredicto de productos reales.

**Bancos de pruebas en navegador** — hay cosas que ningún test de Node puede comprobar:

```bash
npm run build && npm run db:serve
# http://localhost:8787/vfs-check.html      → capa L1: 6/6
# http://localhost:8787/scanner-check.html  → decodificador: 7/7
```

---

## Bases del algoritmo

| Bloque | Peso | Fuente |
|---|---|---|
| Calidad nutricional | 55% | Nutri-Score 2023 (FSAm-NPS), validado en la cohorte EPIC |
| Grado de procesamiento | 20% | Clasificación NOVA |
| Aditivos | 20% | Riesgo de sobreexposición evaluado por EFSA + vigilancia de ANSES |
| Advertencias | 5% | Modelo de perfil de nutrientes de la OPS (2016) |

La especificación completa, con cada constante justificada, está en [`docs/03-algoritmo.md`](docs/03-algoritmo.md).

### Tres decisiones que definen el proyecto

1. **Riesgo, no peligro.** Los aditivos se valoran por si la exposición real de la población supera la Ingesta Diaria Admisible según EFSA, no por su peligro teórico al margen de la dosis. Es la crítica principal que reciben Yuka y EWG, y se corrige de raíz.
2. **Se declara lo que no se sabe.** Cada resultado lleva un nivel de confianza calculado. Si el producto existe en la base pero está vacío, la app lo dice y ofrece completarlo, en vez de inventar una puntuación.
3. **Sin topes ocultos.** Yuka congela en 49/100 cualquier producto con un aditivo de riesgo. Aquí la penalización es fuerte pero gradual y aparece desglosada.

---

## Cobertura de datos: lo que hay que saber

Medido contra la API el 2026-09-16:

| País | Productos |
|---|---|
| España | 371.511 |
| Estados Unidos | 970.921 |
| México | 17.722 |
| Argentina | 16.185 |
| Colombia | 7.293 |
| Chile | 6.735 |
| **Venezuela** | **1.721** |

En buena parte de Latinoamérica, muchos escaneos van a fallar o devolver registros vacíos. Por eso el flujo de "añadir producto" es una función de primera clase y no un mensaje de error.

**Cosmética:** Open Beauty Facts tiene 75.182 productos y los códigos de Nivea y L'Oréal que se probaron no estaban. Además, la metodología tipo EWG está científicamente cuestionada. Por eso en cosmética **no se emite una puntuación numérica**: se muestran banderas regulatorias (Anexos del Reglamento (CE) 1223/2009), alérgenos de fragancia declarables y transparencia de la fórmula.

---

## Documentación

| Documento | Contenido |
|---|---|
| [`docs/01-investigacion.md`](docs/01-investigacion.md) | Panorama de apps similares, bases científicas, datos abiertos disponibles, todo con mediciones |
| [`docs/02-arquitectura.md`](docs/02-arquitectura.md) | Decisiones técnicas con su justificación y los resultados de verificación |
| [`docs/03-algoritmo.md`](docs/03-algoritmo.md) | Especificación normativa del algoritmo de puntuación |

---

## Licencias

**Modelo dual.** Detalle completo en [LICENSING.md](LICENSING.md).

| Qué | Licencia |
|---|---|
| El código | **AGPL-3.0**, o licencia comercial para uso propietario |
| `public/data/additives.json` | **ODbL-1.0** (derivado de Open Food Facts) |
| El snapshot de productos | **ODbL-1.0** (repositorio aparte) |

La AGPL no es casual: el argumento de este proyecto es que **una puntuación de salud debe poder auditarse**. La licencia extiende esa exigencia a quien construya encima.

La ODbL de los datos no es una elección sino una obligación heredada de Open Food Facts: es *share-alike*, así que toda base derivada que se distribuya debe publicarse igual y con atribución.

Como el modelo dual exige ser titular de todo el código, las aportaciones externas requieren el acuerdo descrito en [CONTRIBUTING.md](CONTRIBUTING.md).

Se auditó el árbol completo de dependencias (402 paquetes): **ninguna GPL, AGPL ni SSPL**.

## Despliegue

Dos repositorios, uno por licencia:

```
REPO A · veskan          REPO B · veskan-data
código, AGPL-3.0            snapshot, ODbL-1.0
push → test → build         cron nocturno → volcado OFF → sqlite
     → GitHub Pages              → GitHub Pages
            │                            │
            └──── HTTP Range, mismo origen ────┘
```

Ambos publican en `jmtt89.github.io`, así que la app y el snapshot comparten origen y **no hay CORS de por medio**. GitHub Pages responde `HTTP 206` con `Content-Range` (verificado), que es lo que el lector necesita.

Ninguno de los dos hace commit del binario: `actions/deploy-pages` sube un artefacto, de modo que el historial de git no crece aunque el snapshot se regenere cada noche.

El andamiaje del repositorio de datos está listo en [`data-repo/`](data-repo/).

## Aviso

Esta aplicación es informativa. No diagnostica, no prescribe y no sustituye el consejo de un profesional sanitario.
