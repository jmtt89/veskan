# Arquitectura y decisiones técnicas

**Fecha:** 2026-09-17
Documento de decisiones. Cada decisión lleva su justificación y, cuando aplica, la medición que la respalda.

---

## D1. Stack de UI — *Vite + TypeScript nativo, sin framework*

Se pidió analizar Angular. Se hizo **compilando ambos proyectos y midiendo**, no por reputación.

| Stack | Bundle inicial (raw) | Transferencia (gzip) |
|---|---|---|
| Angular 22.1.7 (zoneless, standalone, sin SSR) | 124,96 kB | **40,6 kB** |
| Vite + Preact + TS | 17,9 kB | **8,7 kB** |

**El argumento del peso está muerto.** Angular 22 pesa 40 kB gzip; en una app que ya carga ~950 kB de WASM del escáner más ~870 kB del de SQLite, una diferencia de 32 kB es ruido. Además, **Angular 22 ya se construye sobre Vite + esbuild**, así que "Vite + TypeScript" y Angular no son alternativas opuestas.

Se eligió **Vite + TypeScript nativo, sin framework de UI**, por dos razones específicas de *este* proyecto:

1. **Control del Service Worker.** La arquitectura exige un SW que precachee el shell, cachee respuestas de la API de OFF con TTL propio y, sobre todo, **deje pasar sin interceptar las peticiones `Range` al archivo SQLite**. Un SW que intercepta y cachea respuestas parciales rompe el VFS. Con `vite-plugin-pwa` + Workbox esa ruta se escribe a mano en tres líneas. El SW de Angular (`ngsw-config.json`) es declarativo y para lógica personalizada obliga a salirse de él igualmente.
2. **La complejidad de esta app no está en la UI.** Son cinco pantallas. La complejidad está en el motor de puntuación y en la capa de datos, que son **TypeScript puro sin framework**.

La capa de vistas son ~200 líneas: una plantilla etiquetada `html` que escapa por defecto (`src/ui/render.ts`) y delegación de eventos desde la raíz.

**Decisión de diseño que hace reversible esta elección:** `src/core/` no importa nada de UI. Si mañana se migra a Angular, se reescribe `src/ui/` y el motor se reutiliza intacto.

> Angular sería la elección correcta si el proyecto fuera a crecer con varios desarrolladores que ya lo dominan, o si se necesitara i18n/forms/DI de fábrica.

### Peso real del bundle compilado

| Recurso | Cuándo se carga | gzip |
|---|---|---|
| Shell (JS + CSS) | siempre | ~23 kB |
| Dexie (IndexedDB) | siempre | 32 kB |
| zxing-wasm | solo al abrir la cámara | 414 kB |
| sqlite3.wasm | solo al usar el snapshot | 404 kB |

Los dos WASM **no entran en la carga inicial**: quien nunca escanea nunca los descarga.

## D2. Estructura del proyecto

```
app-market/
├── docs/                      # investigación y decisiones
├── scripts/
│   └── build-db.mjs           # pipeline: dump de OFF → SQLite estático
├── public/
├── src/
│   ├── core/                  # ⚠️ CERO dependencias de UI
│   │   ├── types.ts
│   │   ├── scoring/
│   │   │   ├── nutriscore2023.ts   # port exacto de la referencia de OFF
│   │   │   ├── nova.ts
│   │   │   ├── additives.ts        # EFSA vía taxonomía de OFF
│   │   │   ├── paho.ts             # sellos OPS/OMS
│   │   │   ├── cosmetics.ts        # banderas regulatorias (sin score)
│   │   │   └── engine.ts           # combinación 0–100 + confianza
│   │   ├── data/
│   │   │   ├── repository.ts       # orquesta L0→L1→L2→L3
│   │   │   ├── off.ts              # L2: API en vivo
│   │   │   ├── sqlite-http/        # L1: SQLite sobre HTTP Range
│   │   │   ├── idb.ts              # L0: caché + historial + cola
│   │   │   └── taxonomies.ts
│   │   ├── scanner/
│   │   └── i18n/
│   ├── ui/                    # vistas: render.ts + components.ts
│   ├── dev/                   # bancos de pruebas en navegador
│   ├── main.ts
│   └── styles.css
└── tests/
```

