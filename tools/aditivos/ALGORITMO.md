# Clasificación de aditivos — primer borrador

> **Estado: estructura construida y poblada, penalizaciones sin adoptar.**
> Nada de esto toca todavía el motor de puntuación de la aplicación. Ver
> «Lo que falta».

## El problema que resuelve

La clasificación actual sale de un único campo de la taxonomía de Open Food
Facts, `efsa_evaluation_overexposure_risk`. Medido sobre productos reales de
México: cubre el **23,6%** de las apariciones de aditivos. El 76% restante cae
en un mismo cubo con −1,5 puntos, y ahí conviven

    E330  ácido cítrico       111.375 apariciones   −1,5
    E102  tartrazina           24.982               −1,5
    E171  dióxido de titanio   (prohibido en la UE)  −1,5

Además esa fuente **está congelada en 2019**: los colaboradores de Open Food
Facts transcribían los dictámenes a mano y dejaron de hacerlo. No hay ninguna
tubería automática detrás que se pueda reparar — lo que también significa que
se puede continuar, y devolvérselo.

---

## Los dos ejes

La distinción que organiza todo:

- **Peligro** — qué daño hace y a qué dosis. No depende del consumo.
- **Exposición** — si la gente llega a esa dosis con su dieta.

`riesgo = peligro × exposición`. Son **ortogonales**, y hay tres casos medidos
que lo demuestran:

| | Peligro | Exposición | EFSA concluye |
|---|---|---|---|
| E123 amaranto | teratógeno, IDA 0,15 | casi no se usa | **sin riesgo** |
| E250 nitrito | reversible, IDA 0,1 | muy consumido | **riesgo alto** |
| E407 carragenato | leve, IDA 75 | está en todo | **riesgo alto** |

Amaranto y nitrito son igual de potentes y acaban en extremos opuestos. Por eso
una escala construida solo sobre la IDA **no reproduce** las clasificaciones de
EFSA: se comprobó, y las medianas de «alto» y «moderado» coinciden en 5,0
mg/kg. No es un fallo del dato sino de la pregunta.

---

## Las fuentes

Seis, todas verificadas contra el dato real. Cada una responde a otra cosa;
ninguna sirve sola.

| Fuente | Responde | Cobertura | Al día | Licencia |
|---|---|---|---|---|
| **Wikidata** | quién es esta sustancia | 671 items | sí | CC0 |
| **Cellar 1333/2008** | ¿está autorizado? | 380 aditivos | 2026 | legislación UE |
| **Cellar CLP Anexo VI** | ¿es CMR? | 6 aditivos, 1.365 CAS | 2026 | legislación UE |
| **EFSA OpenFoodTox 3.0** | ¿a qué dosis daña? | 100 con IDA, 41 con efecto | 2026 | CC-BY-ND |
| **IARC Monographs** | ¿causa cáncer? | 30 aditivos, 1.040 entradas | sí | — |
| **Open Food Facts** | ¿se supera el límite? | 74 con riesgo, 131 ANSES | **no, 2019** | ODbL-1.0 |

**PubChem** se usa solo como **verificador externo**, no se integra: confirmó 53
de 59 CAS directamente o por sinónimo.

Sobre la CC-BY-ND de OpenFoodTox: prohíbe **republicar su tabla**, no usar los
hechos. Se consulta al construir y se publica nuestra clasificación con su
cita. Los hechos no son objeto de derechos de autor.

---

## La identidad: cómo se enlaza todo

**Ninguna fuente comparte identificador con las demás.** Se comprobó campo a
campo: en las 7.890 sustancias de referencia de OpenFoodTox **no existe ningún
campo de número E**.

    Open Food Facts   en:e330      número E, ningún identificador químico
    Cellar            E 330        número E y nombre, nada más
    OpenFoodTox       77-92-9      CAS y estructura, NINGÚN número E

**Wikidata es el puente**, y resultó ser también la base: mantiene P628 (número
E) y P231 (CAS), y de 620 items con número E, 471 traen CAS. No hay fichero
oficial que haga ese mapeo —se buscó— así que esto es lo que la comunidad
construyó en su lugar.

    Open Food Facts ──número E──▶ Wikidata ──CAS──▶ OpenFoodTox ──▶ peligro

**Manda el item que Open Food Facts ya enlaza.** Buscar por número E cae en el
item del GRUPO —«pirofosfato», «antocianina»— que o no tiene CAS o tiene el de
otra sustancia. Revisadas las 89 discrepancias, en 26 el de Open Food Facts era
el correcto y en ninguna el nuestro. Eso subió la cobertura del 68,0% al 77,9%
de apariciones reales.

