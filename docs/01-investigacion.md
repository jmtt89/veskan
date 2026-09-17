# Investigación previa — App PWA de escaneo y calificación de productos

**Fecha:** 2026-09-16
**Objetivo:** establecer la base teórica (científica y regulatoria) y la base técnica (datos abiertos + arquitectura sin servidor) antes de escribir código.

Todos los datos marcados como **[verificado]** fueron medidos directamente contra los servicios reales el 2026-09-16, no tomados de artículos.

---

## 1. Panorama de aplicaciones similares

| App | Modelo | Datos | Puntuación | Código abierto |
|---|---|---|---|---|
| **Yuka** | Freemium, móvil | BD propia (~700k prod.) + OFF | 0–100: 60% nutrición + 30% aditivos + 10% orgánico | No |
| **Open Food Facts (smooth-app)** | ONG, Flutter | OFF (4.75M prod.) | Muestra Nutri-Score, NOVA, Eco-Score. No fusiona en 1 número | Sí (AGPL/MIT) |
| **Forklife** | Android/Kotlin | API de OFF | Nutri-Score + NOVA + Eco-Score | Sí |
| **Veskan** | Web | OFF + USDA | Valoración por nutriente | Sí |
| **INCI Beauty** | Cosmética | BD propia INCI | Escala por ingrediente | No |
| **EWG Skin Deep** | Cosmética | BD propia | 1–10 de "peligro" | No |
| **Think Dirty / Bobby Approved** | Cosmética / comida | BD propia | Score opaco | No |

**Conclusión clave:** el único jugador con base de datos abierta y masiva es **Open Food Facts**. Todos los demás, incluida Yuka, o bien construyen BD propietaria o bien consumen OFF. Nuestra app se posiciona como *"Yuka abierto, sin instalación, con criterio latinoamericano"*.

### Lo que Yuka hace bien (y copiaremos)
- Un solo número 0–100 + color: reduce carga cognitiva.
- Explicación desglosada de *por qué* ese número.
- Recomendación de alternativas mejores de la misma categoría.

### Lo que Yuka hace mal (y corregiremos)
- **Peligro ≠ riesgo.** Penaliza aditivos por peligro teórico sin considerar dosis/exposición real. Criticada por dietistas por esto.
- Regla de tope duro: un aditivo "de riesgo alto" limita el producto a 49/100 sin importar el resto — opaco y no gradual.
- El 10% de bonus "orgánico" no tiene respaldo en resultados de salud; es una señal de mercado, no nutricional.
- Score cerrado: nadie puede auditarlo.

**Nuestra diferencia: el algoritmo será abierto, versionado y explicable renglón por renglón.**

---

## 2. Base teórica de la calificación

### 2.1 Nutri-Score / FSAm-NPS (algoritmo 2023) — núcleo nutricional

Obligatorio desde 31-dic-2023 en su versión revisada. Calcula `Score = N − P`:

**Puntos negativos (N), máx. 55 (antes 40):**
| Componente | Rango | Notas |
|---|---|---|
| Energía | 0–10 | Sólidos: 335→3350 kJ (pasos de 335). Bebidas: 30→390 kJ |
| Azúcares | 0–15 (sólidos) / 0–10 (bebidas) | Sólidos 3.4→51 g; bebidas 0.5→11 g |
| Grasas saturadas | 0–10 | 1 punto por gramo hasta 10 g. Grasas/aceites: se puntúa el **ratio AGS/grasa total** (10%→64%) |
| Sal | 0–20 | Pasos de 0.2 g hasta 4.0 g |
| Edulcorantes | +4 | **Solo bebidas**, si hay edulcorante no nutritivo (novedad 2023) |

**Puntos positivos (P), máx. 17 (antes 15):**
| Componente | Rango |
|---|---|
| Frutas/verduras/legumbres/frutos secos | 0–5 (sólidos) / 0–6 (bebidas) |
| Fibra | 0–5 (3.0→7.4 g) |
| Proteína | 0–7 (2.4→17 g). **Carne roja: tope 2 puntos** |

