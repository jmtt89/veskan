# Especificación del algoritmo de puntuación

**Versión:** 1.0.0 · **Fecha:** 2026-09-16

Este documento es normativo: si el código y este documento discrepan, es un fallo.
Cada constante tiene aquí su justificación. No hay ajustes ocultos.

---

## Principio rector

> Preferimos decir "no lo sé" antes que dar un número que parezca preciso y no lo sea.

De ahí salen tres decisiones que recorren todo el algoritmo:
1. Toda penalización es **gradual y explicada**; no hay topes arbitrarios.
2. Se distingue **riesgo** (exposición real evaluada) de **peligro** (propiedad intrínseca).
3. Cada resultado lleva un **nivel de confianza** calculado, visible para el usuario.

---

## Fórmula

```
puntuación = redondear(
    nutrición   × 0.55
  + procesado   × 0.20
  + aditivos    × 0.20
  + regulatorio × 0.05
  − penalizaciónSellos × 0.5
)
acotada a [0, 100]
```

### Por qué esos pesos

| Bloque | Peso | Justificación |
|---|---|---|
| Nutrición | 55% | Es el único bloque con asociación demostrada a resultados de salud en cohortes prospectivas grandes (EPIC, >470.000 participantes). Merece el mayor peso. |
| Procesado | 20% | El vínculo entre ultraprocesamiento y enfermedad es sólido pero más reciente y con más confusión residual que el de los nutrientes. |
| Aditivos | 20% | Solo 65 de 683 aditivos tienen evaluación de sobreexposición de EFSA publicada. Peso relevante, pero no dominante, porque la cobertura del dato es parcial. |
| Regulatorio | 5% | Solapa parcialmente con el bloque de nutrición (mismos nutrientes críticos). Pesa poco como bloque, pero actúa además como modulador directo. |

El término `− penalizaciónSellos × 0.5` existe porque un producto con varios excesos según la OPS no debería poder alcanzar la banda alta compensando por otro lado. Es la única regla no lineal, y es explícita.

---

## Bloque 1 — Calidad nutricional (55%)

Nutri-Score 2023 (FSAm-NPS revisado), **portado desde la implementación de referencia** de Open Food Facts (`lib/ProductOpener/Nutriscore.pm`), no desde artículos divulgativos: las tablas que circulan por la web están redondeadas o incompletas.

Las tablas de umbrales completas están en `src/core/scoring/nutriscore2023.ts`.

**Verificación:** 923 aserciones contra 228 productos reales comprueban que nuestro `score` y `grade` coinciden **exactamente** con los que publica Open Food Facts. El fixture cubre las cinco categorías de reglas especiales:

| Categoría | Productos en el fixture |
|---|---|
| General | 89 |
| Bebidas | 55 |
| Grasas y aceites | 32 |
| Quesos | 31 |
| Carne roja | 21 |

### Normalización a 0–100

El rango teórico del score depende de la categoría, así que se normaliza contra los límites reales de cada una. Usar un rango único aplastaría a las bebidas contra el extremo bueno.

| Categoría | mín | máx |
|---|---|---|
| General | −17 | 40 |
| Grasas, aceites, frutos secos | −17 | 30 |
| Bebidas | −15 | 14 |
| Agua | — | siempre 100 |

---

## Bloque 2 — Grado de procesamiento (20%)

| NOVA | Puntos | Descripción |
|---|---|---|
| 1 | 100 | Sin procesar o mínimamente procesado |
| 2 | 80 | Ingrediente culinario procesado |
| 3 | 55 | Procesado |
| 4 | 25 | Ultraprocesado |
| desconocido | 55 | Valor neutro |

La caída de 3 a 4 es la más pronunciada a propósito: es donde está el salto de riesgo documentado.

**Inferencia cuando falta el dato.** Es deliberadamente asimétrica: se puede *subir* a NOVA 4 ante marcadores claros (aditivos de clase exclusivamente industrial, o ingredientes como "jarabe de glucosa", "aceite hidrogenado", "maltodextrina", "proteína aislada"), pero **nunca se afirma NOVA 1 sin dato de origen**. Un falso NOVA 1 engaña mucho más que un "desconocido".

---

## Bloque 3 — Aditivos (20%)

**Aquí está la diferencia central frente a Yuka.** No se puntúa el peligro intrínseco, sino el **riesgo de sobreexposición evaluado por EFSA**: si el consumo real de la población supera la Ingesta Diaria Admisible, y en qué grupos de edad.

### Penalización por aditivo

| Riesgo EFSA | Puntos |
|---|---|
| alto | 22 |
| moderado | 9 |
| bajo | 3 |
| sin riesgo identificado | 0 |
| sin evaluar | 1,5 |

**Recargos acumulables:**
- +4 si ANSES lo marca como aditivo de interés (vigilancia reforzada).
- +5 si algún grupo vulnerable (lactantes, niños pequeños, niños) ya supera la IDA con el **consumo medio**.

### Amortiguamiento por acumulación

