"""
Los aditivos SIN CAS: por donde se llega a OpenFoodTox cuando la via no existe.

EL HUECO QUE DEJA EL AUDIT POR CAS. `auditar-oft.py` cruza el CAS de Wikidata
contra el de OpenFoodTox y contesta muy bien a su pregunta, pero solo puede
hablar de los items que TIENEN CAS. Los que no lo tienen quedan fuera del
recuento, ni enlazados ni fallidos: invisibles. Son 137 de 602, y no son
residuales -entre ellos estan las familias de fosfatos y el E471-.

Este script los audita uno a uno y dice por que via seria alcanzable cada uno.

LAS VIAS, Y CUANTO SE FIAN. Se prueban tres, y se informan por separado porque
NO valen lo mismo:

    numero-e   el nombre de la sustancia de EFSA declara el numero E, sea
               suelto («E 471») o en rango («E 450-452»). Es la via que ya usa
               `enlazar.py`; se audita para saber a cuantos alcanza, no para
               descubrirla.

    familia    el aditivo pertenece a un grupo cuyos MIEMBROS si tienen CAS en
               OpenFoodTox. La herencia usa el CAS del miembro, asi que hereda
               la fiabilidad del CAS. Es la unica de las tres que no adivina.

    nombre     coincidencia del nombre normalizado. LA MENOS FIABLE y por eso
               va aparte y se imprime entera: comparar nombres entre idiomas ya
               nos dio 231 falsos positivos una vez. Aqui solo se compara el
               nombre INGLES contra el ingles de EFSA, y aun asi hay que mirar
               cada linea antes de creersela.

CONTRA EL FICHERO, NO CONTRA LO CARGADO, igual que los otros dos audits: la
coleccion `oft` son 4.387 sustancias porque `oft.py` descarta las que no tienen
ningun valor, y el fichero de EFSA trae 7.890.

Uso:
    python3 auditar-sin-cas.py <oft3.xlsx> <aditivos.jsonl> [salida.csv]
"""
import csv
import json
import re
import sys
import unicodedata

from extraer import Libro

CAS = re.compile(r'(\d{2,7})\s*[-–—]\s*(\d{2})\s*[-–—]\s*(\d)')
# Las mismas dos de `enlazar.py`, para auditar la via que existe y no otra.
E_EN_NOMBRE = re.compile(r'\bE\s?(\d{3,4})\s*[-–—]\s*(\d{3,4})\b')
E_SUELTO = re.compile(r'\bE\s?(\d{3,4})(?!\s*[-–—]\s*\d)')

# Conectores que solo aportan ruido. El CATION NO ESTA AQUI a proposito: la
# primera version metia `sodium`, `potassium`, `calcium` y `magnesium` como
# palabras vacias y eso caso «Sodium sulphates» con «Potassium sulphates» y
# «Fatty acids» con «Magnesium salts of fatty acids». En una sal inorganica el
# cation es la identidad, no un adorno.
VACIAS = {'of', 'and', 'or', 'the'}


def normalizar_cas(v):
    if not isinstance(v, str):
        return None
    m = CAS.search(v.strip())
    return f'{int(m.group(1))}-{m.group(2)}-{m.group(3)}' if m else None


def normalizar_nombre(v):
    """Minusculas, sin acentos, sin puntuacion ni numeros E, sin duplicados."""
    if not isinstance(v, str) or not v.strip():
        return None
    s = unicodedata.normalize('NFKD', v.lower())
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r'\be\s?\d{3,4}[a-z]*\b', ' ', s)     # el numero E no identifica
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    palabras = [p for p in s.split() if p and p not in VACIAS]
    return ' '.join(palabras) or None


def cas_de_wikidata(d):
    fuera = []
    for s in (d.get('claims') or {}).get('P231') or []:
        v = ((s.get('mainsnak') or {}).get('datavalue') or {}).get('value')
        n = normalizar_cas(v)
        if n and n not in fuera:
            fuera.append(n)
    return fuera


