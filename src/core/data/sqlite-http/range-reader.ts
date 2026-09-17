/**
 * Lector de bloques de un archivo remoto por HTTP Range, con cache LRU.
 *
 * Usa XMLHttpRequest SINCRONO a proposito. Motivo: el VFS clasico de SQLite es
 * sincrono y `fetch()` no lo es. Las dos salidas posibles son:
 *
 *   a) SharedArrayBuffer + Atomics.wait  -> exige cabeceras COOP/COEP, que
 *      GitHub Pages no deja configurar. Descartado.
 *   b) XHR sincrono dentro de un Web Worker -> permitido por la plataforma, sin
 *      cabeceras especiales. Es lo que se usa aqui.
 *
 * Consecuencia no negociable: este modulo SOLO puede ejecutarse en un Worker.
 * En el hilo principal, el XHR sincrono esta prohibido y congelaria la UI.
 */

const DEFAULT_BLOCK_SIZE = 4096;
const DEFAULT_MAX_BLOCKS = 4096; // 16 MB con bloques de 4 kB

export interface RangeReaderOptions {
  url: string;
  /** Debe coincidir con el `page_size` de la base para que cada lectura sea un bloque */
  blockSize?: number;
  /** Tope de bloques en memoria antes de empezar a desalojar */
  maxBlocks?: number;
}

export interface RangeReaderStats {
  requests: number;
  bytesTransferred: number;
  cacheHits: number;
  cacheMisses: number;
  evictions: number;
}

export class HttpRangeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'HttpRangeError';
  }
}

export class RangeReader {
  readonly url: string;
  readonly blockSize: number;
  private readonly maxBlocks: number;
  /** Map preserva el orden de insercion, que es justo lo que necesita un LRU. */
  private readonly cache = new Map<number, Uint8Array>();
  private fileSizeCache?: number;

  readonly stats: RangeReaderStats = {
    requests: 0,
    bytesTransferred: 0,
    cacheHits: 0,
    cacheMisses: 0,
    evictions: 0,
  };

  constructor(opts: RangeReaderOptions) {
    this.url = opts.url;
    this.blockSize = opts.blockSize ?? DEFAULT_BLOCK_SIZE;
    this.maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  }

  /** Tamano total del archivo remoto, via HEAD (o Range 0-0 si HEAD no sirve). */
  fileSize(): number {
    if (this.fileSizeCache !== undefined) return this.fileSizeCache;

    const xhr = new XMLHttpRequest();
    xhr.open('HEAD', this.url, false);
    xhr.send();
    this.stats.requests++;

    if (xhr.status >= 200 && xhr.status < 300) {
      const len = xhr.getResponseHeader('Content-Length');
      if (len) {
        this.fileSizeCache = Number.parseInt(len, 10);
        return this.fileSizeCache;
      }
    }

    // Respaldo: un Range de 1 byte devuelve `Content-Range: bytes 0-0/TOTAL`.
    const probe = new XMLHttpRequest();
    probe.open('GET', this.url, false);
    probe.setRequestHeader('Range', 'bytes=0-0');
    probe.responseType = 'arraybuffer';
    probe.send();
    this.stats.requests++;
    const contentRange = probe.getResponseHeader('Content-Range');
    const total = contentRange?.split('/')[1];
    if (!total) {
      throw new HttpRangeError(
        `El servidor no expone el tamano del archivo (${this.url}). ` +
          'Comprueba que soporta peticiones Range y que expone Content-Range via CORS.',
        probe.status,
      );
    }
    this.fileSizeCache = Number.parseInt(total, 10);
    return this.fileSizeCache;
  }

  private fetchBlock(blockIndex: number): Uint8Array {
    const start = blockIndex * this.blockSize;
    const end = start + this.blockSize - 1;

    const xhr = new XMLHttpRequest();
    xhr.open('GET', this.url, false); // sincrono: ver cabecera del archivo
    xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    this.stats.requests++;

    if (xhr.status !== 206 && xhr.status !== 200) {
      throw new HttpRangeError(
        `Peticion Range fallida con HTTP ${xhr.status} sobre ${this.url}`,
        xhr.status,
      );
    }
    if (xhr.status === 200) {
      // Sin soporte de Range el servidor manda el archivo entero: inaceptable
      // para una base de cientos de MB.
      throw new HttpRangeError(
        `El servidor ignoro la cabecera Range y devolvio el archivo completo. ` +
          'Hace falta un host que soporte HTTP 206 (jsDelivr, raw.githubusercontent, R2...).',
        200,
      );
    }

    const bytes = new Uint8Array(xhr.response as ArrayBuffer);
    this.stats.bytesTransferred += bytes.length;
    return bytes;
  }

  private getBlock(blockIndex: number): Uint8Array {
    const hit = this.cache.get(blockIndex);
    if (hit) {
      this.stats.cacheHits++;
      // Reinsertar lo mueve al final, que es la posicion de "usado hace poco".
      this.cache.delete(blockIndex);
      this.cache.set(blockIndex, hit);
      return hit;
    }

    this.stats.cacheMisses++;
    const block = this.fetchBlock(blockIndex);
    this.cache.set(blockIndex, block);

    // Desalojo LRU. `sql.js-httpvfs` no lo hace y su consumo de memoria crece
    // sin limite mientras se consulta; aqui esta acotado a proposito.
    while (this.cache.size > this.maxBlocks) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
      this.stats.evictions++;
    }

    return block;
  }

  /** Lee `length` bytes desde `offset`, uniendo tantos bloques como haga falta. */
  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let written = 0;

    while (written < length) {
      const absolute = offset + written;
      const blockIndex = Math.floor(absolute / this.blockSize);
      const blockOffset = absolute % this.blockSize;
      const block = this.getBlock(blockIndex);

      const available = block.length - blockOffset;
      if (available <= 0) break; // final del archivo
      const toCopy = Math.min(available, length - written);
      out.set(block.subarray(blockOffset, blockOffset + toCopy), written);
      written += toCopy;
    }

    return written === length ? out : out.subarray(0, written);
  }

  /** Precarga un rango contiguo en una sola peticion (arranque de la BD). */
  prefetch(offset: number, length: number): void {
    const firstBlock = Math.floor(offset / this.blockSize);
    const lastBlock = Math.floor((offset + length - 1) / this.blockSize);
    const missing: number[] = [];
    for (let i = firstBlock; i <= lastBlock; i++) if (!this.cache.has(i)) missing.push(i);
    if (missing.length === 0) return;

    const start = missing[0]! * this.blockSize;
    const end = (missing[missing.length - 1]! + 1) * this.blockSize - 1;

    const xhr = new XMLHttpRequest();
    xhr.open('GET', this.url, false);
    xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    this.stats.requests++;
    if (xhr.status !== 206) return; // la precarga es best-effort

    const buf = new Uint8Array(xhr.response as ArrayBuffer);
    this.stats.bytesTransferred += buf.length;
    for (let i = 0; i < missing.length; i++) {
      const blockIndex = missing[i]!;
      const sliceStart = blockIndex * this.blockSize - start;
      if (sliceStart >= buf.length) break;
      this.cache.set(blockIndex, buf.subarray(sliceStart, sliceStart + this.blockSize));
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
