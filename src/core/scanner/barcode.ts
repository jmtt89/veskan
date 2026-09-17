/**
 * Escaneo de codigos de barras con estrategia de dos niveles.
 *
 * 1. `BarcodeDetector` nativo: cero kilobytes. Presente en Chrome sobre
 *    Android, ChromeOS y macOS. AUSENTE en Chrome sobre Linux y Windows, y en
 *    Firefox y Safari. Verificado: en Chrome 143 sobre Linux no existe.
 * 2. `zxing-wasm`: respaldo real para todo lo demas. Se carga bajo demanda.
 *
 * El .wasm se sirve DESDE NUESTRO PROPIO ORIGEN. Por defecto zxing-wasm lo
 * descarga de `fastly.jsdelivr.net` en tiempo de ejecucion, lo que rompe el
 * funcionamiento sin conexion y mete una dependencia de terceros en el camino
 * critico. Se anula con `locateFile`.
 */

export type BarcodeFormat = 'ean_13' | 'ean_8' | 'upc_a' | 'upc_e' | 'code_128';

export interface ScanResult {
  barcode: string;
  format: string;
  engine: 'native' | 'zxing';
}

const NATIVE_FORMATS: BarcodeFormat[] = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
const ZXING_FORMATS = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'ITF'];

interface NativeBarcodeDetector {
  detect(source: CanvasImageSource | ImageBitmapSource): Promise<
    Array<{ rawValue: string; format: string }>
  >;
}

interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
}

export async function isNativeDetectorAvailable(): Promise<boolean> {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!ctor) return false;
  try {
    const supported = await ctor.getSupportedFormats();
    return supported.includes('ean_13');
  } catch {
    return false;
  }
}

export type ImageSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap | ImageData;

export interface BarcodeEngine {
  readonly name: 'native' | 'zxing';
  detect(source: ImageSource): Promise<ScanResult[]>;
  dispose(): void;
}

class NativeEngine implements BarcodeEngine {
  readonly name = 'native' as const;
  constructor(private readonly detector: NativeBarcodeDetector) {}

  async detect(source: ImageSource): Promise<ScanResult[]> {
    if (source instanceof ImageData) {
      // La API nativa no acepta ImageData: se envuelve en un ImageBitmap.
      const bitmap = await createImageBitmap(source);
      try {
        const found = await this.detector.detect(bitmap);
        return found.map((f) => ({ barcode: f.rawValue, format: f.format, engine: 'native' as const }));
      } finally {
        bitmap.close();
      }
    }
    const found = await this.detector.detect(source as CanvasImageSource);
    return found.map((f) => ({ barcode: f.rawValue, format: f.format, engine: 'native' as const }));
  }

  dispose(): void {}
}

type ReadBarcodesFn = (
  input: ImageData | Blob,
  opts: Record<string, unknown>,
) => Promise<Array<{ text: string; format: string; isValid?: boolean }>>;

class ZxingEngine implements BarcodeEngine {
  readonly name = 'zxing' as const;

  constructor(private readonly readBarcodes: ReadBarcodesFn) {}

  async detect(source: ImageSource): Promise<ScanResult[]> {
    const imageData = source instanceof ImageData ? source : toImageData(source);
    if (!imageData) return [];
    const results = await this.readBarcodes(imageData, {
      formats: ZXING_FORMATS,
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: true,
      maxNumberOfSymbols: 1,
    });
    return results
      .filter((r) => r.text && r.isValid !== false)
      .map((r) => ({ barcode: r.text, format: r.format, engine: 'zxing' as const }));
  }

  dispose(): void {}
}

let zxingReady: Promise<ReadBarcodesFn> | undefined;

/**
 * Carga zxing-wasm apuntando al .wasm de nuestro propio origen.
 *
 * `?url` hace que Vite copie el binario a `dist/assets` y devuelva su ruta con
 * hash, asi que queda precacheado por el Service Worker y funciona sin red.
 */
