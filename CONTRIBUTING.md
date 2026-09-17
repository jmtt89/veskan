# Cómo contribuir

Gracias por el interés. Antes de escribir código, hay una cuestión de licencias que conviene leer: son diez líneas y evita malentendidos desagradables después.

## El acuerdo de contribución, y por qué existe

Este proyecto usa un [modelo de licencia dual](LICENSING.md): AGPL-3.0 para todo el mundo, con la posibilidad de conceder licencias comerciales aparte.

Para que esa segunda vía siga siendo posible, el titular del proyecto debe conservar los derechos sobre la totalidad del código. Si se acepta una aportación sin ese acuerdo, esa porción queda únicamente bajo AGPL y **bloquea la licencia comercial para el proyecto entero**, no solo para el archivo tocado.

Por eso, al abrir un *pull request* se pide confirmar:

> Concedo al titular del proyecto una licencia perpetua, mundial, no exclusiva, gratuita e irrevocable para usar, reproducir, modificar, sublicenciar y distribuir mi contribución, incluida su publicación bajo términos distintos de la AGPL-3.0. Declaro que la contribución es obra mía y que tengo derecho a concederla.

Basta con pegar esa frase como comentario en el PR.

Si prefieres no firmarlo, se puede igualmente aprovechar tu trabajo: abre una *issue* describiendo el cambio y se reimplementa. Es más lento, pero nadie se queda fuera.

## Antes de abrir un PR

```bash
npm install
npm test          # 951 pruebas; ninguna debe fallar
npx tsc --noEmit  # sin errores de tipos
```

Si tocas el motor de puntuación, los tests de conformidad de Nutri-Score comparan el resultado contra 228 productos reales de Open Food Facts. **Si fallan, el cambio está mal**, salvo que Open Food Facts haya modificado su algoritmo, en cuyo caso hay que decirlo explícitamente en el PR.

## Qué se agradece especialmente

- **Datos de producto de Latinoamérica.** Es el punto más débil: Venezuela tiene 1.721 productos frente a los 371.511 de España. Esto se aporta en [Open Food Facts](https://world.openfoodfacts.org), no aquí, y llega a la app en la siguiente sincronización.
- **Revisión del algoritmo.** Si crees que un peso o un umbral está mal justificado, dilo. La especificación está en [`docs/03-algoritmo.md`](docs/03-algoritmo.md) y cada constante debería tener su razón escrita. Si alguna no la tiene, es un fallo.
- **Ampliar el subconjunto de CosIng.** Hoy son 15 sustancias curadas a mano frente a las ~2.400 de los Anexos del Reglamento (CE) 1223/2009.

## Qué no encaja aquí

- Puntuaciones sin respaldo publicado. Cada componente del algoritmo se apoya en una fuente citable; las intuiciones sobre nutrición, por buenas que sean, no entran.
- Telemetría, analítica o cualquier cosa que envíe datos del usuario a algún sitio. La aplicación no tiene servidor y no va a tenerlo.
