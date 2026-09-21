/*
 * robots.txt y sitemap.xml, generados y no escritos a mano.
 *
 * POR QUE GENERADOS. Un sitemap escrito a mano miente en cuanto cambia algo, y
 * en este proyecto ya hemos pagado tres veces el mismo precio por artefactos
 * que se actualizaban «a mano», es decir: no se actualizaban. `lastmod` sale
 * de la fecha del ultimo commit que toco cada cosa, no de `Date.now()`: poner
 * la fecha de hoy en cada despliegue le dice al rastreador que todo cambio
 * siempre, y deja de creerselo.
 *
 * QUE HAY QUE ENTENDER DE ESTE SITIO. Tiene UNA sola URL. Las cinco vistas
 * -escanear, resultado, historial, buscar, mas- son estado en memoria: no hay
 * rutas, no hay enlaces profundos, y el `?view=scan` del manifiesto ni siquiera
 * se lee. Asi que el sitemap tiene una entrada, y eso no es un defecto del
 * sitemap: es lo que hay que indexar.
 *
 * Lo que SI es contenido -los 671 aditivos con su evaluacion- no tiene URL
 * propia y por tanto es invisible para un rastreador. Arreglarlo es otro
 * trabajo, y esta medido en docs/08-seo.md.
 *
 * Uso:
 *   node scripts/build-seo.mjs [dir-salida]      (por defecto `dist`)
 *   VESKAN_SITIO=https://ejemplo.org/ node scripts/build-seo.mjs
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITIO = (process.env.VESKAN_SITIO || 'https://jmtt89.github.io/veskan/')
  .replace(/\/*$/, '/');
const SALIDA = resolve(ROOT, process.argv[2] || 'dist');

/** La fecha del ultimo commit que toco esas rutas, en ISO corto. */
function ultimoCambio(...rutas) {
  try {
    const d = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...rutas],
                           { cwd: ROOT, encoding: 'utf8' }).trim();
    return d ? d.slice(0, 10) : null;
  } catch {
    return null;   // sin git -no deberia pasar en CI- se omite `lastmod`
  }
}

const paginas = [
  {
    url: SITIO,
    // La portada cambia con la interfaz Y con la base de peligro, porque lo
    // que la aplicacion dice de un producto depende de las dos.
    lastmod: ultimoCambio('index.html', 'src', 'public/data/additives.json'),
    changefreq: 'weekly',
    priority: '1.0',
  },
];

const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  paginas.map((p) => [
    '  <url>',
    `    <loc>${p.url}</loc>`,
    ...(p.lastmod ? [`    <lastmod>${p.lastmod}</lastmod>`] : []),
    `    <changefreq>${p.changefreq}</changefreq>`,
    `    <priority>${p.priority}</priority>`,
    '  </url>',
  ].join('\n')).join('\n') +
  '\n</urlset>\n';

/*
 * No se bloquea nada: no hay panel, ni area privada, ni parametros que generen
 * duplicados, porque no hay parametros. Un `Disallow` inventado solo sirve para
 * decirle a un curioso donde mirar.
 *
 * `Crawl-delay` tampoco: es un sitio estatico servido por GitHub y no hay nada
 * que proteger de la carga.
 */
const robots = [
  '# Veskan — https://github.com/jmtt89/veskan',
  '# Todo el analisis ocurre en el navegador. No hay servidor ni API que rastrear.',
  'User-agent: *',
  'Allow: /',
  '',
  `Sitemap: ${SITIO}sitemap.xml`,
  '',
].join('\n');

if (!existsSync(SALIDA)) mkdirSync(SALIDA, { recursive: true });
writeFileSync(join(SALIDA, 'sitemap.xml'), sitemap);
writeFileSync(join(SALIDA, 'robots.txt'), robots);

console.log(`SEO — ${SITIO}`);
console.log(`   sitemap.xml   ${paginas.length} url` +
            (paginas[0].lastmod ? `, lastmod ${paginas[0].lastmod}` : ''));
console.log('   robots.txt    sin exclusiones');
