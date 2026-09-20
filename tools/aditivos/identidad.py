"""
Tabla de identidad entre fuentes, indexada por numero E.

EL PROBLEMA: las tres fuentes no comparten ni un identificador.

    OFF      en:e330     numero E, ningun identificador quimico
    Cellar   E 330       numero E y nombre, nada mas
    OFT      77-92-9     CAS y estructura, NINGUN campo de numero E

Se comprobo campo a campo: en las 7.890 sustancias de referencia de
OpenFoodTox no existe ningun campo de numero E. Aparece de refilon dentro de
`Name` (20,5%) mezclado con sinonimos, sin formato.

LA SOLUCION: Wikidata como puente. Mantiene P628 (numero E) y P231 (CAS), y de
620 items con numero E, 471 traen CAS. No hay fichero oficial que haga este
mapeo -se busco-, asi que esto es lo que la comunidad construyo en su lugar.

    OFF ──numero E──▶ Wikidata ──CAS──▶ OpenFoodTox ──▶ datos de peligro

Es mejor que cruzar por nombre, y no por cobertura -70,0% frente a 63,7% de
apariciones- sino por naturaleza: el CAS es una identidad quimica. Cruzando por
nombre, `De-oiled lecithin` se colaba como la lecitina E322 y
`Cross-linked sodium CMC` como el E466; por CAS no pueden.

AVISO: Wikidata es editable por cualquiera. Un CAS equivocado asigna datos de
peligro al aditivo que no es. Por eso la salida es un fichero revisable con los
nombres de las dos fuentes al lado, para que un cruce malo cante a la vista.

Datos: Open Food Facts (ODbL-1.0), EFSA OpenFoodTox (CC-BY-ND), Wikidata (CC0).
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from extraer import Libro

WDQS = 'https://query.wikidata.org/sparql'
UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)'

CONSULTA = """
SELECT ?item ?itemLabel ?eNumber ?cas WHERE {
  ?item wdt:P628 ?eNumber .
  OPTIONAL { ?item wdt:P231 ?cas }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". }
}
"""


def numero_e(valor):
    """`E 330`, `e330`, `330` -> `330`. Conserva el sufijo romano: `450i`."""
    if valor is None:
        return None
    s = str(valor).strip().upper().replace(' ', '')
    s = s[1:] if s.startswith('E') else s
    m = re.match(r'^(\d{3,4}[A-Z]*)$', s)
    return m.group(1).lower() if m else None


def consultar(consulta):
    """POST, no GET: con muchos VALUES la URL se pasa de largo y da 502."""
    datos = urllib.parse.urlencode({'query': consulta, 'format': 'json'}).encode()
    req = urllib.request.Request(
        WDQS, data=datos,
        headers={'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
                 'Accept': 'application/sparql-results+json'})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)['results']['bindings']


def cas_de_items(qids, cache):
    """
    CAS de unos items concretos de Wikidata.

    Hace falta porque el item BUENO suele ser el que Open Food Facts ya enlaza,
    y ese no se alcanza buscando por numero E: la propiedad P628 tiende a estar
    en el item del GRUPO -«pirofosfato», «antocianina», «sodium citrate»-
    mientras que Open Food Facts apunta al compuesto concreto que es el aditivo.
    Revisadas las 89 discrepancias, en 26 el de Open Food Facts era el correcto
    y en ninguna lo era el nuestro.
    """
    if cache.exists():
        guardado = json.loads(cache.read_text())
    else:
        guardado = {}
    faltan = sorted(set(qids) - set(guardado))
    for i in range(0, len(faltan), 50):
        lote = faltan[i:i + 50]
        filas = consultar(
            'SELECT ?item ?itemLabel ?cas WHERE { VALUES ?item { %s } '
            'OPTIONAL { ?item wdt:P231 ?cas } '
            'SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". } }'
            % ' '.join(f'wd:{q}' for q in lote))
        for q in lote:
            guardado.setdefault(q, {'cas': [], 'etiqueta': None})
        for b in filas:
            q = b['item']['value'].rsplit('/', 1)[-1]
            e = guardado[q]
            e['etiqueta'] = e['etiqueta'] or b.get('itemLabel', {}).get('value')
            c = b.get('cas', {}).get('value')
            if c and c not in e['cas']:
                e['cas'].append(c)
        time.sleep(1)
    if faltan:
        cache.write_text(json.dumps(guardado, ensure_ascii=False, indent=1))
    return guardado


def desde_wikidata(cache):
    """Numero E -> {cas, etiqueta}. Se cachea: la consulta tarda y no cambia."""
    if cache.exists():
        return json.loads(cache.read_text())
    datos = consultar(CONSULTA)
    salida = {}
    for f in datos:
        e = numero_e(f['eNumber']['value'])
        if not e:
            continue
        entrada = salida.setdefault(e, {'cas': [], 'etiqueta': None, 'qid': None})
        entrada['etiqueta'] = entrada['etiqueta'] or f.get('itemLabel', {}).get('value')
        # El Q-id es la clave del puente: sin el no se puede auditar de donde
        # salio un CAS ni volver a consultarlo.
        entrada['qid'] = entrada['qid'] or f['item']['value'].rsplit('/', 1)[-1]
        c = f.get('cas', {}).get('value')
        if c and c not in entrada['cas']:
            entrada['cas'].append(c)
    cache.write_text(json.dumps(salida, ensure_ascii=False, indent=1))
    return salida


def main(ruta_oft, ruta_off, salida, cache_wd, cache_items=None):
    wd = desde_wikidata(Path(cache_wd))
    print(f'Wikidata: {len(wd)} numeros E, '
          f'{sum(1 for v in wd.values() if v["cas"])} con CAS')

    lib = Libro(ruta_oft)
    # REF_SUB lleva la identidad quimica; SUB es a quien apuntan los peligros.
    ref = {r['Document UUID']: r for r in lib.filas('REF_SUB') if r.get('Document UUID')}
    por_cas = {}
    for r in ref.values():
        c = (r.get('Inventory.CASNumber') or '').strip()
        if c:
            por_cas.setdefault(c, []).append(r['Document UUID'])
    sub_de_ref = {}
    nombre_sub = {}
    for s in lib.filas('SUB'):
        u = s.get('Document UUID')
        rs = s.get('ReferenceSubstance.ReferenceSubstance')
        if u and rs:
            sub_de_ref.setdefault(rs, []).append(u)
            nombre_sub[u] = s.get('ChemicalName')
    print(f'OpenFoodTox: {len(por_cas)} CAS distintos, {len(nombre_sub)} sustancias')

    off = json.loads(Path(ruta_off).read_text())
    filas = {}
    for tag, v in off.items():
        e = numero_e((v.get('e_number') or {}).get('en'))
        if not e:
            continue
        fila = filas.setdefault(e, {
            'e_number': e, 'off_tags': [], 'off_nombre': None,
            'cas': [], 'oft_uuid': [], 'oft_nombre': None,
            'param_code': None, 'wikidata_nombre': None,
            # Dos procedencias del mismo identificador: el que encontramos por
            # numero E y el que OFF ya tenia. Si no coinciden, el puente falla
            # en esa fila y hay que mirarla.
            'wikidata_id': None, 'wikidata_off': None, 'wikidata_discrepa': False,
            'wikidata_via': None,
        })
        fila['off_tags'].append(tag)
        if not fila['wikidata_off']:
            fila['wikidata_off'] = (v.get('wikidata') or {}).get('en')
        if not fila['off_nombre']:
            n = (v.get('name') or {}).get('es') or (v.get('name') or {}).get('en')
            fila['off_nombre'] = re.sub(r'^E\d+[a-z]*\s*[-–]\s*', '', n) if n else None

    # MANDA EL ITEM QUE YA TRAE OPEN FOOD FACTS. Su enlace apunta al compuesto
    # concreto del aditivo; buscar por numero E cae en el item del grupo, que
    # o no tiene CAS o tiene el de otra sustancia. Solo se busca por numero E
    # cuando Open Food Facts no trae ninguno.
    de_off = {f['wikidata_off'] for f in filas.values() if f['wikidata_off']}
    items = cas_de_items(de_off, Path(cache_items or (str(cache_wd) + '.items')))

    for e, fila in filas.items():
        raiz = re.match(r'^(\d+)', e).group(1)
        por_numero = wd.get(e) or wd.get(raiz)
        propio = items.get(fila['wikidata_off'] or '')

        if propio and propio['cas']:
            entrada = {'cas': propio['cas'], 'etiqueta': propio['etiqueta'],
                       'qid': fila['wikidata_off']}
            fila['wikidata_via'] = 'off'
        elif por_numero:
            entrada = por_numero
            fila['wikidata_via'] = 'numero-e'
        else:
            continue

        fila['wikidata_nombre'] = entrada['etiqueta']
        fila['wikidata_id'] = entrada['qid']
        if (fila['wikidata_off'] and por_numero and por_numero['qid']
                and fila['wikidata_off'] != por_numero['qid']):
            fila['wikidata_discrepa'] = True
        for c in entrada['cas']:
            if c not in por_cas:
                continue
            fila['cas'].append(c)
            for ru in por_cas[c]:
                fila['param_code'] = fila['param_code'] or ref[ru].get('EFSA PARAM CODE')
                for su in sub_de_ref.get(ru, []):
                    fila['oft_uuid'].append(su)
                    fila['oft_nombre'] = fila['oft_nombre'] or nombre_sub.get(su)

    completas = [f for f in filas.values() if f['oft_uuid']]
    Path(salida).write_text(json.dumps(
        sorted(filas.values(), key=lambda f: f['e_number']), ensure_ascii=False, indent=1) + '\n')
    print(f'\nnumeros E en OFF                 : {len(filas)}')
    print(f'   con CAS y sustancia de OFT    : {len(completas)}')
    print(f'   solo con tag de OFF           : {len(filas) - len(completas)}')
    # Contraste entre las dos procedencias del Q-id: es la unica comprobacion
    # independiente que tenemos de que el puente por Wikidata es correcto.
    con_ambos = [f for f in filas.values() if f['wikidata_id'] and f['wikidata_off']]
    discrepan = [f for f in con_ambos if f['wikidata_discrepa']]
    print(f'\ncontraste del Q-id (nuestro vs el que OFF ya traia):')
    print(f'   filas con los dos             : {len(con_ambos)}')
    print(f'   coinciden                     : {len(con_ambos) - len(discrepan)}')
    print(f'   DISCREPAN (revisar)           : {len(discrepan)}')
    via = {}
    for f in completas:
        via[f['wikidata_via']] = via.get(f['wikidata_via'], 0) + 1
    print(f'\npor donde se resolvio el CAS de las completas:')
    for k, n in sorted(via.items(), key=lambda x: -x[1]):
        print(f'   {n:>4}  {k}')
    print(f'\nescrito {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:6])
