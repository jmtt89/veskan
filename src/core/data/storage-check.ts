/**
 * Comprobaciones previas a descargar un catalogo.
 *
 * Criterio de diseno explicito: **si no cabe o el navegador lo impide, se dice
 * claramente y no se degrada en silencio**. Pasar a consulta en linea sin avisar
 * seria peor que fallar, porque el usuario creeria tener el catalogo guardado y
 * lo descubriria justo cuando pierde cobertura, que es cuando lo necesita.
 *
 * Todo aqui son funciones puras salvo las dos que consultan al navegador, para
 * poder probarlas sin navegador.
 */

/**
 * Margen sobre el tamano del archivo.
 *
 * SQLite necesita espacio temporal mientras escribe y mientras aplica
 * actualizaciones (journal y tablas temporales), asi que reservar justo el
 * tamano del archivo deja la descarga a merced de un fallo de cuota a mitad.
 */
export const JOURNAL_HEADROOM = 1.3;

export interface SpaceNeed {
  /** Lo que pesa el archivo */
  downloadBytes: number;
  /** Lo que hay que tener libre, con margen */
  requiredBytes: number;
  availableBytes: number;
  fits: boolean;
  shortfallBytes: number;
  /** false cuando el navegador no informa de la cuota (Safari antiguo) */
  quotaKnown: boolean;
}

export function planSpace(
  estimate: { quota?: number; usage?: number } | undefined,
  downloadBytes: number,
  headroom = JOURNAL_HEADROOM,
): SpaceNeed {
  const requiredBytes = Math.ceil(downloadBytes * headroom);
  const quota = estimate?.quota;
  const usage = estimate?.usage ?? 0;

  if (typeof quota !== 'number' || quota <= 0) {
    // Sin cuota conocida no se puede decidir. Se deja pasar, pero marcado, para
    // que la interfaz lo advierta en vez de prometer que cabe.
    return {
      downloadBytes,
      requiredBytes,
      availableBytes: 0,
      fits: true,
      shortfallBytes: 0,
      quotaKnown: false,
    };
  }

  const availableBytes = Math.max(0, quota - usage);
  const fits = availableBytes >= requiredBytes;
  return {
    downloadBytes,
    requiredBytes,
    availableBytes,
    fits,
    shortfallBytes: fits ? 0 : requiredBytes - availableBytes,
    quotaKnown: true,
  };
}

// ---------------------------------------------------------------------------
// Riesgo de borrado
// ---------------------------------------------------------------------------

export type EvictionRisk = 'none' | 'ios-7-day' | 'unknown';

/**
 * Detecta Safari sobre iOS o iPadOS.
 *
 * iPadOS se declara como "Macintosh" en su cadena de identificacion, asi que
 * hay que mirar ademas si el dispositivo tiene pantalla tactil.
 */
export function detectIosWebkit(ua: string, maxTouchPoints: number): boolean {
  const esIphoneOiPod = /iPhone|iPod/.test(ua);
  const esIpadDisfrazado = /Macintosh/.test(ua) && maxTouchPoints > 1;
  const esIpadDeclarado = /iPad/.test(ua);
  return esIphoneOiPod || esIpadDeclarado || esIpadDisfrazado;
}

/** ¿Corre la aplicacion instalada en la pantalla de inicio? */
export function isInstalled(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

/**
 * En iOS, Safari borra el almacenamiento a los 7 dias sin usar la aplicacion.
 * Las anadidas a la pantalla de inicio quedan exentas.
 */
export function classifyEviction(info: {
  isIosWebkit: boolean;
  installed: boolean;
  persisted: boolean;
}): EvictionRisk {
  if (!info.isIosWebkit) return info.persisted ? 'none' : 'unknown';
  if (info.installed) return 'none';
  return 'ios-7-day';
}

/**
 * Pide que el almacenamiento no sea desalojable.
 *
 * Los navegadores lo conceden segun su propia heuristica (uso frecuente, si
 * esta instalada...), asi que puede devolver `false` sin que sea un error.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------------------

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export interface UserMessage {
  title: string;
  body: string;
}

export function spaceProblemMessage(need: SpaceNeed, countryLabel: string): UserMessage {
  return {
    title: 'No hay espacio suficiente',
    body:
      `El catálogo de ${countryLabel} ocupa ${mb(need.downloadBytes)}, y hacen falta ` +
      `${mb(need.requiredBytes)} libres porque la base de datos necesita espacio temporal ` +
      `mientras se escribe y se actualiza. En este dispositivo quedan ` +
      `${mb(need.availableBytes)}. Libera espacio o usa este catálogo en línea, sin descargarlo.`,
  };
}

export function opfsUnsupportedMessage(reason: string): UserMessage {
  if (reason === 'locked-by-other-tab') {
    return {
      title: 'Veskan está abierto en otra pestaña',
      body:
        'La copia guardada solo puede usarse desde una pestaña a la vez. Cierra la otra y ' +
        'vuelve a intentarlo; mientras tanto, la aplicación funciona consultando en línea.',
    };
  }
  if (reason === 'handles-busy') {
    return {
      title: 'El almacén local sigue ocupado',
      body:
        'La carga anterior de la página todavía lo estaba usando y no se ha soltado a tiempo. ' +
        'Vuelve a cargar la página y volverá a aparecer. Tus catálogos no se han perdido.',
    };
  }
  if (reason === 'unknown') {
    return {
      title: 'No se ha podido abrir el almacén local',
      body:
        'Tus catálogos siguen guardados, pero esta vez no se han podido abrir. Vuelve a ' +
        'cargar la página; mientras tanto, Veskan funciona consultando en línea.',
    };
  }
  if (reason === 'too-old') {
    return {
      title: 'Navegador demasiado antiguo',
      body:
        'Tu navegador no admite guardar bases de datos en disco. Veskan seguirá funcionando ' +
        'en línea, pero no habrá catálogo sin conexión. Actualizarlo lo resolvería.',
    };
  }
  return {
    title: 'Este navegador no puede guardar el catálogo',
    body:
      'No permite almacenar bases de datos en disco. Veskan seguirá funcionando consultando ' +
      'Open Food Facts en línea, pero no podrás usarlo sin conexión.',
  };
}

export function evictionWarning(risk: EvictionRisk): string | undefined {
  if (risk === 'ios-7-day') {
    return (
      'Safari borra lo guardado a los 7 días si no abres la aplicación. Añade Veskan a tu ' +
      'pantalla de inicio y dejará de borrarse.'
    );
  }
  if (risk === 'unknown') {
    return 'El navegador puede liberar este espacio si necesita sitio. Usar la aplicación a menudo lo evita.';
  }
  return undefined;
}

export function unknownQuotaWarning(need: SpaceNeed): string | undefined {
  if (need.quotaKnown) return undefined;
  return (
    'Este navegador no informa del espacio disponible, así que no se puede comprobar de ' +
    'antemano si cabe. Si falla a mitad, se avisará.'
  );
}
