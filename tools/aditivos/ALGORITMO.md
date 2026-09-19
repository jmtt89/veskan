# Clasificación de aditivos

Estado: **estructura definida, penalizaciones sin fijar.** Ver «Lo que falta».

## El problema que resuelve

La clasificación actual sale de un único campo de la taxonomía de Open Food
Facts, `efsa_evaluation_overexposure_risk`. Medido sobre productos reales de
México: cubre el **23,6%** de las apariciones de aditivos. El 76% restante cae
en un mismo cubo con −1,5 puntos, y ahí conviven

    E330  ácido cítrico      111.375 apariciones   −1,5
    E102  tartrazina          24.982               −1,5
    E171  dióxido de titanio  (prohibido en la UE)  −1,5

Además esa fuente **está congelada en 2019**: los colaboradores de Open Food
Facts transcribían los dictámenes a mano y dejaron de hacerlo. No hay ninguna
tubería automática detrás que se pueda reparar.

## Dos ejes, no uno

La distinción que organiza todo, y que costó media sesión entender:

- **Peligro** — qué daño hace y a qué dosis. No depende del consumo.
- **Exposición** — si la gente llega a esa dosis con su dieta.

`riesgo = peligro × exposición`. Son ortogonales, y hay tres casos que lo
demuestran:

| | Peligro | Exposición | EFSA concluye |
|---|---|---|---|
| E123 amaranto | teratógeno, IDA 0,15 | casi no se usa | **sin riesgo** |
| E250 nitrito | reversible, IDA 0,1 | muy consumido | **riesgo alto** |
| E407 carragenato | leve, IDA 75 | está en todo | **riesgo alto** |

Amaranto y nitrito son igual de potentes y acaban en extremos opuestos. Por eso
una escala construida solo sobre la IDA **no reproduce** las clasificaciones de
EFSA: se comprobó, y las medianas de «alto» y «moderado» coinciden en 5,0.

## Fuentes

Las cuatro verificadas. Cada una responde a otra cosa; ninguna sirve sola.

| Fuente | Responde | Cobertura | Al día | Licencia |
|---|---|---|---|---|
| Reglamento 1333/2008 vía API Cellar | ¿está permitido? | 339 números E | 2026 | legislación UE |
| IARC Monographs | ¿causa cáncer? | pocos, decisivos | sí | — |
| EFSA OpenFoodTox 3.0 | ¿qué daño, a qué dosis? | 382 emparejables, 73 con IDA | 2026 | CC-BY-ND |
| Taxonomía de Open Food Facts | ¿se supera el límite? | 65 | **no, 2019** | ODbL |

Sobre la CC-BY-ND: prohíbe **republicar su tabla**, no usar los hechos. Se
consulta al construir y se publica nuestra clasificación con su cita. Los
hechos no son objeto de derechos de autor.

## La escalera

Se evalúa en orden; **gana el primer peldaño que encaje**. Donde coincidan dos
señales, manda la más grave (regla de máximo, no promedio).

| # | Condición | Fuente |
|---|---|---|
| 1 | No autorizado en alimentos | Cellar |
| 2 | IARC grupo 1 o 2A | IARC |
| 3 | Efecto crítico de gravedad 2–3 | OpenFoodTox |
| 4 | IARC grupo 2B | IARC |
| 5 | Sobreexposición alta o moderada | OFF |
| 6 | Efecto crítico de gravedad 4–8 | OpenFoodTox |
| 7 | Tramos de IDA | OpenFoodTox |
| 8 | Sin IDA por toxicidad muy baja | OpenFoodTox |
| 9 | Sin datos | — |

**Ningún peldaño penaliza 0.** El 0 es no llevar aditivos.

### Gravedad del efecto crítico

| Nivel | Efecto | Por qué |
|---|---|---|
| 1 | genotóxico / carcinogénico | no se les asume dosis segura |
| 2 | teratogénico / reproductivo / developmental | ventana irrecuperable |
| 3 | endocrino | sistémico y de largo plazo |
| 4 | neurotóxico | tejido que no regenera |
| 5 | órgano diana (riñón, hígado) | daño localizado |
| 6 | inmunotóxico / hematopoyético | funcional, reversible |
| 7 | sistémico reversible | metahemoglobina, transaminasas |
| 8 | local / digestivo | molestia, no lesión |

La IDA **no es la clase**: es el modulador dentro del nivel. Entre dos
teratógenos pesa más el de dosis menor.

Se descarta buscar una convención toxicológica para bandas de IDA: no existe, y
ademas no es lo que se evalua. Lo que se evalua es el **dano potencial**, que es
categorico y no necesita calibracion numerica. El orden de los ocho niveles es
criterio declarado, no un umbral disfrazado de dato.

La **exposicion amortigua**, no define. El amaranto es teratogeno (nivel 2) pero
EFSA estima que nadie se acerca a la dosis: mostrarlo igual de grave que un
teratogeno muy consumido seria sobredimensionarlo.