---

## D3. Las cuatro capas de datos

| Capa | Qué es | Latencia | Red | Cobertura |
|---|---|---|---|---|
| **L0** | IndexedDB (Dexie): productos ya vistos, historial, cola de contribuciones | ~1 ms | no | lo ya escaneado |
| **L1** | **Catálogos descargados**: archivos SQLite reales en OPFS, uno por país | ~5–50 ms | **no** | los países que el usuario haya guardado |
| **L2** | Catálogos publicados **no** descargados, leídos por HTTP Range | ~50–300 ms | sí, sin límite | el resto de países publicados |
| **L3** | API de Open Food Facts / Open Beauty Facts en vivo | ~300–900 ms | sí, 15 pet./min | 4.75 M productos, global |
| **L4** | Contribución del usuario (foto + formulario) | — | sí | lo que no existe en ningún lado |

**Orden de consulta:** L0 → L1 → L2 → L3 → L4.
**Orden de frescura:** L3 es la fuente de verdad; L1 y L2 son instantáneas; L0 caduca a los 30 días.

**L1 admite varios países a la vez**, y no por comodidad: medido sobre los shards
publicados, el **19,3 % del catálogo mexicano** y el **13,8 % del venezolano** llevan
prefijo GS1 estadounidense. Un usuario mexicano necesita México *y* Estados Unidos, así
que la lista de la interfaz deja descargar y borrar cada país por separado.

**L2 no es una opción que el usuario deba entender, es automática.** Existe para no gastar
el cupo de un servicio donado: si el producto está en un catálogo que ya publicamos, se
resuelve por rangos sin tocar la API.

Dentro de L1/L2 el orden por país lo decide `snapshotPriority()`: primero los descargados,
en su orden, y después el que sugiere el prefijo GS1 del código. Lo que el usuario tiene
en disco manda sobre la deducción.

### Actualización incremental de L1

Un catálogo guardado se queda viejo en cuanto el pipeline reconstruye. Volver a bajarlo
entero cuesta 76,6 MB en España; **el delta de un día son 25,0 kB medidos** sobre un cambio
real de 315 productos y 4 bajas: **3.100 veces menos**. Aplicarlo sobre las 340.000 filas
tarda **322 ms**.

**Los deltas NO son los que publica Open Food Facts.** El plan original era consumir
`static.openfoodfacts.org/data/delta/`, pero medido sobre dos de esos archivos separados
doce días, el campo `nutriments` viene **vacío en el 100 % de los registros** (1.153 de
5.734 lo traen como objeto vacío, ninguno con valores), frente al 62 % relleno en el
volcado completo. Aplicarlos borraría energía, azúcares, grasas y sal de cada producto
actualizado: dejaría el catálogo peor que antes.

Así que `scripts/build-delta.mjs` los calcula comparando dos generaciones de nuestro propio
snapshot. Sale más barato de lo que parece —el volcado hay que recorrerlo igualmente cada
noche— y además:

- lleva **todas** nuestras columnas, no un subconjunto ajeno;
- detecta las **bajas reales**, que los deltas de OFF no marcan y obligaban a la
  reconstrucción semanal que preveía el plan;
- es exacto por construcción, y el pipeline lo **demuestra al publicar**: `--verify` aplica
  cada delta sobre una copia del snapshot anterior y compara fila a fila con el nuevo. Si
  no coincide, aborta. Comprobado que detecta un delta manipulado: 250 filas distintas y
  salida 1.

Encadenado por versión (`meta.version`, marca de tiempo compacta UTC). El cliente compara
la suya con la del índice y `planSync()` decide: al día, cadena de deltas, o descarga
completa si falta un eslabón, si cambió el esquema o si lo acumulado supera el 35 % del
catálogo.

Dos detalles que solo aparecieron probándolo de extremo a extremo:

- **El índice de texto se toca una sola vez por delta.** `products_fts` declara
  `barcode UNINDEXED`, así que buscar por esa columna es un escaneo completo: fila a fila
  serían 173 s para un día de Estados Unidos, por lotes son 164 ms. Y solo entran las filas
  cuyo `name` o `brands` cambiaron de verdad (`fts: 1` en el delta).