async function loadZxing(): Promise<ReadBarcodesFn> {
  if (zxingReady) return zxingReady;
  zxingReady = (async () => {
    const [{ readBarcodes, prepareZXingModule }, wasmUrl] = await Promise.all([
      import('zxing-wasm/reader'),
      import('zxing-wasm/reader/zxing_reader.wasm?url').then((m) => m.default as string),
    ]);
    prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith('.wasm') ? wasmUrl : prefix + path,
      },
    });
    return readBarcodes as unknown as ReadBarcodesFn;
  })();
  return zxingReady;
}

function toImageData(source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): ImageData | undefined {
  const width =
    source instanceof HTMLVideoElement ? source.videoWidth : (source as HTMLCanvasElement).width;
  const height =
    source instanceof HTMLVideoElement ? source.videoHeight : (source as HTMLCanvasElement).height;
  if (!width || !height) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

export async function createBarcodeEngine(): Promise<BarcodeEngine> {
  if (await isNativeDetectorAvailable()) {
    const ctor = (globalThis as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    return new NativeEngine(new ctor({ formats: NATIVE_FORMATS }));
  }
  return new ZxingEngine(await loadZxing());
}

/**
 * Valida el digito de control de EAN-13 / EAN-8 / UPC-A.
 *
 * Con luz mala un escaneo puede devolver un codigo sintacticamente valido pero
 * equivocado; consultarlo gastaria cupo del limite de 15 req/min de la API.
 */
export function isValidEan(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  digits.reverse();
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Normaliza a EAN-13, que es como OFF indexa los productos. */
export function normalizeBarcode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 12) return `0${trimmed}`; // UPC-A -> EAN-13
  return trimmed;
}

/** Diagnostico visible en la UI: sin esto, un fallo de escaneo es indepurable. */
export interface ScannerDiagnostics {
  engine?: 'native' | 'zxing';
  framesAnalyzed: number;
  detections: number;
  rejectedByChecksum: number;
  resolution?: string;
  lastError?: string;
  lastRejected?: string;
}

export interface CameraOptions {
  video: HTMLVideoElement;
  facingMode?: 'environment' | 'user';
  onResult: (result: ScanResult) => void;
  onError?: (error: Error) => void;
  /** Se llama tras cada intento, para refrescar el panel de diagnostico */
  onDiagnostics?: (diagnostics: ScannerDiagnostics) => void;
  intervalMs?: number;
}

/**
 * Proporcion del alto y ancho del fotograma que se recorta para analizar.
 *
 * Analizar solo la franja central sube muchisimo la tasa de acierto con
 * webcams: un EAN-13 que ocupa un tercio del ancho de un fotograma de 1280 px
 * apenas tiene pixeles por barra, y recortar evita ademas que el decodificador
 * pierda tiempo en el resto de la escena.
 */
const CROP_WIDTH_RATIO = 0.84;
const CROP_HEIGHT_RATIO = 0.42;

export class CameraScanner {
  private stream?: MediaStream;
  private engine?: BarcodeEngine;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private canvas?: HTMLCanvasElement;
  private lastEmitted?: { code: string; at: number };

  readonly diagnostics: ScannerDiagnostics = {
    framesAnalyzed: 0,
    detections: 0,
    rejectedByChecksum: 0,
  };

  constructor(private readonly opts: CameraOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este navegador no permite acceder a la camara.');
    }

    // Se pide la resolucion mas alta razonable: a mayor resolucion, mas pixeles
    // por barra y mas probabilidad de decodificar.
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: this.opts.facingMode ?? 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    if (this.stopped) {
      this.stop();
      return;
    }

    await this.applyFocusHints();

    this.opts.video.srcObject = this.stream;
    this.opts.video.setAttribute('playsinline', 'true');
    this.opts.video.muted = true;
    await this.opts.video.play();

    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    this.diagnostics.resolution = settings ? `${settings.width}x${settings.height}` : undefined;

    this.engine = await createBarcodeEngine();
    this.diagnostics.engine = this.engine.name;
    this.opts.onDiagnostics?.({ ...this.diagnostics });

    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 200);
  }

  /** Enfoque continuo donde el navegador lo permita: clave a corta distancia. */
  private async applyFocusHints(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    const caps = track.getCapabilities?.() as
      | (MediaTrackCapabilities & { focusMode?: string[] })
      | undefined;
    if (caps?.focusMode?.includes('continuous')) {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
        });
      } catch {
        /* no todos los dispositivos lo permiten; no es critico */
      }
    }
  }

  /** Activa la linterna si el dispositivo la expone. */
  async setTorch(on: boolean): Promise<boolean> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return false;
    const caps = track.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
    if (!caps?.torch) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as unknown as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  }

  hasTorch(): boolean {
    const track = this.stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
    return Boolean(caps?.torch);
  }

  /** Recorta la franja central del fotograma, que es la que ve el usuario. */
  private cropFrame(): ImageData | undefined {
    const video = this.opts.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return undefined;

    const cw = Math.round(vw * CROP_WIDTH_RATIO);
    const ch = Math.round(vh * CROP_HEIGHT_RATIO);
    const sx = Math.round((vw - cw) / 2);
    const sy = Math.round((vh - ch) / 2);

    if (!this.canvas) this.canvas = document.createElement('canvas');
    this.canvas.width = cw;
    this.canvas.height = ch;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return undefined;
    ctx.drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch);
    return ctx.getImageData(0, 0, cw, ch);
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.engine || this.stopped) return;
    const video = this.opts.video;
    if (video.readyState < 2 || !video.videoWidth) return;
    // Si el elemento ya no esta en el documento, el render lo ha sustituido.
    if (!video.isConnected) return;

    this.busy = true;
    try {
      // Primero la franja central (mas rapida y mas precisa); si falla, el
      // fotograma completo, por si el codigo queda fuera del recuadro.
      const crop = this.cropFrame();
      let results = crop ? await this.engine.detect(crop) : [];
      if (results.length === 0) results = await this.engine.detect(video);

      this.diagnostics.framesAnalyzed++;
      if (results.length > 0) this.diagnostics.detections++;

      for (const r of results) {
        const normalized = normalizeBarcode(r.barcode);
        if (!isValidEan(normalized)) {
          this.diagnostics.rejectedByChecksum++;
          this.diagnostics.lastRejected = r.barcode;
          continue;
        }
        const now = Date.now();
        if (this.lastEmitted?.code === normalized && now - this.lastEmitted.at < 2500) continue;
        this.lastEmitted = { code: normalized, at: now };
        this.opts.onDiagnostics?.({ ...this.diagnostics });
        this.opts.onResult({ ...r, barcode: normalized });
        return;
      }
      this.opts.onDiagnostics?.({ ...this.diagnostics });
    } catch (err) {
      this.diagnostics.lastError = err instanceof Error ? err.message : String(err);
      this.opts.onDiagnostics?.({ ...this.diagnostics });
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.engine?.dispose();
    this.engine = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.canvas = undefined;
    if (this.opts.video.srcObject) this.opts.video.srcObject = null;
  }

  get engineName(): string | undefined {
    return this.engine?.name;
  }
}

/**
 * Decodifica un codigo desde una imagen (foto o archivo).
 *
 * Es el camino MAS FIABLE en movil: el usuario dispara con la app de camara
 * del sistema, que enfoca de verdad y captura a resolucion completa, en vez de
 * depender del flujo de video en vivo. Con webcams de escritorio, que suelen
 * tener foco fijo, a veces es la unica via que funciona.
 */
export async function scanFromFile(file: File): Promise<ScanResult | undefined> {
  const bitmap = await createImageBitmap(file);
  try {
    const engine = await createBarcodeEngine();
    const results = await engine.detect(bitmap);
    for (const r of results) {
      const normalized = normalizeBarcode(r.barcode);
      if (isValidEan(normalized)) return { ...r, barcode: normalized };
    }
    return undefined;
  } finally {
    bitmap.close();
  }
}
