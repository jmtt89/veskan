/**
 * Tests de las comprobaciones previas a descargar un catalogo.
 *
 * Son funciones puras a proposito: la decision de si algo cabe, y el mensaje
 * que se le da al usuario, no deberian necesitar un navegador para probarse.
 */

import { describe, expect, it } from 'vitest';
import {
  JOURNAL_HEADROOM,
  classifyEviction,
  detectIosWebkit,
  evictionWarning,
  opfsUnsupportedMessage,
  planSpace,
  spaceProblemMessage,
  unknownQuotaWarning,
} from '../src/core/data/storage-check.js';

const MB = 1024 * 1024;

describe('planSpace', () => {
  it('reserva margen por encima del tamaño del archivo', () => {
    const need = planSpace({ quota: 1000 * MB, usage: 0 }, 100 * MB);
    expect(need.requiredBytes).toBe(Math.ceil(100 * MB * JOURNAL_HEADROOM));
    expect(need.fits).toBe(true);
  });

  it('no cabe cuando el margen no entra, aunque el archivo sí', () => {
    // 100 MB de archivo necesitan 130 MB. Con 110 MB libres, el archivo
    // "cabría" pero la operación fallaría a mitad.
    const need = planSpace({ quota: 110 * MB, usage: 0 }, 100 * MB);
    expect(need.fits).toBe(false);
    expect(need.shortfallBytes).toBeGreaterThan(0);
  });

  it('descuenta lo ya usado', () => {
    const need = planSpace({ quota: 200 * MB, usage: 150 * MB }, 100 * MB);
    expect(need.availableBytes).toBe(50 * MB);
    expect(need.fits).toBe(false);
  });

  it('sin cuota conocida no bloquea, pero lo marca', () => {
    // Safari antiguo no informa. Prohibir la descarga por no poder comprobarlo
    // seria peor que intentarlo y avisar si falla.
    const need = planSpace(undefined, 10 * MB);
    expect(need.quotaKnown).toBe(false);
    expect(need.fits).toBe(true);
    expect(unknownQuotaWarning(need)).toContain('no informa del espacio');
  });

  it('trata una cuota de cero como desconocida', () => {
    expect(planSpace({ quota: 0, usage: 0 }, 1 * MB).quotaKnown).toBe(false);
  });

  it('nunca da espacio disponible negativo', () => {
    const need = planSpace({ quota: 10 * MB, usage: 50 * MB }, 1 * MB);
    expect(need.availableBytes).toBe(0);
  });
});

describe('deteccion de iOS', () => {
  it('reconoce iPhone', () => {
    expect(detectIosWebkit('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 5)).toBe(true);
  });

  it('reconoce iPad aunque se declare como Macintosh', () => {
    // iPadOS miente en su cadena de identificacion: dice "Macintosh". Lo unico
    // que lo delata es que tiene pantalla tactil.
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15';
    expect(detectIosWebkit(ua, 5)).toBe(true);
    expect(detectIosWebkit(ua, 0)).toBe(false); // un Mac de verdad
  });

  it('no confunde Chrome en Linux', () => {
    expect(detectIosWebkit('Mozilla/5.0 (X11; Linux x86_64) Chrome/143', 0)).toBe(false);
  });
});

describe('riesgo de borrado', () => {
  it('en iOS sin instalar, avisa de los 7 dias', () => {
    const risk = classifyEviction({ isIosWebkit: true, installed: false, persisted: false });
    expect(risk).toBe('ios-7-day');
    expect(evictionWarning(risk)).toContain('pantalla de inicio');
  });

  it('en iOS instalada, no hay riesgo', () => {
    expect(classifyEviction({ isIosWebkit: true, installed: true, persisted: false })).toBe('none');
  });

  it('fuera de iOS con almacenamiento persistente, no hay riesgo', () => {
    expect(classifyEviction({ isIosWebkit: false, installed: false, persisted: true })).toBe('none');
  });

  it('fuera de iOS sin persistencia, el riesgo es incierto y se dice', () => {
    const risk = classifyEviction({ isIosWebkit: false, installed: false, persisted: false });
    expect(risk).toBe('unknown');
    expect(evictionWarning(risk)).toBeTruthy();
  });
});

describe('mensajes al usuario', () => {
  it('el de falta de espacio da las tres cifras y una salida', () => {
    const need = planSpace({ quota: 100 * MB, usage: 90 * MB }, 200 * MB);
    const msg = spaceProblemMessage(need, 'Estados Unidos');
    expect(msg.body).toContain('Estados Unidos');
    expect(msg.body).toContain('200 MB'); // lo que ocupa
    expect(msg.body).toContain('260 MB'); // lo que hace falta con margen
    expect(msg.body).toContain('10 MB'); // lo que queda
    // Ofrecer una alternativa, no solo negar.
    expect(msg.body).toMatch(/en línea/);
  });

  it('usa decimales solo por debajo de 10 MB, donde importan', () => {
    const chico = planSpace({ quota: 100 * MB, usage: 95 * MB }, 2.5 * MB);
    expect(spaceProblemMessage(chico, 'Venezuela').body).toContain('2.5 MB');
  });

  it('distingue el caso de otra pestaña', () => {
    expect(opfsUnsupportedMessage('locked-by-other-tab').title).toContain('otra pestaña');
    expect(opfsUnsupportedMessage('no-api').title).not.toContain('otra pestaña');
  });

  it('ningun mensaje deja al usuario sin saber que hacer', () => {
    for (const reason of ['no-api', 'too-old', 'locked-by-other-tab', 'unknown']) {
      const m = opfsUnsupportedMessage(reason);
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.body.length).toBeGreaterThan(40);
    }
  });
});