- **Hay que invalidar L0.** El caché de productos ya vistos es la primera capa que consulta
  `lookup()`: sin borrar de ahí los códigos que tocó el delta, el usuario no vería el
  cambio hasta 30 días después. Se borran exactamente los que vienen en el archivo.

### Un único Worker, por obligación
La documentación del VFS `opfs-sahpool` es explícita: *"only one instance of this VFS can
use the same directory concurrently"*. Todo el acceso a OPFS pasa por un solo Worker
(`worker-pool.ts`), del que cuelgan las fuentes lógicas identificadas por país.

Además hay dos trampas verificadas en el código de la librería:

- `installOpfsSAHPoolVfs()`, al fallar, llama a `removeVfs()`, que **borraría el directorio
  entero**. Se serializa con `navigator.locks`, tomando el candado durante toda la vida del
  contexto y no solo durante la instalación.
- `acquireAccessHandles()` pide todos los manejadores con un `Promise.all`; si uno falla,
  los que resuelven después quedan **huérfanos dentro de ese Worker** y ningún reintento
  puede ya tomarlos. Por eso el reintento no está dentro del Worker: se **termina el
  Worker** y se empieza con uno nuevo.
- `pauseVfs()` lanza si queda alguna base abierta, así que al ocultarse la página se
  cierran antes las conexiones y se reabren solas en la siguiente consulta.

Cuando L2 responde y difiere de L1, se actualiza L0 con lo de L2 y se marca el registro de L1 como desactualizado (telemetría para regenerar el snapshot).

### Por qué esto funciona sin servidor
`world.openfoodfacts.org` responde con `access-control-allow-origin: *` **[verificado]**, así que el navegador llama directo. No hay backend. La única escritura (L3) va contra la API de GitHub o la API de escritura de OFF.

---

## D4. L1: SQLite sobre HTTP Range

### El problema del paquete elegido
`sql.js-httpvfs` es la referencia del método, pero **su última publicación es del 2022-09-23: cuatro años sin mantenimiento** [verificado con `npm view`]. Está construido sobre `sql.js`, que arrastra una versión antigua de SQLite.

Frente a eso, `@sqlite.org/sqlite-wasm` es **el paquete oficial del proyecto SQLite, actualizado el 2026-09-08** (SQLite 3.53.4).

### Decisión
Se implementa un **VFS propio de solo lectura sobre HTTP Range** encima del paquete oficial. Es más trabajo que usar `sql.js-httpvfs`, pero evita cimentar el proyecto sobre una dependencia abandonada.

### El truco que lo hace posible
El VFS clásico de SQLite es **síncrono**; `fetch()` es asíncrono. Las dos salidas son:
- `SharedArrayBuffer` + `Atomics.wait` → **descartado: exige cabeceras COOP/COEP que GitHub Pages no permite configurar.**
- **`XMLHttpRequest` síncrono dentro de un Web Worker** → permitido por la plataforma, sin cabeceras especiales. **Esta es la elegida** (es también lo que hace `sql.js-httpvfs` por debajo).

Por tanto SQLite corre **siempre en un Worker**, nunca en el hilo principal.

### Optimizaciones
- `page_size` de la BD = **4096 B**, alineado con lo que pide el VFS.
- Caché de páginas en memoria dentro del Worker, con límite y evicción LRU (`sql.js-httpvfs` no tiene evicción; esto es una mejora deliberada).
- Cabecera de la BD (primeros 4 kB) y raíz del índice: precargadas de un tirón al arrancar.
- **El Service Worker no debe interceptar estas peticiones.** Regla explícita en Workbox.

### Plan de contingencia
`ProductSource` es una interfaz. Existen dos implementaciones de L1:
- `SqliteHttpSource` — la de arriba.
- `JsonShardSource` — JSON particionado por prefijo de EAN, sin WASM.

Si el VFS falla en algún navegador, se degrada a la segunda sin tocar el resto de la app.

---

## D5. Escáner de códigos de barras

Estrategia de dos niveles por detección de capacidad:

```
¿existe window.BarcodeDetector y soporta ean_13?
  sí  → usarlo (nativo, coste 0 kB)
  no  → cargar zxing-wasm bajo demanda (414 kB gzip)
```