```
penalizaciónTotal = Σ  penalizaciónᵢ × 0.72ⁱ     (ordenado de mayor a menor)
```

Cinco conservantes de riesgo bajo no son cinco veces peor que uno. Sin este factor, cualquier producto con lista larga caería a cero y el score dejaría de discriminar entre productos.

### Limitación que hay que declarar

De los 683 aditivos de la taxonomía, **618 no tienen evaluación de sobreexposición publicada** (38 riesgo alto, 14 moderado, 13 sin riesgo). El programa de reevaluación de EFSA sigue en curso. Por eso "sin evaluar" penaliza solo 1,5 puntos: no se presume culpabilidad por falta de dato. La app lo dice explícitamente en la ficha de aditivos.

---

## Bloque 4 — Advertencias OPS/OMS (5% + modulador)

Criterios transcritos del documento oficial del Modelo de Perfil de Nutrientes de la OPS (2016), Panel C:

| Nutriente crítico | Criterio de exceso |
|---|---|
| Sodio | ≥ 1 mg de sodio por 1 kcal |
| Azúcares libres | ≥ 10% de la energía total |
| Grasas totales | ≥ 30% de la energía total |
| Grasas saturadas | ≥ 10% de la energía total |
| Grasas trans | ≥ 1% de la energía total |
| Otros edulcorantes | cualquier cantidad |

Todos son **inclusivos** (`≥`), y los tests lo comprueban justo en el borde: confundir `>` con `>=` cambiaría el veredicto de productos reales.

**Alcance:** el propio modelo se limita a productos procesados y ultraprocesados, así que no se aplica a NOVA 1 y 2.

**Azúcares libres:** las etiquetas declaran azúcares totales, no libres. Se estima descontando la fracción intrínseca mediante el porcentaje de frutas y verduras. Todo sello que dependa de esa estimación se marca "(estimado)" en la interfaz.

**Penalización:** 4 puntos por sello, con techo de 16.

---

## Nivel de confianza

Media ponderada de los datos presentes:

| Dato | Peso |
|---|---|
| Valor energético | 3 |
| Azúcares | 2 |
| Grasas saturadas | 2 |
| Sal | 2 |
| Lista de ingredientes | 2 |
| Grado de procesamiento | 2 |
| Proteínas, fibra, grasas totales | 1 cada uno |

| Proporción | Nivel |
|---|---|
| ≥ 0,85 | alta |
| ≥ 0,60 | media |
| ≥ 0,35 | baja |
| < 0,35 | insuficiente |

---

## Productos sin datos utilizables

Open Food Facts contiene muchos registros fantasma: el código existe porque alguien lo escaneó, pero nadie rellenó nada.

**Caso real verificado:** `7502219553429` devuelve `status: 1` con nombre vacío, sin ingredientes y sin nutrientes.

Un producto necesita **nombre** y además (**nutrientes** o **ingredientes**) para ser puntuado. Si no, la app no muestra puntuación: lo dice y ofrece completarlo. Un registro fantasma puntuado es peor que un "no encontrado", porque la aplicación afirma saber algo que no sabe.

---

## Bandas

| Puntuación | Banda | Color |
|---|---|---|
| 75–100 | Excelente | verde |
| 50–74 | Bueno | verde claro |
| 25–49 | Mediocre | ámbar |
| 10–24 | Malo | naranja |
| 0–9 | Muy malo | rojo |

---

## Diferencias frente a Yuka, una por una

| Yuka | Veskan | Motivo |
|---|---|---|
| 60% nutrición | 55% | Se reserva peso para las advertencias regulatorias regionales |
| 30% aditivos | 20% | Solo el 10% de los aditivos tiene evaluación de sobreexposición: no da para pesar 30% |
| 10% bonus "orgánico" | 0% | Sin respaldo en resultados de salud. Se muestra como etiqueta informativa |
| Tope duro en 49/100 | penalización gradual | El tope es opaco y produce saltos que el usuario no puede entender |
| Peligro del aditivo | riesgo de sobreexposición | Un aditivo peligroso en laboratorio puede ser irrelevante a la dosis de uso |
| Sin sellos regionales | modelo OPS incluido | Es el marco regulatorio vigente en el mercado objetivo |
| Score cerrado | algoritmo abierto y versionado | Debe poder auditarse |
| Sin confianza declarada | confianza calculada y visible | Con datos incompletos hay que decirlo |

---

## Validación

| Qué | Cómo |
|---|---|
| Nutri-Score | 923 aserciones contra 228 productos reales de OFF; coincidencia exacta |
| Umbrales OPS | comprobados en el borde exacto de cada criterio |
| Aditivos | E250 (riesgo alto + ANSES + grupos vulnerables) y E951 (sin riesgo) sobre la taxonomía real |
| Amortiguamiento | 5 aditivos penalizan menos de 3× lo que penaliza 1 |
| Rango | nunca sale de 0–100, ni con entradas extremas |
| Sin tope de Yuka | un producto excelente con un aditivo de riesgo alto supera 49 |
| Ordenación | una manzana puntúa por encima de un refresco de cola |
