/**
 * Banco de pruebas del decodificador de codigos de barras.
 *
 * Genera un EAN-13 valido dibujando sus barras segun la norma y lo pasa por el
 * mismo motor que usa la camara. Separa dos fallos que desde fuera parecen el
 * mismo: "el decodificador no funciona" y "la camara no enfoca".
 */

import { createBarcodeEngine, isValidEan, scanFromFile } from '../core/scanner/barcode.js';

const out = document.getElementById('out')!;
const preview = document.getElementById('preview') as HTMLCanvasElement;

// Codificacion EAN-13 estandar.
const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

function ean13Bits(code: string): string {
  const d = code.split('').map(Number);
  const parity = PARITY[d[0]!]!;
  let bits = '101';
  for (let i = 1; i <= 6; i++) {
    bits += (parity[i - 1] === 'L' ? L : G)[d[i]!]!;
  }
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i]!]!;
  return bits + '101';
}

/** Dibuja el codigo con un ancho de modulo dado, para simular distintas calidades. */
function drawBarcode(code: string, moduleWidth: number, height = 160): HTMLCanvasElement {
  const bits = ean13Bits(code);
  const quiet = 11 * moduleWidth;
  const canvas = document.createElement('canvas');
  canvas.width = bits.length * moduleWidth + quiet * 2;
  canvas.height = height + 40;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') ctx.fillRect(quiet + i * moduleWidth, 10, moduleWidth, height);
  }
  return canvas;
}

function log(name: string, ok: boolean, detail: string): void {
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `<strong>${ok ? '✅' : '❌'} ${name}</strong><pre style="margin:8px 0 0;white-space:pre-wrap;font-size:.82rem">${detail}</pre>`;
  out.appendChild(div);
}

(async () => {
  const results: boolean[] = [];

  // 0. Que motor se esta usando realmente
  const engine = await createBarcodeEngine();
  log(
    '0. Motor seleccionado',
    true,
    `${engine.name}\nBarcodeDetector nativo disponible: ${'BarcodeDetector' in window}`,
  );

  // 1..n. Decodificar a distintas calidades
  const codes = ['7502219553429', '3017624010701', '8410000000007'];
  for (const code of codes) {
    if (!isValidEan(code)) {
      log(`Código ${code}`, false, 'dígito de control inválido, se omite');
      continue;
    }
    for (const moduleWidth of [3, 2, 1]) {
      const canvas = drawBarcode(code, moduleWidth);
      if (moduleWidth === 3) {
        preview.width = canvas.width;
        preview.height = canvas.height;
        preview.getContext('2d')!.drawImage(canvas, 0, 0);
      }
      const t0 = performance.now();
      try {
        const found = await engine.detect(canvas);
        const ms = Math.round(performance.now() - t0);
        const hit = found.find((f) => f.barcode === code);
        const ok = Boolean(hit);
        results.push(ok);
        log(
          `${code} · ancho de módulo ${moduleWidth}px (${canvas.width}px de ancho)`,
          ok,
          ok
            ? `leído "${hit!.barcode}" formato ${hit!.format} en ${ms} ms`
            : `no decodificado en ${ms} ms (resultados: ${JSON.stringify(found)})`,
        );
      } catch (err) {
        results.push(false);
        log(`${code} · módulo ${moduleWidth}px`, false, String(err));
      }
    }
  }

  // Ruta de archivo, que es la que usa "escanear desde foto"
  const canvas = drawBarcode('7502219553429', 3);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (blob) {
    const file = new File([blob], 'barcode.png', { type: 'image/png' });
    const r = await scanFromFile(file);
    const ok = r?.barcode === '7502219553429';
    results.push(ok);
    log('Ruta "escanear desde foto"', ok, ok ? `leído ${r!.barcode}` : 'no decodificado');
  }

  const passed = results.filter(Boolean).length;
  const summary = document.createElement('div');
  summary.className = passed === results.length ? 'notice info' : 'notice warn';
  summary.textContent = `${passed} de ${results.length} decodificaciones correctas`;
  out.prepend(summary);
  (window as unknown as { __scannerResult: unknown }).__scannerResult = {
    passed,
    total: results.length,
    engine: engine.name,
  };
})();
