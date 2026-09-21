"""
¿Cuantos de nuestros CAS existen en OpenFoodTox? Todos, uno a uno.

POR QUE ESTE SCRIPT. La pregunta parece contestada por el numero de enlaces
-314 de 602- pero ese numero no distingue dos cosas muy distintas:

    el CAS esta en OpenFoodTox y no lo enlazamos   -> fallo nuestro
    el CAS no esta en OpenFoodTox                  -> no hay nada que enlazar

Y hay una razon concreta para no fiarse del audit que ya se hizo: aquel cruzaba
contra la coleccion `oft` cargada, que son 4.387 sustancias porque `oft.py`
descarta las que no tienen ningun valor de referencia. El fichero de EFSA trae
7.890. Una sustancia puede estar en el fichero, no tener valores y por tanto no
estar cargada: contra la coleccion parece ausente y no lo esta.

Este script cruza contra el FICHERO COMPLETO.

QUE SE COMPARA. El CAS que declara Wikidata (P231, que puede traer varios por
item) contra `Inventory.CASNumber` de la hoja REF_SUB. Nada mas: ni nombres, ni
InChI, ni PubChem. Es exactamente la via que usa `enlazar.py`, comprobada de
forma exhaustiva.

COMO SE NORMALIZA, que es donde se cuelan los falsos negativos. Un CAS es
`\\d{2,7}-\\d{2}-\\d`, pero los ficheros lo escriben con espacios, con guiones
distintos o con ceros a la izquierda. Se reduce a digitos y guiones normales
antes de comparar; si aun asi no casa, es que no esta.

Uso:
    python3 auditar-oft.py <oft3.xlsx> <aditivos.jsonl> [salida.csv]

`aditivos.jsonl` es el volcado de la coleccion `aditivos`, tal como lo deja
mongoexport.
"""
import csv
import json
import re
import sys

from extraer import Libro

# `1333-86-4`, tolerando espacios y guiones tipograficos.
CAS = re.compile(r'(\d{2,7})\s*[-–—]\s*(\d{2})\s*[-–—]\s*(\d)')


def normalizar(v):
    """Un CAS reducido a su forma canonica, o None si no lo parece."""
    if not isinstance(v, str):
        return None
    m = CAS.search(v.strip())
    # Los ceros a la izquierda no son significativos: `0064-17-5` es `64-17-5`.
    return f'{int(m.group(1))}-{m.group(2)}-{m.group(3)}' if m else None


def cas_de_wikidata(d):
    """Los CAS que declara el item, por P231."""
    fuera = []
    for s in (d.get('claims') or {}).get('P231') or []:
        v = ((s.get('mainsnak') or {}).get('datavalue') or {}).get('value')
        n = normalizar(v)
        if n and n not in fuera:
            fuera.append(n)
    return fuera


def main(ruta_oft, ruta_aditivos, salida=None):
    # --- el universo de OpenFoodTox, del fichero y no de la coleccion ------
    lib = Libro(ruta_oft)
    ref = {}
    for r in lib.filas('REF_SUB'):
        n = normalizar(r.get('Inventory.CASNumber'))
        if n:
            ref.setdefault(n, []).append(r.get('ReferenceSubstanceName'))
    # Que sustancias apuntan a cada REF_SUB, para poder decir si ademas
    # llegaria a tener datos.
    total_sub = sum(1 for s in lib.filas('SUB') if s.get('Document UUID'))

    print(f'OpenFoodTox {ruta_oft}')
    print(f'   REF_SUB                : {sum(len(v) for v in ref.values())} con CAS legible')
    print(f'   CAS distintos          : {len(ref)}')
    print(f'   sustancias (hoja SUB)  : {total_sub}\n')

    # --- nuestros items -----------------------------------------------------
    filas, sin_tag = [], 0
    for linea in open(ruta_aditivos, encoding='utf8'):
        d = json.loads(linea)
        tags = [t.get('tag') for t in ((d.get('enlaces') or {}).get('off') or [])]
        if not tags:
            sin_tag += 1
            continue
        cas = cas_de_wikidata(d)
        # Que CAS de los suyos aparecen en OpenFoodTox.
        casan = [c for c in cas if c in ref]
        enlazado = bool((d.get('enlaces') or {}).get('oft'))
        filas.append({
            'wikidata': d['_id'],
            'tag': tags[0],
            'numero_e': ((d.get('enlaces') or {}).get('off') or [{}])[0].get('e_number'),
            'nombre': ((d.get('enlaces') or {}).get('off') or [{}])[0].get('nombre'),
            'cas_wikidata': '|'.join(cas),
            'cas_en_oft': '|'.join(casan),
            'nombre_en_oft': '|'.join(
                n for c in casan for n in ref[c] if n)[:120],
            'existe_en_oft': bool(casan),
            'lo_teniamos_enlazado': enlazado,
        })

    # --- el reparto ---------------------------------------------------------
    con_cas = [f for f in filas if f['cas_wikidata']]
    sin_cas = [f for f in filas if not f['cas_wikidata']]
    existe = [f for f in con_cas if f['existe_en_oft']]
    no_existe = [f for f in con_cas if not f['existe_en_oft']]
    # Lo unico que seria un fallo nuestro.
    perdidos = [f for f in existe if not f['lo_teniamos_enlazado']]
    sobran = [f for f in filas
              if f['lo_teniamos_enlazado'] and not f['existe_en_oft']]

    print(f'aditivos con tag de Open Food Facts : {len(filas)}')
    print(f'   sin ningun CAS en Wikidata       : {len(sin_cas)}')
    print(f'   con CAS                          : {len(con_cas)}')
    print(f'      su CAS SI esta en OpenFoodTox : {len(existe)}')
    print(f'      su CAS NO esta                : {len(no_existe)}')
    print()
    print(f'CONTRASTE CON LO QUE TENEMOS ENLAZADO:')
    print(f'   esta en OFT y NO lo enlazamos    : {len(perdidos)}'
          f'{"   <- fallo nuestro" if perdidos else ""}')
    print(f'   lo enlazamos y su CAS no esta    : {len(sobran)}'
          f'{"   <- enlazado por otra via" if sobran else ""}')

    if perdidos:
        print('\n   los que faltan:')
        for f in perdidos[:25]:
            print(f'      {f["tag"]:<12}{str(f["nombre"])[:28]:<30}'
                  f'{f["cas_en_oft"]:<14}{f["nombre_en_oft"][:34]}')
        if len(perdidos) > 25:
            print(f'      ... y {len(perdidos) - 25} mas')

    if salida:
        with open(salida, 'w', encoding='utf8', newline='') as fh:
            w = csv.DictWriter(fh, fieldnames=list(filas[0]))
            w.writeheader()
            w.writerows(filas)
        print(f'\nescrito {salida} ({len(filas)} filas)')


if __name__ == '__main__':
    main(*sys.argv[1:4])