**Regla de combinación por categoría:**
```
General:        si N < 11 → N − P ; si no → N − (FVL + fibra)   # proteína no cuenta
Carne roja:     igual, con proteína limitada a 2 pts
Queso:          N − P  (la proteína siempre cuenta)
Grasas/aceites: si N < 7 → N − P ; si no → N − (FVL + fibra)
Bebidas:        N − P  (la proteína siempre cuenta)
Agua:           A por definición
```

**Cortes a letra:**
| Categoría | A | B | C | D | E |
|---|---|---|---|---|---|
| General / queso / carne roja | < 1 | < 3 | < 11 | < 19 | ≥ 19 |
| Grasas y aceites | < −5 | < 3 | < 11 | < 19 | ≥ 19 |
| Bebidas | solo agua | ≤ 2 | ≤ 6 | ≤ 9 | > 9 |

**Validación científica:** la cohorte europea EPIC (>470k participantes) asoció un FSAm-NPS peor con mayor riesgo de cáncer; otras cohortes lo asocian a enfermedad cardiovascular y mortalidad.
**Limitaciones honestas:** estudios observacionales con cuestionarios autoinformados (confusión residual); no distingue granos enteros ni tipos de grasa en platos mixtos; sesgo hacia productos proteicos. Los tamaños de efecto agrupados son modestos.

### 2.2 NOVA — grado de procesamiento

Cuatro grupos: 1) sin procesar o mínimamente procesado, 2) ingredientes culinarios procesados, 3) procesados, 4) **ultraprocesados**. El consumo alto de grupo 4 se asocia a obesidad, diabetes, ECV y salud mental.

NOVA aporta una dimensión **ortogonal** a Nutri-Score: un refresco light puede tener buen perfil de nutrientes y ser NOVA 4. Por eso deben ir separados, no fusionados sin más.

### 2.3 Aditivos — EFSA/OpenFoodTox vía taxonomía de OFF **[verificado]**

El archivo `https://static.openfoodfacts.org/data/taxonomies/additives.json` (**906 KB, CORS `*`, 683 aditivos**) trae exactamente lo que necesitamos, con campos:

```
efsa_evaluation_overexposure_risk        → en:no | en:moderate | en:high
efsa_evaluation_exposure_mean_greater_than_adi     → grupos poblacionales
efsa_evaluation_exposure_95th_greater_than_adi     → grupos poblacionales
efsa_evaluation_safety_assessed, efsa_evaluation_adi, efsa_evaluation_url, efsa_evaluation_date
anses_additives_of_interest              → marcado por la agencia francesa ANSES
additives_classes                        → colorante, conservante, edulcorante...
sweetener / non_nutritive_sweetener, vegan, vegetarian, from_palm_oil
```

Ejemplo real extraído: **E250 (nitrito de sodio)** → `overexposure_risk: en:high`, `anses_additives_of_interest: yes`, con superación de la IDA en la media de niños, infantes y bebés, y en el percentil 95 de **todos** los grupos de edad. **E951 (aspartamo)** → `overexposure_risk: en:no`.

Esto nos da una base **citable y trazable a EFSA**, no una opinión. Es la respuesta correcta a la crítica de "peligro vs riesgo": la sobreexposición *es* una métrica de riesgo, no de peligro.

### 2.4 Perfil de nutrientes OPS/OMS y sellos de advertencia — el ángulo latinoamericano

El **Modelo de Perfil de Nutrientes de la OPS (2016)** define excesos de azúcares libres, sodio, grasas saturadas y grasas trans. Es la base de los **sellos octogonales negros** de Chile, Perú, México (NOM-051), Uruguay, y otros de la región.

Es importante incluirlo porque:
1. Es el marco **regulatorio vigente** en el mercado objetivo, no un estándar europeo importado.
2. Los usuarios de LatAm ya lo reconocen visualmente ("EXCESO EN AZÚCARES").
3. Complementa a Nutri-Score: OPS es binario por nutriente crítico (hay/no hay exceso), Nutri-Score es gradual y global.

