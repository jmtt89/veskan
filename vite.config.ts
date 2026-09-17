import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        // `vfs-check` es un banco de pruebas del VFS: entrada aparte, para que
        // no entre en el bundle de la aplicacion.
        main: 'index.html',
        'vfs-check': 'vfs-check.html',
        'scanner-check': 'scanner-check.html',
        'opfs-check': 'opfs-check.html',
      },
      output: {
        manualChunks(id) {
          // El WASM del escaner y el de SQLite van en trozos propios para que
          // no entren en la carga inicial.
          if (id.includes('zxing-wasm')) return 'scanner';
          if (id.includes('@sqlite.org')) return 'sqlite';
          if (id.includes('dexie')) return 'storage';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // sqlite-wasm trae su propio .wasm; que Vite no intente pre-empaquetarlo.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      workbox: {
        // El sourcemap del Service Worker incrusta rutas ABSOLUTAS del sistema
        // de archivos de quien compila (`/home/<usuario>/...`), que acabarian
        // publicadas. Es codigo generado, asi que depurarlo aporta poco y no
        // compensa filtrar el nombre de usuario y la estructura de carpetas.
        sourcemap: false,
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // La taxonomia de aditivos (~95 kB) se precachea: sin ella el motor de
        // puntuacion no funciona sin red.
        additionalManifestEntries: [{ url: 'data/additives.json', revision: null }],
        navigateFallback: 'index.html',
        // Sin esto, el Service Worker devuelve index.html para /vfs-check.html
        // y el banco de pruebas nunca llega a ejecutarse.
        navigateFallbackDenylist: [/^\/vfs-check/, /^\/scanner-check/, /^\/opfs-check/],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // REGLA CRITICA: el snapshot SQLite se lee con peticiones Range.
            // Si el Service Worker las intercepta y cachea, devuelve respuestas
            // parciales mal casadas y corrompe el VFS. Aqui se excluye de forma
            // explicita para que vayan siempre directas a la red.
            urlPattern: ({ url, request }) =>
              url.pathname.endsWith('.sqlite3') || request.headers.has('range'),
            handler: 'NetworkOnly',
          },
          {
            // Respuestas de producto de Open Food Facts: se sirve lo cacheado y
            // se revalida por detras. Asi el limite de 15 req/min no se nota.
            urlPattern: /^https:\/\/world\.open(food|beauty)facts\.org\/api\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'off-api',
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/images\.openfoodfacts\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'off-images',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Veskan — análisis nutricional por código de barras',
        short_name: 'Veskan',
        description:
          'Escanea el código de barras de un producto y obtén una puntuación de salud abierta y auditable, basada en Nutri-Score 2023, NOVA, evaluaciones de aditivos de EFSA y el modelo de perfil de nutrientes de la OPS.',
        lang: 'es',
        dir: 'ltr',
        theme_color: '#0b7a44',
        background_color: '#0b0f14',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        categories: ['health', 'food', 'lifestyle'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          { name: 'Escanear', short_name: 'Escanear', url: './?view=scan' },
          { name: 'Historial', short_name: 'Historial', url: './?view=history' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
});
