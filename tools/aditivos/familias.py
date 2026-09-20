"""
Familias de aditivos: el grupo y sus miembros.

EL PROBLEMA. Algunos numeros E no son una sustancia sino una familia. `E340`
son «fosfatos de potasio»; las sustancias son `E340i` monopotasico, `E340ii`
dipotasico y `E340iii` tripotasico. Medido: de 671 items de Wikidata, **159 no
tienen CAS**, y no por descuido -una familia no tiene numero CAS porque no es
un compuesto-. Sus miembros si:

    E340    fosfatos de potasio     CAS —            <- familia
    E340i   fosfato monopotasico    CAS 7778-77-0
    E340ii  fosfato dipotasico      CAS 7758-11-4
    E340iii fosfato tripotasico     CAS 7778-53-2

Eso explica el 8,6% de apariciones que no llegaban a datos de peligro:
`E471 mono- y digliceridos`, `E340`, `E452 polifosfatos`, `E339 fosfatos de
sodio`. No fallaba el cruce, fallaba la pregunta.

COMO SE RECONOCE UNA FAMILIA. Por el sufijo romano del TAG, no por el numero:
Open Food Facts le da `e_number = 340` tanto a `en:e340` como a `en:e340i`, asi
que el numero no distingue. El tag si. Se cruza ademas con los campos
`parents`/`children` de la taxonomia, que estan declarados solo en el 7,6% pero
donde estan, mandan.

LA HERENCIA SE MARCA. Que `Disodium diphosphate` tenga datos no implica que
todos los difosfatos se comporten igual. El campo `heredado` dice que ese dato
no se midio sobre la familia sino sobre uno de sus miembros, y de cual.

Datos: Open Food Facts (ODbL-1.0), Wikidata (CC0), EFSA OpenFoodTox (CC-BY-ND).
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# `en:e340i` -> ('340', 'i')   ·   `en:e340` -> ('340', '')
TAG = re.compile(r'^en:e(\d{3,4})([ivx]*)([a-z]*)$')


def partes(tag):
    m = TAG.match(tag)
    return (m.group(1), m.group(2)) if m else (None, None)


def main(ruta_enlaces, ruta_off, ruta_oft, salida):
    # Sustancias de OpenFoodTox que SI tienen valor o efecto, para no contar
    # como herencia un enlace vacio.
    con_datos = {}
    for linea in open(ruta_oft, encoding='utf8'):
        d = json.loads(linea)
        ida = (d.get('valor') or {}).get('ida')
        tox = (d.get('critico') or {}).get('toxicidad')
        if ida is not None or tox:
            con_datos[d['_id']] = {'ida': ida, 'toxicidad': tox}
    off = json.loads(Path(ruta_off).read_text())
    # Enlaces ya calculados por `enlazar.py`, indexados por tag de OFF.
    #
    # MANDA EL ENLACE DIRECTO. Un tag puede aparecer en dos items: en el suyo
    # -porque Open Food Facts lo enlaza, `via: wikidata`- y en el del GRUPO
    # -porque comparten numero E, `via: numero-e`-. `e340i`, `e340ii` y
    # `e340iii` tienen todos `e_number = 340`, asi que el item del grupo se los
    # atribuye a los tres. Quedarse con el primero que aparezca asignaba a los
    # tres miembros el Q-id del grupo y perdia su CAS, que es justo el dato por
    # el que existe esta tabla.
    por_tag = {}
    for linea in open(ruta_enlaces, encoding='utf8'):
        d = json.loads(linea)
        for e in d.get('enlaces', {}).get('off', []):
            por_tag.setdefault(e['tag'], []).append({
                'wikidata': d['_id'],
                'via': e.get('via'),
                'oft': d.get('enlaces', {}).get('oft', []),
                'revisar': d.get('revisar', []),
            })
    for tag, lista in por_tag.items():
        lista.sort(key=lambda x: 0 if x['via'] == 'wikidata' else 1)

    # Agrupar por numero E: quien es familia y quienes miembros.
    grupos = defaultdict(lambda: {'familia': None, 'miembros': []})
    for tag in off:
        num, romano = partes(tag)
        if not num:
            continue
        if romano:
            grupos[num]['miembros'].append(tag)
        else:
            grupos[num]['familia'] = tag

    # `children` de la taxonomia: poco frecuente, pero donde esta, manda.
    for tag, v in off.items():
        for hijo in (v.get('children') or []):
            num, _ = partes(tag)
            if num and hijo not in grupos[num]['miembros'] and hijo != tag:
                grupos[num]['miembros'].append(hijo)

    def datos(tag):
        d = (por_tag.get(tag) or [{}])[0]
        oft = d.get('oft') or []
        nombre = (off.get(tag, {}).get('name') or {}).get('es') \
            or (off.get(tag, {}).get('name') or {}).get('en')
        return {
            'tag': tag,
            'nombre': re.sub(r'^E\d+[a-z]*\s*[-–]\s*', '', nombre) if nombre else None,
            'wikidata': d.get('wikidata'),
            'cas': sorted({s['cas'] for s in oft if s.get('cas')}),
            'oft_uuid': sorted({s['uuid'] for s in oft if s.get('uuid')}),
            'oft_nombre': (oft[0]['nombre'] if oft else None),
            # Lo que de verdad decide si aporta algo a la familia.
            'datos': [con_datos[s['uuid']] for s in oft
                      if s.get('uuid') in con_datos],
        }

    salidas, con_herencia, propios = [], 0, 0
    for num, g in sorted(grupos.items()):
        if not g['miembros']:
            continue                      # no es familia: un solo compuesto
        fam = datos(g['familia']) if g['familia'] else {
            'tag': None, 'nombre': None, 'wikidata': None,
            'cas': [], 'oft_uuid': [], 'oft_nombre': None}
        miembros = [datos(t) for t in sorted(set(g['miembros']))]

        # La familia hereda solo si no tiene dato propio.
        heredado = None
        if not fam['datos']:
            con_dato = [m for m in miembros if m['datos']]
            if con_dato:
                heredado = {
                    'de': [m['tag'] for m in con_dato],
                    'oft_uuid': sorted({u for m in con_dato for u in m['oft_uuid']}),
                    'cas': sorted({c for m in con_dato for c in m['cas']}),
                    # Cuantos miembros aportan: si es 1 de 6, el dato
                    # representa menos a la familia que si son 6 de 6.
                    'miembros_con_dato': len(con_dato),
                    'miembros_totales': len(miembros),
                    # Si los miembros que aportan NO coinciden entre si, la
                    # herencia es dudosa y hay que mirarla.
                    'idas': sorted({x['ida'] for m in con_dato for x in m['datos']
                                    if x['ida'] is not None}),
                    'efectos': sorted({x['toxicidad'] for m in con_dato
                                       for x in m['datos'] if x['toxicidad']}),
                }
                con_herencia += 1
        elif fam['datos']:
            propios += 1

        salidas.append({
            '_id': num,
            'tag': fam['tag'],
            'nombre': fam['nombre'],
            'wikidata': fam['wikidata'],
            'cas_propio': fam['cas'],
            'oft_uuid_propio': fam['oft_uuid'],
            'miembros': miembros,
            'heredado': heredado,
            'revisar': ((['familia-sin-dato-ni-miembros']
                         if not fam['datos'] and not heredado else [])
                        + (['miembros-no-coinciden']
                           if heredado and (len(heredado['idas']) > 1
                                            or len(heredado['efectos']) > 1) else [])),
        })

    with open(salida, 'w', encoding='utf8') as f:
        for d in salidas:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    print(f'familias detectadas          : {len(salidas)}')
    print(f'   con dato propio           : {propios}')
    print(f'   que heredan de un miembro : {con_herencia}')
    print(f'   sin dato ni por herencia  : {len(salidas) - propios - con_herencia}')
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection familias --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:5])