### Cuanto cubre de verdad

Medido sobre el inventario real (1.363.921 apariciones, 4.769 productos
mexicanos con aditivos):

| | Apariciones | Productos con al menos uno |
|---|---|---|
| Efecto util (nivel asignable), 22 aditivos | 4,5% | **18,8%** |
| Solo `systemic` o `not reported`, 24 aditivos | 11,0% | — |
| Con algun dato | — | 47,9% |
| Sin ningun efecto | 84,5% | — |

Es el mejor dato que hay y no alcanza para ser la escala principal. Por eso la
escalera no es una alternativa al dano potencial sino la respuesta honesta para
el 84,5% donde no lo tenemos.

**El nivel 1 está vacío por construcción**, y no por falta de datos: a una
sustancia con sospecha de genotoxicidad no se le asigna IDA, así que nunca
tendrá «efecto crítico». Lo puebla IARC desde fuera, y la compuerta regulatoria
recoge el resto. Comprobado: en las doce etiquetas de efecto de los 46 aditivos
con datos **no aparece ni una** relacionada con cáncer o genotoxicidad.

## Dos trampas comprobadas

**`CriticalEndpoint` no es «lo peor que hace».** Es el efecto que determinó el
límite numérico. Para el nitrito sódico dice «metahemoglobina», y IARC lo
clasifica 2A por nitrosación endógena. Una ficha construida solo sobre el
endpoint crítico sería técnicamente correcta y engañosa en lo que importa.

**La etiqueta no dice qué le pasa a quien lo come.** La curcumina (E100, el
colorante del curry) tiene efecto crítico «developmental», igual que el ácido
bórico. Es lo que fija su IDA de 3 mg/kg, nada más. Aplicar la tabla a ciegas
penalizaría la cúrcuma como una sustancia teratógena.

Por eso los 46 se revisan **a mano** y la lectura queda escrita en `base`.

## Calidad de los datos

- De 46 aditivos con efecto, **26 dicen solo `systemic`** y 5 `not reported`.
  Más de la mitad de las etiquetas no sirven; hay que caer al siguiente peldaño
  en vez de inventar una frase sobre una etiqueta vacía.
- El cruce OpenFoodTox ↔ Open Food Facts es **por nombre**, no por
  identificador: OpenFoodTox no indexa por numero E -solo 7 sustancias lo
  llevan en el nombre-. Medido, el cruce mejora mucho al relajarlo:

  | cruce | aditivos | apariciones cubiertas |
  |---|---|---|
  | igualdad exacta del nombre normalizado | 233 | 63,7% |
  | + tratar singular y plural como uno | 305 | 75,9% |
  | + propagar entre padre (`E450`) e hijos (`E450i`) | **382** | **84,9%** |

  La propagacion padre/hijo es un punto de partida, no una medicion: que
  `Disodium diphosphate` tenga datos no implica que todos los difosfatos se
  comporten igual. Se marca como **heredado** en `base`.

  Y el cruce laxo tiene trampas comprobadas: `De-oiled lecithin` no es la
  lecitina E322 y `Cross-linked sodium CMC` no es el E466. Por eso cada
  emparejamiento entra al fichero revisable con el nombre de origen al lado.
- Los campos estructurados de toxicidad (`TestRs.Toxicity`,
  `TargetSystemOrganToxicity.*`) existen en el esquema y están **vacíos**: 0 de
  65. El dato solo vive en `...RemarksOnResults.Other`, texto libre.

## Alcance del trabajo

Medido sobre el inventario real de los ocho países (1.363.921 apariciones,
581 aditivos distintos):

| Revisar | Cubre |
|---|---|
| 30 aditivos | 63,7% |
| 50 | 76,9% |
| 100 | **92,1%** |

No es un proyecto de 683 elementos.

## Lo que falta

1. **Las penalizaciones.** No están fijadas y **no se pueden calibrar contra
   nada**: no hay validación externa (los tramos de IDA no reproducen las
   clases de EFSA), no hay huecos naturales en la distribución, y no existe
   convención toxicológica para bandas de IDA. Serán convención editorial
   declarada como tal, y hay que medir su efecto sobre productos reales antes
   de adoptarlas.
2. **IARC sin fuente sistemática.** Solo se verificaron dos casos a mano
   (nitrito 2A, aspartamo 2B). Falta localizar la lista completa de aditivos
   con clasificación IARC.
3. **Los 46 sin revisar.** El caso de la curcumina obliga a leer cada dictamen
   antes de asignar gravedad.

## Fuentes citadas

- API Cellar: `http://publications.europa.eu/resource/celex/02008R1333-20260218`
  con `Accept: application/xhtml+xml` y `Accept-Language: spa`
- OpenFoodTox 3.0 — Zenodo 19388272
- IARC Monographs vol. 94 (nitrato y nitrito), vol. 134 (aspartamo)
- Taxonomía de aditivos de Open Food Facts (ODbL-1.0)
