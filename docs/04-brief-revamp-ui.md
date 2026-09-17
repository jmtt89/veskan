# Brief para el revamp de UI de Veskan

Documento pensado para pasarse íntegro a una herramienta de diseño asistido.
Todo lo que sigue está verificado contra la aplicación real: las vistas
enumeradas existen, los estados descritos se dan, y las restricciones técnicas
son reales, no supuestos.

---

# PROMPT

## 1. Qué es y quién lo usa

**Veskan** (https://jmtt89.github.io/veskan/) es una PWA que escanea el código de
barras de un producto y devuelve una **puntuación de salud de 0 a 100, abierta y
auditable**, calculada con Nutri-Score 2023, la clasificación NOVA de
procesamiento, las evaluaciones de aditivos de la EFSA y el modelo de perfil de
nutrientes de la OPS/OMS.

**Contexto de uso real, y esto condiciona todo el diseño:**

- **De pie en un pasillo de supermercado**, con el carro en una mano y el móvil
  en la otra. Uso **a una mano**, con el pulgar.
- Iluminación mala, prisa, y a veces **sin cobertura**.
- El usuario quiere una respuesta en **menos de tres segundos**: ¿lo compro o no?
- Mercado principal: **España y Latinoamérica**. Interfaz en español.
- Perfil: público general, no expertos en nutrición. Edades muy variadas.

**Competencia directa:** Yuka. Su interfaz es más atractiva que la nuestra pero
recibe una crítica recurrente que debemos convertir en ventaja: *"colapsar un
producto en una sola nota puede engañar, porque el matiz está en el porqué"*, y
*"es más bonita, pero cuesta encontrar la información que buscas"*.

**Nuestra tesis, que el diseño debe hacer visible:** la nota es auditable. El
usuario puede ver de dónde sale cada punto, con qué fuente y con cuánta
confianza. **La transparencia es la característica principal del producto, no
letra pequeña.** El reto de diseño es exhibirla sin sepultar la respuesta rápida.

---

## 2. Restricciones no negociables

**Técnicas:**

- PWA instalable, **sin servidor propio**. Todo se ejecuta en el navegador.
- **Sin framework de UI**: Vite + TypeScript nativo, plantillas de cadena y
  delegación de eventos. Las propuestas deben poder implementarse con HTML, CSS
  y TypeScript sin dependencias. **Nada de React, Tailwind ni librerías de
  componentes.**
- CSS moderno sí: custom properties, `color-mix()`, `clamp()`, container
  queries, `:has()`, view transitions, `@layer`.
- Rendimiento: el bundle inicial son ~23 kB gzip. **No introducir dependencias
  pesadas.** Los WASM del escáner (414 kB) y de SQLite (404 kB) se cargan bajo
  demanda y eso no debe cambiar.
- Peso táctil: objetivos de **44×44 px mínimo**, respeto de `safe-area-inset`.

**Accesibilidad (la app está hoy en 100/100 en Lighthouse y no puede bajar):**

- **WCAG 2.2 nivel AA** como suelo legal: 4.5:1 en texto normal, 3:1 en texto
  grande y en componentes de interfaz. Usa **APCA** como comprobación
  perceptual más estricta encima, no como sustituto.
- `prefers-color-scheme`, `prefers-reduced-motion` y `prefers-contrast`
  respetados.
- HTML semántico, regiones ARIA en vivo para los cambios asíncronos, gestión
  explícita del foco al navegar entre vistas.
- Modo oscuro con **grises elevados**, nunca negro puro sobre texto claro, por
  la halación.

**Éticas, y son parte del producto:**

- Es una app de salud: **no puede aparentar más certeza de la que tiene**. Si
  faltan datos, el diseño debe comunicarlo, no disimularlo.
- Los colores del **Nutri-Score son marca registrada** de Santé publique France
  y tienen carta gráfica: `#038141 #85bb2f #fecb02 #ee8100 #e63e11`. **No se
  pueden alterar.** Lo que sí se ajusta es el color del texto encima (blanco
  sobre la A, negro sobre B/C/D/E, por contraste medido).
- Sin patrones oscuros, sin gamificación que presione, sin métricas de vanidad.

---

## 3. Sistema de diseño actual (punto de partida, no camisa de fuerza)

Tokens en `:root`, redefinidos bajo `prefers-color-scheme: dark`. Los colores
actuales ya cumplen AA con contraste calculado, no estimado:

```
--accent: #0b7a44        (5.41:1 con texto blanco)
--accent-fg: #0b7a44     (claro) / #34d399 (oscuro)  — verde como TEXTO
--danger: #d93025    --warning: #f9a825
bandas de puntuación, todas ≥4.5:1 con texto blanco encima:
  excelente #0d864b · bueno #59802f · mediocre #a46705 · malo #d73b0b · muy malo #d93025
--radius: 14px   --gutter: 16px   tipografía del sistema
```

**Puedes reemplazar la paleta entera**, pero toda propuesta de color debe venir
con su ratio de contraste calculado para cada uso (fondo con texto encima, texto
sobre fondo) en ambos temas. El verde de marca tuvo que separarse en dos tokens
porque tenía dos usos incompatibles con un solo valor: fondo con texto blanco
(necesita ser oscuro) y texto sobre fondo en modo oscuro (necesita aclararse).
Ten presente esa trampa.

---

## 4. Inventario exhaustivo de vistas y estados

**Quiero que revises y propongas las SEIS vistas y TODOS los estados listados.
Ninguno puede quedarse fuera, aunque tu propuesta sea "esta se queda como
está".** Para cada una: qué cambia, por qué, y qué patrón UX lo justifica.

### V1 · Escanear (vista de inicio)

| Estado | Descripción |
|---|---|
| V1.a | Cámara inactiva: botón "Activar cámara" |
| V1.b | Cámara activa: visor de vídeo, retícula con barrido animado, botón de detener, botón de linterna (solo si el dispositivo la expone) |
| V1.c | Permiso de cámara denegado |
| V1.d | Error de cámara (dispositivo ocupado, sin cámara…) |
| V1.e | Escaneo desde foto: campo de archivo con `capture="environment"` |
| V1.f | Entrada manual del código de barras |
| V1.g | Panel de diagnóstico colapsable: motor en uso (nativo o WASM), resolución, fotogramas analizados, detecciones, descartes por dígito de control, último error |
| V1.h | Cargando tras detectar un código |

*Contexto que importa: `BarcodeDetector` nativo no existe en Chrome sobre Linux
ni Windows, ni en Firefox ni Safari, así que en escritorio siempre se usa WASM
sobre una webcam de foco fijo — el caso más difícil. El escaneo desde foto suele
ser el camino más fiable y hoy está enterrado bajo el visor.*

### V2 · Resultado (alimento)

| Estado | Descripción |
|---|---|
| V2.a | Cargando |
| V2.b | **Producto completo** — el estado principal de la app |
| V2.c | Producto con datos insuficientes: existe en la base pero sin nombre, ingredientes ni tabla nutricional |
| V2.d | Producto no encontrado en ninguna fuente |
| V2.e | Límite de peticiones alcanzado (15/min de Open Food Facts) |
| V2.f | Error de red |

**Composición actual de V2.b, de arriba abajo:**

1. Cabecera: dial circular con la nota 0–100, nombre, marca, cantidad, chip de banda
2. Barra de confianza: nivel calculado + qué datos faltan + notas
3. "De dónde sale la puntuación": 4 filas con contribución y peso (55/20/20/5)
4. Nutri-Score: escala A–E con la letra activa destacada, y desglose expandible de puntos negativos y positivos
5. Advertencias OPS/OMS: sellos octogonales negros de exceso + tabla de valores frente a umbrales
6. NOVA: grupo 1–4 con etiqueta y descripción
7. Aditivos: por cada uno, nombre, chip de riesgo, clases, descripción, grupos poblacionales que superan la IDA, enlace a la evaluación de la EFSA
8. Tabla nutricional por 100 g
9. Ingredientes y alérgenos
10. Nota de fuente, fecha de última edición, enlace para corregir, aviso sanitario

*Es mucha información y está toda al mismo nivel jerárquico. **Este es el
problema de diseño central del proyecto.***

### V3 · Resultado (cosmética)

| Estado | Descripción |
|---|---|
| V3.a | Con lista INCI: banderas por severidad (prohibido / restringido / alérgeno / info) |
| V3.b | Sin lista INCI: aviso de transparencia insuficiente |

*Deliberadamente **no lleva nota numérica**, porque las puntuaciones tipo EWG
confunden peligro con riesgo. El diseño debe explicar esa ausencia sin que
parezca una carencia del producto.*

### V4 · Historial

| Estado | Descripción |
|---|---|
| V4.a | Vacío (primer uso) |
| V4.b | Lista: miniatura, nombre, marca, mini-nota circular con color de banda |
| V4.c | Acción de vaciar historial |

*Existe `toggleStar` en el modelo de datos, con índice en base de datos, pero
**no tiene ninguna interfaz**. Los favoritos están a medio construir.*

### V5 · Buscar por nombre

| Estado | Descripción |
|---|---|
| V5.a | Sin copia local: aviso que remite a elegir país |
| V5.b | Campo de búsqueda listo |
| V5.c | Buscando |
| V5.d | Con resultados |
| V5.e | **Sin resultados — este estado no existe hoy y hace falta** |

### V6 · Participar

| Estado | Descripción |
|---|---|
| V6.a | "Próximamente" (actual): explicación de cómo funcionará el alta vía OAuth con Open Food Facts, y enlace para aportar en su web mientras tanto. La pestaña lleva un punto ámbar de aviso |
| V6.b | Formulario completo, ya escrito y oculto tras un interruptor: código, nombre, marca, cantidad, ingredientes y 8 campos nutricionales |

### V7 · Método y fuentes

| Estado | Descripción |
|---|---|
| V7.a | Tabla de pesos del algoritmo |
| V7.b | "En qué nos diferenciamos": 4 puntos frente a la competencia |
| V7.c | Fuentes con enlaces |
| V7.d | **Copia local por país**: selector con productos y MB de cada uno, barra de progreso de descarga, estado listo/error, fecha de generación |
| V7.e | Privacidad |
| V7.f | Aviso sanitario |

### Componentes transversales

Barra de pestañas inferior (5 destinos, con punto de aviso), cabecera con
retroceso, avisos info/advertencia/error, dial de puntuación en SVG, barra de
confianza, escala Nutri-Score, sellos octogonales, chips de riesgo de aditivo,
tabla de nutrientes, estado vacío, indicador de carga.

---

## 5. Qué quiero que produzcas

1. **Una revisión de las 7 vistas y todos sus estados.** Para cada una: qué
   cambia, por qué, y qué principio o patrón lo respalda. Si una vista no
   necesita cambios, dilo y justifícalo — es una respuesta válida.
2. **Propuestas de flujo o pantallas nuevas** donde los patrones establecidos
   digan que hacen falta. Ver la sección 7.
3. **Un sistema de diseño**: tokens primitivos y semánticos, escala tipográfica
   fluida, escala de espaciado, elevación, radios, duraciones y curvas de
   movimiento. Con los ratios de contraste calculados.
4. **La jerarquía de la vista de resultado resuelta.** Es el entregable más
   importante.
5. **Especificaciones de los estados de carga, vacío y error**, que hoy están
   resueltos con un spinner genérico y un párrafo.

---

## 6. Patrones y técnicas que espero ver aplicados

Úsalos con criterio, no como lista de la compra. Si descartas alguno, dilo.

**Arquitectura de la información y jerarquía**
- **Progressive disclosure** por capas: veredicto → razones → evidencia. Es la
  técnica central para resolver la vista de resultado. Un estudio de 2026 halló
  que mejora el aprendizaje percibido: la gente entiende mejor el sistema cuando
  la información se revela por etapas.
- **Bento grid** para el desglose de la puntuación: la jerarquía es implícita —
  las tarjetas grandes se leen primero, las pequeñas aportan el detalle.
- **Efecto Von Restorff** (aislamiento) aplicado a la nota: debe ser el único
  elemento de su categoría visual en toda la pantalla.
- **Ley de Hick** en la barra de pestañas y en las acciones del resultado.
- **Principios de Gestalt**: proximidad y región común para agrupar los cuatro
  bloques del algoritmo.
- **Information scent** en el historial y la búsqueda.

**Ergonomía móvil**
- **Thumb zone**: el 75% de los toques son con el pulgar y la mitad de la gente
  usa el móvil a una mano. Las acciones primarias van en la zona baja. Hoy el
  botón de "Buscar" del código manual está en la zona media-alta.
- **Ley de Fitts** en el tamaño y la posición de los objetivos táctiles.
- Considera un **disparador flotante y reubicable** para el escáner, en lugar de
  una acción fija: es el patrón que usan los escáneres profesionales para uso a
  una mano.

**Estados y percepción de rendimiento**
- **Skeleton screens** en lugar de spinners: dan contexto espacial y hacen que
  la espera se perciba más corta. Aplican a V2.a, V5.c y a la descarga de V7.d.
- **Estados vacíos** con acción, no solo con ilustración: primer uso, sin
  resultados, sin conexión, permiso denegado.
- **Optimistic UI** donde tenga sentido.
- **Microinteracciones con intención**: en 2026 el criterio es que el movimiento
  reduzca incertidumbre, no que decore. 150–250 ms, opacidad y transformación.

**Visualización de datos**
- La nota 0–100 y el desglose son visualización de datos: aplica **atributos
  preatentivos** y cuida el **data-ink ratio**.
- **Visualización explícita de la incertidumbre.** Esto es crítico y poco común:
  la app calcula un nivel de confianza y hoy lo muestra como una barra genérica.
  Merece un tratamiento propio.
- El color **nunca** puede ser el único portador de significado (bandas, sellos,
  chips de riesgo).

**Heurísticas de Nielsen especialmente pertinentes aquí**
- Visibilidad del estado del sistema (qué capa de datos respondió, si hay red).
- Correspondencia con el mundo real (los sellos octogonales son un lenguaje que
  el usuario latinoamericano ya conoce del envase).
- Prevención de errores antes que mensajes de error.
- Reconocer antes que recordar.

**Ley de Jakob**: esto se usa en un supermercado, compitiendo con Yuka. Lo
familiar gana. Innova en la transparencia, no en dónde está el botón de escanear.

---

## 7. Huecos detectados que puedes proponer resolver

Verificados en el código. Ninguno existe hoy:

1. **Sin onboarding.** El primer uso cae directo en una cámara apagada, sin
   contexto. Se busca **onboarding progresivo contextual**, no un carrusel.
2. **Favoritos a medio construir**: `toggleStar` existe en el modelo, con índice
   en base de datos, y no tiene interfaz.
3. **Sin estado "sin resultados"** en la búsqueda.
4. **Sin indicador de conexión**, pese a que la app funciona sin red cuando hay
   copia local descargada. El usuario no sabe que tiene esa capacidad.
5. **Sin invitación a instalar la PWA** (A2HS). Es una app para el supermercado:
   vivir en la pantalla de inicio es medio producto.
6. **Sin aviso de actualización disponible** cuando el service worker trae
   versión nueva.
7. **Sin comparación ni alternativas mejores.** Yuka lo tiene y es una de sus
   funciones más valoradas. Con nuestros datos es viable.
8. **Sin detalle de aditivo individual.** Hoy se pinta todo en línea y las
   listas largas son un muro de texto.
9. **La elección de país está enterrada** en "Método", cuando determina si la
   app funciona sin conexión. Probablemente pertenece al onboarding.
10. **El escaneo desde foto está enterrado** bajo el visor, siendo a menudo el
    camino más fiable.

---

## 8. Dirección visual

Busco algo que **parezca de 2026 sin envejecer en 2027**. Tendencias actuales, a
aplicar con criterio y solo donde aporten:

- **Profundidad espacial** sustituyendo al diseño plano: capas, sombras con
  intención, jerarquía por elevación.
- **Glassmorphism refinado**: translucidez sutil que genere profundidad real sin
  ruido visual. Nada de desenfoques pesados como los de 2020. Ojo: **el contraste
  manda sobre el efecto**, y hoy la cabecera y la barra de pestañas ya usan
  `backdrop-filter`.
- **Bento grid** para el desglose.
- **Tipografía expresiva** y fuentes variables con escala fluida (`clamp()`).
  Hoy se usa la del sistema y es defendible por rendimiento: si propones otra,
  justifica el coste.
- **Modo oscuro como ciudadano de primera**, no como variante.
- **Movimiento funcional**, siempre bajo `prefers-reduced-motion`.

**Lo que NO quiero:** decoración que compita con el dato, ilustraciones
genéricas de stock, degradados por moda, animaciones que retrasen la respuesta,
ni nada que haga parecer más certera una nota que el propio sistema marca como
de baja confianza.

---

## 9. Criterios de aceptación

Una propuesta es buena si:

1. Un usuario nuevo, de pie en un supermercado, obtiene **el veredicto en menos
   de 3 segundos** y puede llegar al porqué si quiere.
2. Todo es **alcanzable con el pulgar de una mano**.
3. **Cumple WCAG 2.2 AA** con ratios calculados, no estimados, en ambos temas.
4. La **incertidumbre se ve**: un producto con datos incompletos se distingue a
   simple vista de uno con datos completos.
5. Se implementa con **HTML, CSS y TypeScript sin dependencias**.
6. **Funciona sin conexión** y lo comunica.
7. Las **7 vistas y todos sus estados** están resueltos, ninguno olvidado.
8. La **transparencia se percibe como una característica**, no como ruido.

---

## 10. Formato de entrega

1. **Resumen ejecutivo**: los 5 cambios de mayor impacto y su justificación.
2. **Sistema de diseño**: tokens, tipografía, espaciado, color con ratios,
   elevación, movimiento.
3. **Vista por vista**, en el orden V1→V7, con todos los estados: diseño
   propuesto, qué cambia, por qué, y el patrón que lo respalda.
4. **Pantallas y flujos nuevos** que propongas, con su justificación.
5. **Mapa de flujos**: recorrido de primer uso, recorrido recurrente, y
   recuperación ante errores.
6. **Notas de implementación**: qué CSS moderno hace falta y qué degradación
   tiene en navegadores que no lo soporten.
7. **Lo que descartaste y por qué.** Esta sección me interesa tanto como el
   resto.

---

## Estado: implementado (2026-09-17)

El diseño devuelto (`Veskan revamp.dc.html`) está implementado. Los cinco
cambios que planteaba:

1. **Veredicto → razones → evidencia.** Nota y banda solas arriba; bento con los
   cuatro bloques y el **área proporcional al peso** (55 · 20 · 20 · 5); tablas
   plegadas y cerradas por defecto.
2. **La incertidumbre se ve.** Anillo exterior con el rango, «≈» delante del
   número, tres barras de confianza y qué falta. El rango **se calcula**: se
   vuelve a puntuar con los datos desconocidos en su mejor y peor caso.
3. **Todo en la zona del pulgar.** Cámara a pantalla completa; Foto, Código y
   Linterna abajo; teclado numérico propio.
4. **Cuatro pestañas.** Participar y Método pasan a «Más»; Guardado absorbe los
   favoritos, que ya existían en el modelo y no se exponían.
5. **Estados con acción.** Esqueletos con la forma del resultado; vacíos que
   dicen qué hacer; errores que ofrecen el camino alternativo. Indicador de red
   en la cabecera.

### Dónde nos apartamos del diseño, y por qué

- **«País y copia local» sigue siendo una lista de varios países**, no radios de
  uno solo. El diseño es anterior a que la aplicación soportara varios
  catálogos a la vez con actualización incremental; implementarlo al pie de la
  letra habría destruido esa función. Se conserva el comportamiento y se le
  aplica el lenguaje visual nuevo.
- **Manrope se autoaloja** (4,9 kB, subconjunto de cifras) en vez de enlazarse
  desde Google Fonts. Una hoja remota se cae sin red, y pedirla en cada visita
  entregaría la IP del usuario a un tercero: la propia interfaz promete que «la
  aplicación no envía ningún dato personal a ninguna parte».
- **El prototipo del disparador flotante reubicable no se ha implementado.** El
  escáner ya analiza en continuo, así que un botón de «leer ahora» no añade
  capacidad; moverlo por la pantalla sí añade estado y superficie de fallo.

### Verificado

- Accesibilidad **100** en Lighthouse, en el escáner y en el resultado con la
  evidencia desplegada.
- Contrastes del tema claro **medidos sobre lo renderizado**, no sobre la tabla:
  5,33 · 6,40 · 5,91 · 5,41 — todos por encima de 4,5:1.
- 1.011 tests.