def universo_oft(ruta):
    """
    El fichero entero de EFSA, indexado por las tres vias que se auditan.

    Se recorre REF_SUB (la sustancia de referencia, que es quien lleva el CAS)
    y SUB (la sustancia concreta de cada dictamen, que es quien lleva el
    nombre donde aparecen los numeros E).
    """
    lib = Libro(ruta)

    por_cas, nombre_ref = {}, {}
    for r in lib.filas('REF_SUB'):
        uuid = r.get('Document UUID')
        nombre_ref[uuid] = r.get('ReferenceSubstanceName')
        n = normalizar_cas(r.get('Inventory.CASNumber'))
        if n:
            por_cas.setdefault(n, []).append(uuid)

    nombre_sub, ref_de_sub = {}, {}
    for s in lib.filas('SUB'):
        u = s.get('Document UUID')
        if not u:
            continue
        nombre_sub[u] = s.get('ChemicalName')
        ref_de_sub[u] = s.get('ReferenceSubstance.Document UUID')

    # Via numero E: el nombre declara los numeros que cubre.
    por_numero_e = {}
    for u, nombre in nombre_sub.items():
        if not nombre:
            continue
        cubre = set()
        for m in E_EN_NOMBRE.finditer(nombre):
            a, b = int(m.group(1)), int(m.group(2))
            if 0 < b - a < 200:
                cubre.update(str(x) for x in range(a, b + 1))
        for m in E_SUELTO.finditer(nombre):
            cubre.add(m.group(1))
        for e in cubre:
            por_numero_e.setdefault(e, []).append(u)

    # Via nombre: se indexan los dos nombres que da EFSA, el de la sustancia
    # y el de su sustancia de referencia.
    por_nombre = {}
    for u, nombre in nombre_sub.items():
        for n in (nombre, nombre_ref.get(ref_de_sub.get(u))):
            k = normalizar_nombre(n)
            if k:
                por_nombre.setdefault(k, set()).add(u)

    return {'cas': por_cas, 'numero_e': por_numero_e, 'nombre': por_nombre,
            'nombre_sub': nombre_sub, 'nombre_ref': nombre_ref,
            'ref_de_sub': ref_de_sub, 'total_ref': len(nombre_ref),
            'total_sub': len(nombre_sub)}


def raiz_e(e):
    m = re.match(r'^(\d{3,4})', str(e or ''))
    return m.group(1) if m else None


