/**
 * Utilidades minimas de renderizado.
 *
 * Con cinco pantallas no hace falta un framework: bastan un par de ayudantes
 * sobre el DOM. `html` escapa por defecto para que ningun dato de producto
 * (que viene de una base colaborativa y editable por cualquiera) pueda inyectar
 * marcado.
 */

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Marca un fragmento como ya seguro para insertarlo sin escapar. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export const raw = (s: string): SafeHtml => new SafeHtml(s);

/**
 * Plantilla etiquetada que escapa todas las interpolaciones salvo las que
 * vengan envueltas en `raw()` o sean resultado de otro `html`.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v instanceof SafeHtml) out += v.value;
    else if (Array.isArray(v)) {
      out += v.map((item) => (item instanceof SafeHtml ? item.value : escapeHtml(item))).join('');
    } else if (v === null || v === undefined || v === false) {
      out += '';
    } else {
      out += escapeHtml(v);
    }
    out += strings[i + 1] ?? '';
  }
  return new SafeHtml(out);
}

export function mount(target: HTMLElement, content: SafeHtml): void {
  target.innerHTML = content.value;
}

/** Delegacion de eventos: un solo listener en la raiz, estable entre renders. */
export function delegate(
  root: HTMLElement,
  eventName: string,
  selector: string,
  handler: (el: HTMLElement, event: Event) => void,
): void {
  root.addEventListener(eventName, (event) => {
    const target = event.target as HTMLElement | null;
    const match = target?.closest<HTMLElement>(selector);
    if (match && root.contains(match)) handler(match, event);
  });
}

/**
 * Valor de un atributo ARIA booleano.
 *
 * Hace falta porque `html` convierte `false` en cadena vacia -- lo que permite
 * escribir `${cond && html`...`}` -- y eso dejaba `aria-expanded=""`, que no es
 * un valor valido. El fallo solo asomaba con el control CERRADO, que es su
 * estado por defecto.
 */
export const ariaBool = (v: unknown): string => (v ? 'true' : 'false');