**Dónde existe realmente el detector nativo:** Chrome sobre Android, ChromeOS y macOS. **No existe** en Chrome sobre Linux ni Windows, ni en Firefox ni en Safari (Safari lleva "en consideración" desde 2024). Verificado: Chrome 143 sobre Linux devuelve `false`. Es decir, **en escritorio el camino real es zxing-wasm**, no el nativo.

`html5-qrcode` se descartó: está sin mantenimiento, igual que su dependencia `zxing-js`.

El WASM **no se carga hasta que el usuario abre la cámara o sube una foto**, y se sirve desde nuestro propio origen (ver D11).

Formatos: `ean_13`, `ean_8`, `upc_a`, `upc_e`, `code_128`, `itf`.

Todo código leído pasa por validación del dígito de control antes de consultar la API: con luz mala un escaneo puede devolver un código sintácticamente válido pero equivocado, y consultarlo gastaría cupo del límite de 15 req/min.

---

## D6. Alcance de cosmética: banderas, no puntuación

Open Beauty Facts tiene 75.182 productos y los códigos de Nivea/L'Oréal probados **no estaban** [verificado]. Y la metodología tipo EWG está científicamente cuestionada por confundir **peligro** con **riesgo** (ignora concentración, vía de exposición y si el producto se enjuaga).

Por eso, en cosmética **no se emite un número 0–100**. Se emite:
- Banderas regulatorias: Anexo II (prohibidos) / III (restringidos) del Reglamento (CE) 1223/2009.
- Alérgenos de fragancia de declaración obligatoria presentes.
- Transparencia: ¿está publicada la lista INCI completa?

Es menos vistoso y mucho más defendible.

---

## D7. Almacenamiento local

| Qué | Dónde |
|---|---|
| Shell de la app, taxonomías, iconos | Cache API (Workbox) |
| Productos cacheados, historial, cola L3 | IndexedDB vía Dexie |
| Páginas de SQLite | Memoria del Worker (LRU) |
| Preferencias (idioma, país, perfil) | localStorage |

---

## D8. Licencia y cumplimiento

- La app: MIT.
- **Los datos derivados de OFF/OBF: ODbL** — share-alike obligatorio. El repo de la BD lleva su propia `LICENSE` ODbL y la app muestra la atribución a Open Food Facts en la ficha de cada producto.
- `User-Agent` obligatorio en toda llamada a OFF, en formato `AppName/Version (email)`.
- Aviso sanitario visible: la app informa, no diagnostica ni prescribe.

### Sin credenciales, y sin datos personales

El proyecto no contiene ni necesita credenciales: las lecturas de OFF no requieren autenticación y no hay servidor propio. No hay nada que rotar ni que filtrar.

La identificación ante OFF (`app_name`, `app_version`) es pública y no es autenticación. Va en la cadena de consulta porque `User-Agent` es una *forbidden header name* en la especificación Fetch: el navegador la descarta sin avisar, de modo que fijarla **parece** cumplir la norma de OFF sin cumplirla.

No se incluye ninguna dirección de correo en el código. Un repositorio público publica para siempre lo que contenga, y para identificar la app bastan nombre y versión.

También se desactivó el sourcemap del Service Worker (`workbox.sourcemap: false`): Workbox incrusta en él rutas **absolutas** del sistema de quien compila (`/home/<usuario>/...`), que acabarían publicadas.

---

## D9. Despliegue

GitHub Pages (o Cloudflare Pages) para la app. La BD SQLite **en un repo separado** servido por jsDelivr, por dos razones:
- Mantiene el repo de la app pequeño y clonable.
- Aísla la licencia ODbL de los datos de la licencia MIT del código.

Límites a respetar: 100 MB por archivo en GitHub, 20 MB por archivo en jsDelivr. Si el snapshot supera 100 MB, se parte en varios archivos SQLite por región (`es.sqlite3`, `latam.sqlite3`, `global-top.sqlite3`).


---

## D10. Verificación en navegador real

Dos bancos de pruebas se compilan como entradas aparte, fuera del bundle de la app. No son código desechable: comprueban cosas que ningún test de Node puede comprobar (XHR síncrono en Worker, `Range`, CORS, interacción con el Service Worker, decodificación WASM).

### `vfs-check.html` — capa L1

