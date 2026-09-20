"""
Anade a la copia local de Wikidata los dos enlaces que Wikidata no tiene.

Wikidata ya resuelve la identidad quimica cruzada -numero E, CAS, CE, ECHA,
UNII, DSSTox, PubChem- y no tiene sentido reconstruir eso. Lo que le falta:

  - **Open Food Facts**: la propiedad P701 existe y esta VACIA (0 de 671
    items). El enlace va en sentido contrario: es Open Food Facts quien apunta
    a Wikidata, y solo en el 82% de sus aditivos.
  - **OpenFoodTox**: no existe propiedad. El enlace se hace por CAS, y ademas
    por el NUMERO E QUE ALGUNAS SUSTANCIAS LLEVAN EN EL NOMBRE.

Esa segunda via no es un adorno. EFSA emite dictamenes DE GRUPO, y el dato
cuelga de una sustancia que no es un compuesto y por tanto no tiene CAS:

    «Phosphoric acid-phosphates - di-, tri- and polyphosphates
     (E 338-341, E 343, E 450-452)»      IDA = 40

Cruzando solo por CAS esa sustancia era invisible, y con ella los fosfatos
enteros: 33 aditivos nuestros, el 8,5% de todas las apariciones. Los numeros E
van en el nombre y en forma de RANGO, igual que en el reglamento de Cellar.

Cada enlace anadido lleva `via`, que dice como se encontro, y la coleccion
gana un campo `revisar` con los motivos de sospecha. No se descarta nada
automaticamente: un enlace dudoso informa mas que un hueco.

Los motivos de revision salen de fallos reales ya vistos:

  - `numero-e-discrepa`: el item enlazado desde un tag de Open Food Facts
    declara otro numero E. Paso con los items de grupo -«pirofosfato» para
    E450- frente al compuesto concreto.
  - `nombres-no-casan`: el nombre en Open Food Facts y el de OpenFoodTox no se
    parecen. Es el unico control util contra un CAS equivocado en Wikidata:
    `Acido citrico / Citric acid` casa, y un cruce malo canta.
  - `varias-sustancias-por-cas`: un CAS llega a mas de una sustancia de
    OpenFoodTox y hay que elegir.
  - `sin-cas`: el item es de un grupo -«mono- y digliceridos»- y los grupos no
    tienen CAS. Sus miembros si.

Salida: JSONL para `mongoimport --mode=merge --upsertFields=_id`.

Datos: Open Food Facts (ODbL-1.0), EFSA OpenFoodTox (CC-BY-ND), Wikidata (CC0).
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

from extraer import Libro

# Numeros E dentro del nombre de una sustancia de OpenFoodTox, sueltos o en
# rango: `(E 338-341, E 343, E 450-452)`.
E_EN_NOMBRE = re.compile(r'\bE\s?(\d{3,4})\s*[-\u2013\u2014]\s*(\d{3,4})\b')
E_SUELTO = re.compile(r'\bE\s?(\d{3,4})(?!\s*[-\u2013\u2014]\s*\d)')


def numero_e(valor):
    if valor is None:
        return None
    s = str(valor).strip().upper().replace(' ', '')
    s = s[1:] if s.startswith('E') else s
    m = re.match(r'^(\d{3,4}[A-Z]*)$', s)
    return m.group(1).lower() if m else None


def norm(s):
    """Para comparar nombres entre fuentes, no para identificar."""
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode()
    s = re.sub(r'\(e\s*\d+[a-z]*\)', '', s.lower())
    s = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    return ' '.join(w[:-1] if len(w) > 3 and w.endswith('s') else w for w in s.split())


def parecidos(a, b):
    """
    Dos nombres de fuentes distintas hablan de lo mismo.

    SE COMPARA EN INGLES. OpenFoodTox solo nombra en ingles, y comparar contra
    el nombre en espanol de Open Food Facts daba 231 falsos positivos de 296:
    `Talco` / `Talc`, `Alginato de potasio` / `Potassium alginate` son la misma
    sustancia y no comparten ni una palabra.
    """
    na, nb = set(norm(a).split()), set(norm(b).split())
    if not na or not nb:
        return True          # sin nombre no se puede sospechar
    return bool(na & nb)


def main(ruta_items, ruta_off, ruta_oft, salida):
    off = json.loads(Path(ruta_off).read_text())

    # Open Food Facts -> Wikidata, y por numero E como respaldo.
    por_qid, por_numero = {}, {}
    for tag, v in off.items():
        e = numero_e((v.get('e_number') or {}).get('en'))
        limpia = lambda n: re.sub(r'^E\d+[a-z]*\s*[-–]\s*', '', n) if n else None
        nombre = limpia((v.get('name') or {}).get('es') or (v.get('name') or {}).get('en'))
        # El ingles se guarda aparte porque es con el que se compara contra
        # OpenFoodTox; el espanol es para mostrar.
        nombre_en = limpia((v.get('name') or {}).get('en'))
        entrada = {'tag': tag, 'e_number': e, 'nombre': nombre, 'nombre_en': nombre_en}
        q = (v.get('wikidata') or {}).get('en')
        if q:
            por_qid.setdefault(q, []).append(entrada)
        if e:
            por_numero.setdefault(e, []).append(entrada)

    # CAS -> sustancia de OpenFoodTox. REF_SUB lleva la identidad quimica;
    # SUB es a quien apuntan los valores de peligro.
    lib = Libro(ruta_oft)
    ref = {r['Document UUID']: r for r in lib.filas('REF_SUB') if r.get('Document UUID')}
    sub_de_ref, nombre_sub = {}, {}
    for s in lib.filas('SUB'):
        u, rs = s.get('Document UUID'), s.get('ReferenceSubstance.ReferenceSubstance')
        if u and rs:
            sub_de_ref.setdefault(rs, []).append(u)
            nombre_sub[u] = s.get('ChemicalName')
    # Sustancias cuyo NOMBRE declara los numeros E que cubre.
    por_numero_e_oft = {}
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
            por_numero_e_oft.setdefault(e, []).append(u)

    por_cas = {}
    for r in ref.values():
        c = (r.get('Inventory.CASNumber') or '').strip()
        if not c:
            continue
        for u in sub_de_ref.get(r['Document UUID'], []):
            por_cas.setdefault(c, []).append({
                'uuid': u, 'nombre': nombre_sub.get(u),
                'param_code': r.get('EFSA PARAM CODE'),
            })

    def valores(item, prop):
        return [c['mainsnak']['datavalue']['value']
                for c in item.get('claims', {}).get(prop, [])
                if c.get('mainsnak', {}).get('datavalue')]

    n_off = n_oft = 0
    with open(salida, 'w', encoding='utf8') as fo:
        for linea in open(ruta_items, encoding='utf8'):
            item = json.loads(linea)
            qid = item['_id']
            es = [numero_e(x) for x in valores(item, 'P628')]
            es = [e for e in es if e]
            cas = [str(x).strip() for x in valores(item, 'P231')]
            revisar = []

            # --- Open Food Facts ---
            enlaces_off = [{**e, 'via': 'wikidata'} for e in por_qid.get(qid, [])]
            vistos = {e['tag'] for e in enlaces_off}
            for e in es:
                for cand in por_numero.get(e, []):
                    if cand['tag'] not in vistos:
                        enlaces_off.append({**cand, 'via': 'numero-e'})
                        vistos.add(cand['tag'])
            # El item enlazado desde Open Food Facts declara otro numero E.
            for e in enlaces_off:
                if e['via'] == 'wikidata' and e['e_number'] and es and e['e_number'] not in es:
                    revisar.append('numero-e-discrepa')
                    break

            # --- OpenFoodTox ---
            enlaces_oft = []
            for c in cas:
                for s in por_cas.get(c, []):
                    enlaces_oft.append({**s, 'cas': c, 'via': 'cas'})
            # Dictamenes de grupo: la sustancia declara su rango de numeros E.
            vistos_oft = {s['uuid'] for s in enlaces_oft}
            for e in es:
                raiz = re.match(r'^(\d{3,4})', e)
                if not raiz:
                    continue
                for u in por_numero_e_oft.get(raiz.group(1), []):
                    if u in vistos_oft:
                        continue
                    enlaces_oft.append({'uuid': u, 'nombre': nombre_sub.get(u),
                                        'param_code': None, 'cas': None,
                                        'via': 'numero-e-en-nombre'})
                    vistos_oft.add(u)
            if len(enlaces_oft) > 1:
                revisar.append('varias-sustancias-por-cas')
            if not cas:
                revisar.append('sin-cas')

            # El unico control real contra un CAS equivocado.
            if enlaces_off and enlaces_oft:
                a = enlaces_off[0].get('nombre_en') or enlaces_off[0]['nombre']
                if not any(parecidos(a, s['nombre']) for s in enlaces_oft):
                    revisar.append('nombres-no-casan')

            if enlaces_off:
                n_off += 1
            if enlaces_oft:
                n_oft += 1
            fo.write(json.dumps({
                '_id': qid,
                'enlaces': {'off': enlaces_off, 'oft': enlaces_oft},
                'revisar': sorted(set(revisar)),
            }, ensure_ascii=False) + '\n')

    print(f'items procesados            : {sum(1 for _ in open(ruta_items, encoding="utf8"))}')
    print(f'   con enlace a Open Food Facts: {n_off}')
    print(f'   con enlace a OpenFoodTox    : {n_oft}')
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection wikidata --mode=merge --upsertFields=_id < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:5])