**Propuesta: mostrar ambos.** Nutri-Score como nota continua, sellos OPS como advertencias discretas.

### 2.5 Cosmética — por qué es un problema distinto

La crítica central a EWG Skin Deep y Think Dirty es que **puntúan peligro intrínseco ignorando concentración, vía de exposición y si el producto se enjuaga**. Un ingrediente peligroso al 10% en laboratorio puede ser irrelevante al 0.1% en una crema.

Base defendible para cosmética:
- **CosIng** (Comisión Europea, Reglamento (CE) 1223/2009): Anexo II prohibidos, III restringidos (con concentración máxima), IV colorantes, V conservantes, VI filtros UV. Es dato regulatorio, verificable.
- **26 alérgenos de fragancia** de declaración obligatoria en la UE.
- **INCIDecoder** como referencia de calidad por ingrediente (explica función y concentración típica), aunque no da score de producto.
- **openFDA Cosmetic Adverse Events** para señales de eventos adversos reales.

**Recomendación:** para cosmética **no dar un número 0–100 de "salud"**. Dar *banderas regulatorias* + *alérgenos declarados* + transparencia de la fórmula. Es más honesto y más difícil de rebatir.

---

## 3. Datos abiertos disponibles — medición real

### 3.1 Open Food Facts (comida) **[verificado]**

| Aspecto | Medición |
|---|---|
| Total de productos | **4,753,482** |
| Licencia | ODbL (base) + DbCL (contenidos) + CC-BY-SA (imágenes) |
| API | `https://world.openfoodfacts.org/api/v2/product/{ean}.json` |
| **CORS** | **`access-control-allow-origin: *`** → se consume **directo desde el navegador, sin proxy** |
| Cabeceras expuestas | `Content-Length`, `Content-Range`; acepta `Range` |
| **Rate limit** | **15 req/min/IP** (producto), **10 req/min/IP** (búsqueda) — *confirmado empíricamente: la 8ª búsqueda seguida falló* |
| User-Agent | Obligatorio, formato `AppName/Version (email)` |
| Respuesta típica | 2.5 KB con `fields=` acotado |

**Campo estrella: `nutriscore_data`** devuelve el desglose completo del cálculo:
```
components, negative_points, positive_points, negative_points_max, positive_points_max,
score, grade, count_proteins, count_proteins_reason,
is_beverage, is_cheese, is_fat_oil_nuts_seeds, is_red_meat_product, is_water
```
→ **Podemos explicar el "porqué" del score sin recalcular nada.**

**`knowledge_panels`** devuelve paneles explicativos ya traducidos al español (`lc=es`): 56 paneles, ~52 KB por producto. Útil para la vista de detalle, demasiado pesado para listas.

**Exportaciones estáticas (actualización nocturna):**
| Formato | URL | Tamaño |
|---|---|---|
| JSONL | `static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz` | redirige a S3 |
| CSV | `static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz` | ~0.9 GB comp. / ~9 GB sin comp. |
| **Parquet** | `huggingface.co/datasets/openfoodfacts/product-database` → `food.parquet` | columnar, columnas depuradas |
| MongoDB | `openfoodfacts-mongodbdump.gz` + **deltas de 14 días** | — |

### 3.2 Cobertura por país **[verificado]** — el hallazgo más importante

| País | Productos |
|---|---|
| España | **371,511** |
| Estados Unidos | 970,921 |
| México | 17,722 |
| Argentina | 16,185 |
| Colombia | 7,293 |
| Chile | 6,735 |
| **Venezuela** | **1,721** |

**Implicación directa de diseño:** en Venezuela/Colombia/Chile, una fracción grande de los escaneos va a fallar. La app **debe** tener un camino de "producto no encontrado" que sea de primera clase, no un mensaje de error. Esto es lo que justifica la BD propia en repositorio git que propusiste.

### 3.3 Open Beauty Facts (cosmética) **[verificado]**

