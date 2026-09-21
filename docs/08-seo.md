# SEO

## El problema, antes que las soluciones

Veskan tiene **una sola URL**. Las cinco vistas —escanear, resultado, historial,
buscar, más— son estado en memoria: no hay rutas, no hay enlaces profundos, y
el `?view=scan` que declara el manifiesto no lo lee nadie.

Eso no es un descuido que arreglar con metaetiquetas. Es lo que es una
aplicación que produce su contenido al escanear un código de barras: **un
rastreador no escanea**. Por muy bien puesta que esté la cabecera, lo único que
hay para indexar es la portada.

Y sin embargo el proyecto sí tiene contenido que la gente busca. No el de los
productos —ése es de Open Food Facts y cambia solo— sino el de los aditivos:

| | |
|---|---|
| aditivos en la taxonomía de la aplicación | 683 |
| con algo que contar (estado legal, nivel, IDA o prohibición) | **608** |
| con nivel de peligro y su certeza | 52 |
| con prohibición o retirada, con la frase literal de la norma | 17 |

«¿Es peligroso el E250?», «E171 prohibido», «para qué sirve el E407» son
búsquedas reales, y ninguna lleva aquí porque esa información no tiene URL.

## Lo que ya está hecho

**El idioma del SEO es el inglés**, y es una decisión tomada a sabiendas del
desajuste: la interfaz es española. El razonamiento es que la asimetría de
búsqueda va en una sola dirección — la mayoría de las búsquedas sobre aditivos
y números E se hacen en inglés, y quien busca en español suele encontrar
igualmente el resultado en inglés, mientras que al revés no ocurre.

Dos cosas se quedan en español, y no por descuido:

- **`<html lang="es">`.** Ese atributo no es una señal de buscador: es lo que
  hace que un lector de pantalla pronuncie el texto de la interfaz con fonética
  española. Cambiarlo rompería la accesibilidad de usuarios reales a cambio de
  una señal marginal.
- **`inLanguage` del nodo `Dataset`** declara `["en", "es"]`, porque es la
  verdad: `nombre_en` está en inglés, `gravedad.descripcion` en español y el
  `verbo` de las normas europeas en inglés. La descripción del dataset sí va en
  inglés; el campo que dice qué idioma tiene el contenido no puede mentir.

El `<noscript>` —lo único que ve un rastreador que no ejecuta JavaScript— va en
los dos idiomas: inglés porque es el del SEO, español porque es el de quien
acabe leyéndolo.

**Cabecera completa** en `index.html`: canónica absoluta, `robots`, Open Graph
con imagen, Twitter card y licencia. La canónica es absoluta a propósito aunque
`base` sea relativa: el mismo contenido se sirve desde Pages, desde una copia
local y desde cualquier previsualización, y sin ella cada copia compite con el
original.

**Datos estructurados**, tres nodos porque son tres cosas distintas:

- `SoftwareApplication` — la aplicación, para quien la busca para usarla.
- `Dataset` — la base de peligro de aditivos, con sus dos distribuciones
  (Parquet y SQLite) y su licencia ODbL. Esto es lo que la hace elegible para
  buscadores de datos, no sólo de páginas.
- `SoftwareSourceCode` — el código, que es AGPL y auditable.

**`robots.txt` y `sitemap.xml` generados**, no escritos a mano, por
`scripts/build-seo.mjs`, que corre dentro de `npm run build`. El `lastmod` sale
de la fecha del último commit que tocó la interfaz o la base de peligro, no de
`Date.now()`: poner la fecha de hoy en cada despliegue le dice al rastreador
que todo cambió siempre, y deja de creérselo.

`robots.txt` no bloquea nada. No hay panel, ni área privada, ni parámetros que
generen duplicados —porque no hay parámetros—, y un `Disallow` inventado sólo
sirve para decirle a un curioso dónde mirar.

**Medido**, no supuesto: Lighthouse en móvil da 100 en SEO, accesibilidad,
buenas prácticas y navegación agéntica; 52 auditorías pasadas, 0 fallidas.

## Lo que falta, y es lo que de verdad decide si se encuentra

**Una página estática por aditivo.** 608 páginas generadas en construcción
desde `public/data/additives.json`, que ya existe y ya está en el bundle. Cada
una con su número E, sus nombres, su estado legal con la cita del reglamento,
su nivel de peligro si lo tiene, su prohibición con la frase literal de la
norma, y enlace a la aplicación para escanear un producto que lo lleve.

Por qué merece la pena:

- Es **contenido propio y verificable**, con su procedencia y su enlace a la
  fuente. No es contenido generado para rellenar.
- Es lo que la gente busca de verdad, y hoy no tiene URL.
- Sale de datos que ya están construidos y publicados. No hay que mantener
  nada aparte: se regenera con la base.
- Es estática. No cambia la arquitectura: sigue sin haber servidor.
- Da algo que ahora no existe: **una URL que compartir**. Hoy no se puede
  enlazar a «lo que Veskan dice del E171».

Lo que hay que decidir antes de hacerlo:

- ~~**Idioma.**~~ **Decidido: inglés, y sólo inglés.** Sin `hreflang` y sin
  versión española, por la asimetría de búsqueda explicada arriba. Además el
  inglés cubre mejor el dato: **671 de 671** aditivos tienen `nombre_en` frente
  a **447** con `nombre_es`, y el texto literal de las normas europeas ya está
  en inglés. `gravedad.descripcion` sí habrá que traducirlo, que es vocabulario
  propio.
- **Qué se dice de los 56 sin nada que contar** —los que no tienen ni estado
  legal ni evaluación—. Publicar una página que dice «no consta nada» 56 veces
  es exactamente el contenido delgado que un buscador penaliza. Lo sensato es
  no generarla y dejar que esos aditivos existan sólo dentro de la aplicación.
- **Si la página repite el aviso de `hallazgo`.** La base publica hallazgos de
  estudios que no son la conclusión del panel, y una ficha pública que los
  pinte mal dice lo contrario de la fuente. El emparejado con `evaluacion` y
  con `ida` tiene que ir en la plantilla, no en el criterio de quien la escriba.

## Lo que NO se ha hecho a propósito

- **No hay `404.html` que sirva la aplicación.** Con una sola URL y `base`
  relativa no hace falta, y un 404 que devuelve la portada crea *soft 404s*:
  el buscador indexa páginas que no existen.
- **No se ha dado de alta en Search Console ni se ha enviado el sitemap.** Eso
  requiere verificar la propiedad del dominio y es una decisión de quien lo
  publica, no del código.
- **No hay `hreflang`** porque no hay traducciones. Declararlo apuntando a sí
  mismo no aporta nada.