### Tres vías de enlace con OpenFoodTox, con precedencia

| Vía | Qué enlaza | n |
|---|---|---|
| `cas` | compuesto concreto — **manda** | 89 |
| `numero-e-en-nombre` | dictamen de grupo que declara su rango | 9 |
| `manual-grupo` | dictamen de grupo mapeado a mano | 12 |

**El dato específico manda sobre el de grupo**, y solo a igualdad gana la IDA
menor. El ácido fosfórico (E338) tiene IDA 2,25 propia y 40 por el dictamen de
los fosfatos: vale 2,25. Una regla de «gana la menor» daba lo mismo aquí por
casualidad, pero cogería la del grupo en cuanto el grupo fuera más restrictivo.

---

## La clasificación

### Nivel: qué tipo de daño

Ordena por **naturaleza**, no por dosis.

| Nivel | Efecto | Por qué ahí |
|---|---|---|
| 1 | genotóxico / carcinogénico | no se les asume dosis segura |
| 2 | teratogénico / reproductivo / del desarrollo | ventana irrecuperable |
| 3 | endocrino | sistémico y de largo plazo |
| 4 | neurotóxico | tejido que no regenera |
| 5 | órgano diana (riñón, hígado, cardiopulmonar) | daño localizado |
| 6 | inmunotóxico / hematopoyético | funcional, reversible |
| 7 | sistémico reversible | metahemoglobina, transaminasas |
| 8 | local / digestivo | molestia, no lesión |

**El nivel 1 no sale de OpenFoodTox**, y no por falta de datos: en las catorce
etiquetas de efecto crítico de las 753 sustancias **no aparece ni una**
relacionada con cáncer o genotoxicidad. Es estructural — a un carcinógeno
genotóxico no se le asigna IDA. Lo pueblan IARC, el Anexo VI del CLP y el
motivo `genotoxicidad` de ausencia de IDA. Tres señales que entran por fuera y
cubren justo el hueco que la escala no puede ver.

### Certeza: cuánto se sabe

**Nivel y certeza son dimensiones distintas.** Mezclarlas dejaba sin nivel a
seis de los siete aditivos con IARC 2B —aspartamo, dióxido de titanio, bromato
potásico—, que acababan valiendo lo mismo que uno sin ningún dato.

| Fuente | Certeza |
|---|---|
| IARC 1 · CLP `Carc. 1A` | confirmada |
| IARC 2A · CLP `Carc. 1B` | probable |
| IARC 2B · CLP `Carc. 2` | posible |
| efecto crítico de EFSA | establecida (está medido) |

### Modulación: la IDA dentro del nivel

**La IDA no es la clase: sitúa dentro de ella.** Sin esto el nivel engaña:

    E523 alumbre amónico   IDA 0,14   posición 0      el más potente
    E123 amaranto          IDA 0,15   posición 0,25
    E321 BHT               IDA 0,25   posición 0,5
    E110 amarillo crepús.  IDA 1      posición 0,75
    E100 curcumina         IDA 3      posición 1      el menos potente

Los cinco «afectan al desarrollo». Tratar el colorante del curry igual que el
alumbre sería el mismo error de categoría que este proyecto existe para
corregir. `posicion_en_nivel` se calcula de los datos, no de un criterio.

---

## El algoritmo

Peldaños en orden; **gana el primero que encaje**. Donde coincidan dos señales
manda la más grave, y la discrepancia se anota en vez de resolverse en
silencio.

| # | Condición | Fuente |
|---|---|---|
| 1 | No autorizado en alimentos | Cellar 1333/2008 |
| 2 | CMR del Anexo VI, o IARC 1/2A/2B | CLP · IARC |
| 3 | Sin IDA por genotoxicidad | OpenFoodTox |
| 4 | Efecto crítico → niveles 2–8 | OpenFoodTox |
| 5 | Sin datos | — |

**Recargos**, que son el eje de exposición: sobreexposición alta **+10**,
moderada **+5**, ANSES **+4**, grupos vulnerables **+5**, IDA derivada sin
margen de seguridad **+3**.

### Penalizaciones — BORRADOR, sin adoptar

Sobre 100 dentro del bloque de aditivos, que pesa el 20% de la nota. Cada
aditivo adicional cuenta ×0,72.

| | Penalización |
|---|---|
| No autorizado | **60** |
| Nivel 1, certeza confirmada · probable · posible | **40 · 30 · 20** |
| Niveles 2–8 | **12 · 10 · 8 · 7 · 6 · 5 · 4** |
| Sin datos | **3** |
| **Sin aditivos** | **0** |