| Aspecto | Medición |
|---|---|
| Total de productos | **75,182** (63× menos que comida) |
| Dump CSV completo | **17.9 MB comprimido** → cabe entero en el cliente |
| Prueba de barcodes reales | 3 códigos de Nivea / L'Oréal probados → **los 3 "product not found"** |

**Conclusión:** la cobertura cosmética es demasiado débil para prometer escaneo de cosméticos en v1. Pero como la BD entera pesa 18 MB, sí podemos **empaquetarla completa y funcionar 100% offline** para lo que sí existe.

### 3.4 Otras fuentes
- **USDA FoodData Central** — dominio público, buena para EE.UU. y alimentos genéricos.
- **CosIng / biobricks-ai/cosing-kg** — anexos regulatorios de cosmética.
- **Robotoff** (OFF) — OCR e IA para extraer datos de fotos de etiquetas.

---

## 4. El problema de la "base de datos compartida sin servidor"

Tu intuición era correcta y además es una técnica establecida. Verificaciones:

### 4.1 Hosts estáticos: soporte de `Range` + CORS **[verificado]**

| Host | HTTP 206 (Range) | CORS | Límite |
|---|---|---|---|
| `raw.githubusercontent.com` | ✅ `content-range` OK | ✅ `*` | 100 MB/archivo, cache 5 min |
| `cdn.jsdelivr.net/gh/` | ✅ `content-range` OK | ✅ `*` | **20 MB/archivo**, cache 7 días |
| `static.openfoodfacts.org` | ✅ `accept-ranges: bytes` | ✅ `*` | — |
| GitHub Pages | ✅ | ✅ | 1 GB sitio, 100 GB/mes |
| Cloudflare Pages | ✅ | ✅ | **25 MB/archivo** |
| Hugging Face | ✅ | ⚠️ **CORS falla en preflight de Range** tras redirección a `cas-bridge.xethub.hf.co` — issue abierto |

### 4.2 Técnica: SQLite sobre HTTP Range

`sql.js-httpvfs` (phiresky) monta un SQLite de solo lectura en un host estático y descarga **solo las páginas que la consulta toca**: una búsqueda por clave en una BD de 670 MB transfiere ~1 KB. Requiere WebAssembly + WebWorkers.

→ **Esto es exactamente el "caché lento consultable" que describiste, y funciona.**

Límites: solo lectura (las escrituras necesitan backend), sin evicción de caché en RAM.

### 4.3 Alternativa más simple: sharding por prefijo de código de barras

En vez de SQLite+WASM, partir la BD en archivos JSON por prefijo de EAN (`759/7591234.json`, o 2–3 niveles). Un escaneo = 1 `fetch` de un archivo pequeño, cacheado por el service worker y por el CDN. Sin WASM, sin dependencias, depurable con el navegador. Más archivos en el repo, pero git y los CDN lo manejan bien.

### 4.4 Restricción legal (importante)

ODbL es **share-alike**: si publicamos una BD derivada de OFF, esa BD derivada debe publicarse también bajo ODbL y con atribución a Open Food Facts. Esto es compatible con el plan (repo público), pero debe quedar escrito en el repo y visible en la app.

---

## 5. Escaneo de código de barras en el navegador

| Opción | Estado 2026 | Veredicto |
|---|---|---|
| **`BarcodeDetector` nativo** | ~94% de instalaciones Chrome; **sin Firefox ni Safari** (Safari "en consideración" desde 2024) | Usar como ruta rápida cuando exista |
| **`zxing-wasm`** (Sec-ant) | **Activo**: v3.1.3 publicada 2026-08-14; WASM ~1.04 MiB (solo lector); mejoras recientes de rendimiento | **Fallback principal** |
| `html5-qrcode` | **Sin mantenimiento**, y su dependencia `zxing-js` tampoco | Descartar |
| QuaggaJS | Antiguo | Descartar |

**Estrategia:** detección de capacidad → `BarcodeDetector` si existe, `zxing-wasm` si no. Ambos leen EAN-13/EAN-8/UPC-A.

---

## 6. Almacenamiento local en el cliente

