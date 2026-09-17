/**
 * Servidor estatico de desarrollo con soporte real de HTTP Range y CORS.
 *
 * Existe para poder probar en local exactamente lo que hara el CDN en
 * produccion: responder 206 con `Content-Range` y exponer esa cabecera por
 * CORS. Sin eso, el VFS de SQLite no puede funcionar.
 */

import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const PORT = Number(args.port ?? 8787);
const DIRS = (args.dirs ?? 'dist,data,public').split(',').map((d) => resolve(ROOT, d.trim()));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.map': 'application/json; charset=utf-8',
  '.sqlite3': 'application/vnd.sqlite3',
  '.ico': 'image/x-icon',
};

function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  for (const dir of DIRS) {
    const candidate = join(dir, clean);
    // Cortafuegos contra escapes de directorio.
    if (!candidate.startsWith(dir)) continue;
    if (existsSync(candidate)) {
      const st = statSync(candidate);
      if (st.isDirectory()) {
        const index = join(candidate, 'index.html');
        if (existsSync(index)) return { path: index, size: statSync(index).size };
        continue;
      }
      return { path: candidate, size: st.size };
    }
  }
  return undefined;
}

const server = createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    // Sin exponer estas dos, el navegador no deja leer el tamano del archivo.
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  let file = resolveFile(req.url ?? '/');
  // Respaldo de SPA: cualquier ruta desconocida sirve index.html.
  if (!file && !extname(req.url ?? '')) file = resolveFile('/index.html');
  if (!file) {
    res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
    res.end('No encontrado');
    return;
  }

  const type = MIME[extname(file.path)] ?? 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { ...cors, 'Content-Range': `bytes */${file.size}` });
      res.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
    if (start >= file.size || start > end) {
      res.writeHead(416, { ...cors, 'Content-Range': `bytes */${file.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...cors,
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${file.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file.path, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...cors,
    'Content-Type': type,
    'Content-Length': file.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file.path).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Sirviendo con soporte de Range en http://localhost:${PORT}`);
  console.log(`  directorios: ${DIRS.join(', ')}`);
});