def main(ruta_oft, ruta_aditivos, salida=None):
    oft = universo_oft(ruta_oft)

    # --- nuestros items, y el mapa de familias ------------------------------
    items = []
    for linea in open(ruta_aditivos, encoding='utf8'):
        d = json.loads(linea)
        off = (d.get('enlaces') or {}).get('off') or []
        if not off:
            continue
        items.append({
            'wikidata': d['_id'],
            'tags': [t.get('tag') for t in off],
            'tag': off[0].get('tag'),
            'nombre': off[0].get('nombre'),
            'nombre_en': off[0].get('nombre_en'),
            'numeros_e': sorted({t.get('e_number') for t in off
                                 if t.get('e_number')}),
            'cas': cas_de_wikidata(d),
            'enlazado': bool((d.get('enlaces') or {}).get('oft')),
            'tiene_ida': bool(((d.get('oft') or {}).get('valor') or {}).get('ida')
                              is not None),
            'tiene_nivel': ((d.get('gravedad') or {}).get('nivel')
                            is not None),
        })

    # Quien tiene CAS que EXISTE en OpenFoodTox, por raiz de numero E: es lo
    # que un hermano de familia podria heredar.
    hermanos = {}
    for it in items:
        if not any(c in oft['cas'] for c in it['cas']):
            continue
        for e in it['numeros_e']:
            r = raiz_e(e)
            if r:
                hermanos.setdefault(r, []).append(it)

    sin_cas = [it for it in items if not it['cas']]

    print(f'aditivos con tag de Open Food Facts : {len(items)}')
    print(f'   con CAS en Wikidata              : {len(items) - len(sin_cas)}'
          f'   (los audita auditar-oft.py)')
    print(f'   SIN CAS                          : {len(sin_cas)}'
          f'   <- los de aqui')
    print(f'\nOpenFoodTox {ruta_oft}')
    print(f'   sustancias de referencia         : {oft["total_ref"]}')
    print(f'   sustancias                       : {oft["total_sub"]}')
    print(f'   numeros E declarados en nombres  : {len(oft["numero_e"])}')
    print(f'   nombres distintos normalizados   : {len(oft["nombre"])}')

    filas = []
    for it in sin_cas:
        # via numero E
        por_e = set()
        for e in it['numeros_e']:
            r = raiz_e(e)
            if r:
                por_e.update(oft['numero_e'].get(r, []))
        # via familia: un hermano con el mismo numero E raiz y con CAS en OFT
        fam = []
        for e in it['numeros_e']:
            r = raiz_e(e)
            for h in hermanos.get(r, []):
                if h['wikidata'] != it['wikidata']:
                    fam.append(h)
        # via nombre, solo con el nombre ingles
        k = normalizar_nombre(it['nombre_en'])
        por_n = oft['nombre'].get(k, set()) if k else set()

        filas.append({**it, 'por_e': por_e, 'fam': fam, 'por_n': por_n,
                      'clave_nombre': k})

    con_e = [f for f in filas if f['por_e']]
    con_fam = [f for f in filas if f['fam']]
    # El nombre solo aporta donde las otras dos no llegan.
    solo_n = [f for f in filas if f['por_n'] and not f['por_e'] and not f['fam']]
    a_oscuras = [f for f in filas
                 if not f['por_e'] and not f['fam'] and not f['por_n']]

    print(f'\nDE LOS {len(sin_cas)} SIN CAS, POR QUE VIA SE LLEGA A EFSA')
    print(f'   numero E declarado en el nombre  : {len(con_e)}'
          f'   (de ellos, enlazados hoy: '
          f'{sum(1 for f in con_e if f["enlazado"])})')
    print(f'   hermano de familia con CAS en OFT: {len(con_fam)}')
    print(f'   solo por nombre                  : {len(solo_n)}'
          f'   <- hay que mirarlas una a una')
    print(f'   ninguna via                      : {len(a_oscuras)}')

    perdidos = [f for f in con_e if not f['enlazado']]
    if perdidos:
        print(f'\n   SU NUMERO E ESTA EN EFSA Y NO LO ENLAZAMOS: {len(perdidos)}')
        for f in perdidos[:25]:
            print(f'      {f["tag"]:<14}{str(f["nombre"])[:30]:<32}'
                  f'{str(oft["nombre_sub"].get(sorted(f["por_e"])[0]))[:46]}')
        if len(perdidos) > 25:
            print(f'      ... y {len(perdidos) - 25} mas')

    if solo_n:
        print('\n   CANDIDATAS SOLO POR NOMBRE — ninguna se aplica sin leerla:')
        for f in solo_n:
            u = sorted(f['por_n'])[0]
            print(f'      {f["tag"]:<14}{str(f["nombre_en"])[:32]:<34}'
                  f'-> {str(oft["nombre_sub"].get(u))[:44]}')

    huerfanos_utiles = [f for f in a_oscuras if not f['tiene_ida']]
    print(f'\n   sin ninguna via Y sin IDA por otro lado : '
          f'{len(huerfanos_utiles)}')

    if salida:
        with open(salida, 'w', encoding='utf8', newline='') as fh:
            w = csv.writer(fh)
            w.writerow(['wikidata', 'tag', 'nombre', 'nombre_en', 'numeros_e',
                        'via_numero_e', 'via_familia', 'via_nombre',
                        'enlazado_hoy', 'tiene_ida', 'tiene_nivel',
                        'nombre_en_efsa'])
            for f in filas:
                u = (sorted(f['por_e'])[:1] or sorted(f['por_n'])[:1] or [None])[0]
                w.writerow([
                    f['wikidata'], f['tag'], f['nombre'], f['nombre_en'],
                    '|'.join(f['numeros_e']),
                    len(f['por_e']), len(f['fam']), len(f['por_n']),
                    f['enlazado'], f['tiene_ida'], f['tiene_nivel'],
                    oft['nombre_sub'].get(u) if u else None,
                ])
        print(f'\nescrito {salida} ({len(filas)} filas)')


if __name__ == '__main__':
    main(*sys.argv[1:4])