Modulado por `posicion_en_nivel`: ×1,25 el más potente del nivel, ×0,75 el
menos.

**La escala es discontinua a propósito.** De las 753 sustancias evaluadas, 667
tienen efecto crítico: el 89%. No es excepcional, es **cómo se deriva cualquier
IDA**. «Efecto crítico: developmental» no dice que el aditivo sea peligroso,
dice qué efecto apareció antes al subir la dosis. En cambio IARC grupo 1 o CLP
`Carc. 1B` **sí son veredictos**: alguien evaluó y concluyó que puede causar
cáncer. Un degradado suave del 1 al 8 trataría las dos cosas como si fueran la
misma.

**Ningún peldaño vale 0.** El 0 es no llevar aditivos.

### La prohibición no se ajusta por región

**Decidido:** prohibido en cualquier jurisdiccion penaliza igual en todos los
paises. No se rebaja porque el producto sea legal donde se vende.

El razonamiento: una prohibicion no se decreta sin expediente. El E171 se
retiro en la UE porque EFSA **no pudo descartar genotoxicidad**, y esa
evidencia existe igual en Mexico aunque su normativa sea mas laxa. Esta
herramienta informa de lo que se consume, no de lo que es legal consumir.

Medido: afecta a **9.598 apariciones (0,70%)** y a **113 de 4.769 productos
mexicanos con aditivos (2,4%)**.

CONSECUENCIA QUE HAY QUE ASUMIR: el principio dice «prohibido en alguna
jurisdiccion», pero hoy **solo miramos una**. La unica fuente regulatoria es
europea, asi que en la practica se aplica el criterio de la UE. El efecto es
asimetrico: el bromato potasico (E924b) esta prohibido en la UE y permitido en
Estados Unidos y lo detectamos, pero un aditivo permitido en la UE y prohibido
en otra parte se nos escaparia. Para que el principio sea el enunciado hace
falta al menos una segunda jurisdiccion -la FDA publica sus retiradas y no se
ha investigado-.

---

## Seis trampas comprobadas

Todas costaron un error real antes de detectarse.

**1. Estar en el reglamento no es estar autorizado.** El E171 sigue listado en
la lista B1 porque se usa en medicamentos, con una nota que dice que no está
autorizado en alimentos. Un `grep` del número E lo habría dado por bueno.

**2. La Parte E cita grupos, no miembros.** «Grupo I» aparece 211 veces en vez
de enumerar sus aditivos. Mirar solo la Parte E daba por prohibidos el
glutamato monosódico, los guanilatos y los inosinatos: 38 falsos negativos.

**3. El reglamento abrevia con rangos.** `E 535-538 Ferrocianuros`. El
ferrocianuro potásico está autorizado únicamente por esa vía.

**4. `CriticalEndpoint` no es «lo peor que hace».** Es el efecto que fijó el
límite. Para el nitrito dice «metahemoglobina» mientras IARC lo clasifica 2A
por nitrosación endógena. Una ficha construida solo sobre el endpoint crítico
sería técnicamente correcta y engañosa en lo que importa.

**5. Los dictámenes de grupo no tienen CAS.** «Phosphoric acid-phosphates
(E 338–341, E 343, E 450–452)» con IDA 40 era invisible al cruce por CAS, y con
ella los fosfatos enteros: 33 aditivos, el 8,5% de las apariciones.

**6. Un enlace no es un dato.** Una primera versión contaba como «miembro con
dato» a cualquiera que llegara a una sustancia de OpenFoodTox. Eso decía «E450
hereda de 3 de 11» cuando ninguno de esos tres tenía IDA: solo tenían enlace.
De diez familias que parecían heredar, solo una traía un valor real.

Las trampas 2, 3 y 5 son **la misma de fondo**: tratar un grupo como si fuera
un individuo.

---

## Estado de los datos

```
aditivos    671   identidad + evidencia enlazada
oft         753   IDA, motivo de ausencia, efecto crítico
clp       1.365   clasificación CMR europea
iarc      1.040   clasificación de cáncer
cellar      339   estado legal por número E
off         260   sobreexposición, ANSES, dictámenes
familias     45   grupos y sus miembros
```

| | Aditivos |
|---|---|
| Estado legal | 380 |
| IDA | 100 |
| Efecto crítico | 41 (20 con etiqueta útil) |
| Sobreexposición | 74 · ANSES 131 |
| IARC | 30 |
| CMR (CLP) | 6 |
| **Nivel de gravedad** | **50** |
| No autorizados | 3 |