| Tecnología | Uso recomendado |
|---|---|
| **Cache API** (service worker) | Shell de la app, taxonomías, iconos |
| **IndexedDB** (vía Dexie) | Historial del usuario, productos cacheados, cola de contribuciones |
| **OPFS + wa-sqlite** | Solo si se embebe un snapshot grande con consultas complejas/FTS |
| localStorage | Solo preferencias pequeñas |

Para v1: **Cache API + IndexedDB** cubre todo. SQLite-WASM queda como evolución si el snapshot offline crece.

---

## 7. Arquitectura propuesta: tres capas de datos

```
   ESCANEO  ─────────────────────────────────────────────┐
      │                                                   │
      ▼                                                   │
 ┌─────────────────┐   hit    ┌──────────────────────┐   │
 │ L0: IndexedDB   │─────────►│  MOTOR DE SCORING    │   │
 │ caché local     │          │  (100% en cliente)   │   │
 └────────┬────────┘          │  · Nutri-Score 2023  │   │
          │ miss              │  · NOVA              │   │
          ▼                   │  · Aditivos EFSA     │   │
 ┌─────────────────┐   hit    │  · Sellos OPS        │   │
 │ L1: BD estática │─────────►│  · Ponderación       │   │
 │ repo git + CDN  │          └──────────┬───────────┘   │
 │ (ODbL, nuestra) │                     │               │
 └────────┬────────┘                     ▼               │
          │ miss                  RESULTADO 0–100        │
          ▼                       + desglose citado      │
 ┌─────────────────┐                                     │
 │ L2: API de OFF  │  CORS *, 15 req/min                 │
 │ (en vivo)       │                                     │
 └────────┬────────┘                                     │
          │ miss                                         │
          ▼                                              │
 ┌─────────────────────────────────────┐                 │
 │ L3: CONTRIBUCIÓN DEL USUARIO        │─────────────────┘
 │ foto etiqueta + datos → cola local  │
 │ → PR al repo / envío a OFF          │
 └─────────────────────────────────────┘
```

**Por qué funciona sin servidor:**
- L2 (OFF) tiene CORS abierto → el navegador llama directo. **No necesitamos backend para el caso común.**
- L1 es tu idea: archivos estáticos versionados en git, servidos por CDN, con `Range` disponible si escalamos a SQLite.
- L3 es la única escritura, y se resuelve con la API de GitHub (PR) o la API de escritura de OFF — sin infraestructura propia.

---

## 8. Fórmula de puntuación propuesta (v1, abierta y versionada)

Base 100, con penalizaciones y bonificaciones trazables:

| Bloque | Peso | Fuente |
|---|---|---|
| **Calidad nutricional** | 55% | Nutri-Score 2023 (FSAm-NPS) normalizado a 0–100 |
| **Grado de procesamiento** | 20% | NOVA 1→100, 2→80, 3→55, 4→25 |
| **Aditivos** | 20% | Por aditivo, según `efsa_evaluation_overexposure_risk` + `anses_additives_of_interest` |
| **Sellos de advertencia OPS** | 5% + moduladores | −4 por cada sello de exceso (azúcares, sodio, grasas sat., grasas trans, calorías) |

Diferencias deliberadas frente a Yuka:
- Sin bonus "orgánico" (sin respaldo en resultados de salud). Se muestra como etiqueta informativa, no como puntos.
- Sin tope duro de 49: la penalización por aditivo de riesgo alto es fuerte pero **gradual y explicada**.
- Se distingue **sobreexposición (riesgo)** de **peligro teórico**.
- **Nivel de confianza explícito**: si faltan datos (fibra, % frutas/verduras), se muestra el score con barra de incertidumbre en lugar de fingir precisión.

---