Resultado medido el 2026-09-16, **6 de 6**:

| Comprobación | Resultado |
|---|---|
| El servidor responde 206 a `Range` | `Content-Range: bytes 0-99/1183744` |
| Cabecera de SQLite correcta | `SQLite format 3`, `page_size: 4096 B` |
| El Worker abre la base remota | 136 ms |
| Consulta por código de barras | "Tomato Ketchup", Heinz, Nutri-Score D, 53 ms |
| Búsqueda por texto (FTS5) | 5 resultados en 194 ms |
| **Eficiencia** | **176 kB transferidos de 1,18 MB = 14,9%** |

Ese último número es la justificación entera de la arquitectura: se consulta una base remota descargando una fracción de ella.

### `scanner-check.html` — decodificador

Genera EAN-13 sintéticos dibujando sus barras según la norma y los decodifica con el mismo motor que usa la cámara. Separa dos fallos que desde fuera parecen el mismo: "el decodificador no funciona" y "la cámara no enfoca".

Resultado, **7 de 7**: decodifica en 1–5 ms incluso con un ancho de módulo de 1 píxel.

---

## D11. Dos fallos encontrados por esta vía

Ambos se manifestaban igual desde fuera —la cámara se enciende pero no reconoce nada— y ninguno era el decodificador.

**1. `zxing-wasm` descargaba su WASM desde `fastly.jsdelivr.net` en tiempo de ejecución.**
Es su comportamiento por defecto. En una PWA que debe funcionar sin conexión es inaceptable, y si el CDN tarda o está bloqueado el escaneo falla en silencio. Corregido anulando `locateFile` para servir el binario desde nuestro propio origen, con lo que además queda precacheado por el Service Worker.

**2. Cada re-render destruía el elemento `<video>`.**
`render()` reconstruye el DOM con `innerHTML`. El escáner se quedaba analizando un nodo desconectado del documento. Corregido con un `<video>` creado una sola vez que se reinserta en su contenedor tras cada render.

### Mitigaciones añadidas para webcams

`BarcodeDetector` nativo **no existe en Chrome sobre Linux ni Windows** (verificado: Chrome 143 en Linux devuelve `false`), así que en escritorio todo depende de zxing-wasm sobre una webcam de foco fijo, que es el caso más difícil.

- Se pide 1920×1080 en vez de 1280×720: más píxeles por barra.
- Se analiza primero un **recorte central** (84% × 42%) y solo después el fotograma completo.
- `focusMode: continuous` donde el dispositivo lo permita.
- Linterna, si el dispositivo la expone.
- **Escaneo desde foto** (`capture="environment"`): en móvil dispara la cámara del sistema, que enfoca de verdad y captura a resolución completa. Es el camino más fiable, y con webcams de escritorio a veces el único que funciona.
- Panel de diagnóstico en la propia app: motor en uso, resolución, fotogramas analizados, detecciones y descartes por dígito de control.

## Logotipo Nutri-Score: marca registrada, con vía para aplicaciones

Se muestra el **logotipo oficial** de Santé publique France, servido desde la propia
aplicación (`public/nutriscore/*.svg`, versión neutra 240×130, 52 kB los cinco).

El *Règlement d'usage* (edición de marzo de 2025) lo permite explícitamente en su
**artículo 4.1**:

> *«Par exception, les éditeurs de logiciels et d'applications disposent d'un droit
> d'usage de la Marque Nutri-Score à des fins […] d'information du public.»*

pero con dos condiciones:

1. **Solicitud previa por correo al regulador competente del territorio**, *«avant tout
   usage»*. **Está pendiente.** Se implementó antes de cursarla por decisión explícita.
2. Respeto estricto del **ANEXO 2: Charte graphique**. Por eso los archivos se usan tal
   cual: sin recolorear, sin filtros ni en modo oscuro, sin recortar y con la proporción
   intacta. Los colores reales del logotipo no son los que citan los artículos
   divulgativos — el verde de la A es `#00803D`, no `#038141` — así que redibujarlo de
   memoria no habría cumplido la carta.

El artículo 8.2 prohíbe además desarrollar o usar signos *similares*, lo que hace que un
distintivo propio con los colores de la marca no sea una alternativa más segura, sino
menos.