Reparto por nivel: **1**→15 · **2**→6 · **4**→1 · **5**→8 · **6**→5 · **7**→15

---

## Banderas de revisión

Nada se descarta en silencio. Un enlace dudoso informa más que un hueco.

| Bandera | n | Qué pide |
|---|---|---|
| `gravedad.desacuerdo` | 3 | Dos fuentes evaluaron y concluyeron distinto |
| `gravedad.solo_una_fuente` | 12 | El veredicto se apoya en una sola pata |
| `gravedad.ida_sin_margen` | 1 | IDA derivada con factor 1, no 100 |
| `revisar: nombres-no-casan` | 18 | Posible CAS equivocado en Wikidata |
| `revisar: numero-e-discrepa` | 13 | El item enlazado declara otro número E |
| `familia-sin-dato-ni-miembros` | 35 | Ni la familia ni sus miembros llegan a datos |

Los tres desacuerdos: **E231** (IARC 3 «no clasificable» frente a CLP
`Carc. 2`), **E240** (IARC 1 frente a `Carc. 1B, Muta. 2`) y **E924b** (IARC 2B
frente a `Carc. 1B`, donde la UE es más severa).

**Veredicto contra veredicto no es lo mismo que veredicto contra silencio.** El
grupo 3 de IARC es una conclusión; no tener entrada en el Anexo VI es no haber
evaluado. Se marcan por separado porque piden cosas distintas.

---

## Decisiones manuales

Dos ficheros con las decisiones que no se pueden automatizar, cada una con su
justificación y las descartadas con su motivo.

**`manual-iarc.json`** — IARC clasifica a veces una **exposición** y no una
sustancia, y esas entradas no llevan CAS: son 173, de las cuales 80 están en
grupo 1 o 2A. Al revisarlas, 49 son ajenas a un alimento y de las 31 restantes
casi todas son categorías dietéticas. **Para aditivos quedó una sola**:
nitratos y nitritos, grupo 2A, aplicable a E249–E252, **condicional** —«bajo
condiciones que producen nitrosación endógena»— y esa condición no se puede
omitir al mostrarlo.

Se descartó «Benzidine, dyes metabolized to» (grupo 1): son colorantes de
textil y cuero; los azoicos alimentarios no derivan de bencidina. La tentación
de aplicarlo a todos los azoicos era justo el atajo que este proyecto evita.

**`manual-grupos.json`** — cuatro dictámenes de grupo que no se cruzan solos,
el mayor el de los sulfitos (IDA 0,7, **9.654 apariciones**, no cruza por
grafía `sulfur`/`sulphur` y por ser grupo). Y cinco descartados con su motivo:
cobalto, dos plaguicidas, aromas y un material de envase.

---

## Cómo se ejecuta

Todo en local, sin dependencias fuera de la librería estándar, cargando con
`mongoimport` del propio contenedor. No es un proceso de integración continua:
se ejecuta a mano, se revisa el resultado y se publica.

```
wikidata-local.py   items completos de Wikidata a JSONL
extraer.py          lector de xlsx sin dependencias
enlazar.py          enlaces OFF ↔ OpenFoodTox sobre los items
familias.py         grupos y miembros
cellar.py           estado legal
clp.py              clasificación CMR
oft.py              IDA y efecto crítico
off.py              sobreexposición
iarc.py             clasificación de cáncer
gravedad.js         nivel, certeza y modulación
```

**Los extractores abortan si la estructura cambia** en vez de devolver datos a
medias: `cellar.py` si no encuentra las cinco partes del anexo, `iarc.py` si
bajan de 1.000 registros, `clp.py` si la tabla trae menos de 3.000 filas.

---

## Lo que falta

1. **Adoptar las penalizaciones.** Los números del borrador son criterio, no
   dato. Lo que sí está fundado es la *forma* —la discontinuidad entre veredicto
   y descripción, y que la modulación salga de los datos—. Falta **medir su
   efecto sobre productos reales**: cuántos cambian de banda y si alguno acaba
   en un sitio absurdo.
2. **Publicar.** Decidido: Parquet para la base general y SQLite para lo que
   consume la aplicación, partido por clave en archivos completos e
   independientes de 45 MB.
3. **Conectarlo al motor.** Nada de esto toca aún `src/core/scoring/`.
4. **Los 35 sin datos de familia** y las 18 discrepancias de nombre siguen sin
   revisar uno a uno.
