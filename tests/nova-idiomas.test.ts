/**
 * Tests de los marcadores NOVA en varios idiomas.
 *
 * Los patrones estuvieron solo en castellano y despues en castellano e ingles.
 * Francia es el mayor catalogo del volcado -1.266.272 productos, mas que
 * Estados Unidos- y Alemania tiene 426.111: dejarlos fuera apagaba la
 * inferencia justo donde hay mas datos. Ademas el desacentuado era un mapa con
 * las tildes espanolas, asi que `arome` o `acucar` no se normalizaban nunca.
 */

import { describe, expect, it } from 'vitest';
import { inferNova } from '../src/core/scoring/nova.js';
import type { Product } from '../src/core/types.js';

const conIngredientes = (ingredientsText: string): Product => ({
  barcode: '0000000000000',
  name: 'Producto',
  brands: [],
  kind: 'food',
  additiveTags: [],
  allergenTags: [],
  labelTags: [],
  categoryTags: [],
  countryTags: [],
  nutriments: {},
  categoryFlags: {
    isBeverage: false, isWater: false, isCheese: false,
    isFatOilNutsSeeds: false, isRedMeat: false,
  },
  ingredientsText,
  source: 'openfoodfacts',
  fetchedAt: Date.now(),
});

// `inferNova` devuelve undefined a proposito cuando no hay marcadores NI grupo
// de origen: prefiere no saber a inventarse un NOVA.
const marcadores = (texto: string) =>
  inferNova(conIngredientes(texto), new Map())?.markers ?? [];

describe('marcadores NOVA por idioma', () => {
  it('frances, con sus acentos', () => {
    expect(marcadores('sucre, sirop de glucose, huile de palme')).not.toHaveLength(0);
    expect(marcadores('farine, arômes naturels, sel')).not.toHaveLength(0);
    expect(marcadores('huile végétale partiellement hydrogénée')).not.toHaveLength(0);
    expect(marcadores('exhausteur de goût: glutamate')).not.toHaveLength(0);
  });

  it('aleman', () => {
    expect(marcadores('Zucker, Glukosesirup, Palmöl')).not.toHaveLength(0);
    expect(marcadores('Weizenmehl, Geschmacksverstärker, Salz')).not.toHaveLength(0);
    expect(marcadores('modifizierte Stärke, Hefeextrakt')).not.toHaveLength(0);
  });

  it('portugues, incluido el de Brasil', () => {
    expect(marcadores('açúcar, xarope de glicose, sal')).not.toHaveLength(0);
    expect(marcadores('amido modificado, aromatizante artificial')).not.toHaveLength(0);
    expect(marcadores('gordura vegetal parcialmente hidrogenada')).not.toHaveLength(0);
  });

  it('italiano', () => {
    expect(marcadores('zucchero, sciroppo di glucosio')).not.toHaveLength(0);
    expect(marcadores('esaltatore di sapidità, estratto di lievito')).not.toHaveLength(0);
  });

  it('sigue funcionando en castellano e ingles', () => {
    expect(marcadores('azúcar, jarabe de maíz, saborizante natural')).not.toHaveLength(0);
    expect(marcadores('sugar, high fructose corn syrup, natural flavors')).not.toHaveLength(0);
  });

  it('cita el texto del fabricante con sus acentos, no el normalizado', () => {
    const m = marcadores('ingredientes: PROTEÍNA VEGETAL AISLADA, sal');
    expect(m.some((x) => x.value.includes('PROTEÍNA'))).toBe(true);
  });

  it('no repite el mismo hallazgo porque varios idiomas compartan palabra', () => {
    // «caseinato» casa con el patron castellano y con el portugues/italiano.
    const m = marcadores('leche, caseinato de sodio');
    const valores = m.map((x) => x.value.toLowerCase());
    expect(new Set(valores).size).toBe(valores.length);
  });

  it('no marca una lista de ingredientes sin nada industrial', () => {
    expect(marcadores('tomates, sel, basilic')).toHaveLength(0);
    expect(marcadores('Wasser, Tomaten, Salz')).toHaveLength(0);
  });
});
