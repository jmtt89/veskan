/**
 * Tests de las banderas de categoria.
 *
 * Existen porque la aplicacion las deducia de `categories_tags` y la tuberia las
 * leia de `nutriscore_data`: el MISMO producto podia puntuar distinto segun
 * viniera del catalogo o de la API. Y ninguna de las dos era la buena:
 * `nutriscore["2023"].data` las tiene en el 99,1% de los 4.753.871 productos,
 * frente al 43,5% y el 29,6% de las otras.
 */

import { describe, expect, it } from 'vitest';
import { banderasDe } from '../scripts/lib/categorias.mjs';

describe('banderas de categoria', () => {
  it('prefiere la estructura v3, que es la que esta en el 99,1%', () => {
    const b = banderasDe({
      nutriscore: { '2023': { data: { is_beverage: 1, is_water: 0, is_cheese: 0 } } },
      nutriscore_data: { is_beverage: 0 },
      categories_tags: ['en:cheeses'],
    });
    expect(b.isBeverage).toBe(true);
    expect(b.origen).toBe('nutriscore_2023');
  });

  it('cae a 2021 y luego al formato anterior', () => {
    expect(banderasDe({ nutriscore: { '2021': { data: { is_beverage: 1 } } } }).origen).toBe('nutriscore_2021');
    expect(banderasDe({ nutriscore_data: { is_beverage: 0, is_cheese: 1 } }).origen).toBe('nutriscore_data');
  });

  it('las categorias son el ultimo recurso, no el primero', () => {
    const b = banderasDe({ categories_tags: ['en:beverages', 'en:sodas'] });
    expect(b.isBeverage).toBe(true);
    expect(b.origen).toBe('categories_tags');
  });

  it('reconoce categorias en varios idiomas, no solo en ingles', () => {
    expect(banderasDe({ categories_tags: ['fr:boissons'] }).isBeverage).toBe(true);
    expect(banderasDe({ categories_tags: ['es:bebidas'] }).isBeverage).toBe(true);
    expect(banderasDe({ categories_tags: ['es:quesos'] }).isCheese).toBe(true);
  });

  it('acepta las banderas como numero, cadena o booleano', () => {
    // Comprobado en datos reales: `is_cheese: "1"`.
    expect(banderasDe({ nutriscore_data: { is_beverage: 0, is_cheese: '1' } }).isCheese).toBe(true);
    expect(banderasDe({ nutriscore_data: { is_beverage: true } }).isBeverage).toBe(true);
  });

  it('la carne roja viene con dos nombres distintos', () => {
    expect(banderasDe({ nutriscore_data: { is_beverage: 0, is_red_meat_product: 1 } }).isRedMeat).toBe(true);
    expect(banderasDe({ nutriscore: { '2023': { data: { is_beverage: 0, is_red_meat: 1 } } } }).isRedMeat).toBe(true);
  });

  it('sin ninguna fuente no inventa: todo falso y origen nulo', () => {
    const b = banderasDe({ code: '123' });
    expect(Object.values(b).filter((v) => v === true)).toHaveLength(0);
    expect(b.origen).toBeNull();
  });
});