## 9. Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| Cobertura escasa en LatAm (VE: 1,721 prod.) | Flujo de contribución de primera clase + BD propia L1 + OCR de etiqueta |
| Rate limit de 15 req/min por IP (NAT corporativo) | Caché agresivo en IndexedDB; L1 estático absorbe la mayoría |
| Cosmética: datos pobres y metodología disputada | No prometer score 0–100 en cosmética; mostrar banderas regulatorias |
| Responsabilidad legal / consejo médico | Disclaimer visible; lenguaje informativo, nunca prescriptivo; sin claims de enfermedad |
| ODbL share-alike | Publicar BD derivada bajo ODbL + atribución visible a OFF |
| Datos incorrectos en OFF (colaborativo) | Mostrar fecha de última edición y enlace a corregir en OFF |
| `BarcodeDetector` ausente en Safari/Firefox | `zxing-wasm` como fallback |

---

## 10. Fuentes

- [Open Food Facts — Data, API and SDKs](https://world.openfoodfacts.org/data)
- [Open Food Facts — Introducción a la API](https://openfoodfacts.github.io/openfoodfacts-server/api/)
- [Open Beauty Facts — Data](https://world.openbeautyfacts.org/data)
- [Open Food Facts — Grupos NOVA](https://world.openfoodfacts.org/nova)
- [Yuka — Cómo se puntúan los productos](https://help.yuka.io/l/en/article/ijzgfvi1jq-how-are-food-products-scored)
- [Yuka App Review — Abby Langer Nutrition (crítica)](https://abbylangernutrition.com/yuka-app-review-scan-or-scam/)
- [FSA-NPS Algorithm: Technical Reference for the 2023 Nutri-Score Calculation](https://www.eclarion.com/nutriscore-calculator/methodology/)
- [Eurofins — Actualización del Nutri-Score desde el 31-12-2023](https://www.eurofins.de/food-analysis/food-news/food-testing-news/nutri-score-update/)
- [Nutri-Score 2023 update (Merz et al., Nature Food)](https://publicationslist.org/data/torsten-bohn/ref-295/Merz-NatFds-2023.pdf)
- [EPIC cohort — FSAm-NPS y riesgo de cáncer (PLOS Medicine)](https://journals.plos.org/plosmedicine/article?id=10.1371%2Fjournal.pmed.1002651)
- [Beyond Nutrient Profiling: Strengths, Limitations and Emerging Challenges for Nutri-Score](https://pmc.ncbi.nlm.nih.gov/articles/PMC13468466/)
- [OPS/OMS — Modelo de Perfil de Nutrientes](https://www.paho.org/en/nutrient-profile-model)
- [Modelo de perfil de nutrientes de la OPS (PDF)](https://alianzasalud.org.mx/wp-content/uploads/2016/02/Modelo-de-perfil-de-Nutrientes_OPS.pdf)
- [EFSA — OpenFoodTox / herramientas de exposición dietética](https://www.sciencedirect.com/science/article/pii/S0160412020323126)
- [OFF issue #4272 — niveles de riesgo de sobreexposición EFSA en aditivos](https://github.com/openfoodfacts/openfoodfacts-server/issues/4272)
- [Comisión Europea — Base de datos CosIng](https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en)
- [biobricks-ai/cosing-kg](https://github.com/biobricks-ai/cosing-kg)
- [HadaBuddy — peligro vs riesgo en scores cosméticos](https://www.hadabuddy.com/blog/most-accurate-skincare-ingredient-checker)
- [phiresky — Hosting SQLite databases on GitHub Pages](https://phiresky.github.io/blog/2021/hosting-sqlite-databases-on-github-pages/)
- [sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs)
- [Sec-ant/zxing-wasm](https://github.com/Sec-ant/zxing-wasm)
- [MDN — Barcode Detection API](https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API)
- [caniuse — BarcodeDetector](https://caniuse.com/mdn-api_barcodedetector)
- [openfoodfacts/smooth-app](https://github.com/openfoodfacts/smooth-app)
- [Ynniss/forklife — clon de Yuka sobre OFF](https://github.com/Ynniss/forklife)
- [RxDB — localStorage vs IndexedDB vs OPFS vs WASM-SQLite](https://rxdb.info/articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm.html)
- [HF datasets issue #7931 — CORS + Range en cas-bridge.xethub.hf.co](https://github.com/huggingface/datasets/issues/7931)
