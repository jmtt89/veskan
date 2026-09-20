"""
Estado legal de cada aditivo segun el Reglamento (CE) 1333/2008.

Se descarga el texto consolidado de la API Cellar de la Oficina de
Publicaciones de la UE. Es legislacion: reutilizable sin restriccion
(Decision 2011/833/UE), y el identificador CELEX lleva la fecha de la version
consolidada, asi que detectar una actualizacion es comparar una cadena.

LA TRAMPA, y es la razon de que este fichero exista en vez de un `grep`:
aparecer en el reglamento NO significa estar autorizado. El dioxido de titanio
(E171) sigue listado, con una nota al pie que dice

    «El dioxido de titanio no esta autorizado en las categorias de alimentos
     que figuran en las partes D y E. Esta sustancia figura en la lista B1
     porque se utiliza en medicamentos [...]»

Un extractor que pregunte «esta el numero E en el texto?» lo daria por
autorizado, que es el peor error posible: prohibido desde agosto de 2022.

LA ESTRUCTURA del Anexo II:

    PARTE B   lista de TODOS los aditivos          incluye los retirados
    PARTE C   definiciones de GRUPOS               Grupo I, II, III, IV
    PARTE D   categorias de alimentos
    PARTE E   autorizados y condiciones de uso     la autorizacion real

Un aditivo esta autorizado si aparece en la parte E -nombrado- o en la parte C
-como miembro de un grupo-. La parte E cita «Grupo I» 211 veces en vez de
enumerar sus miembros, asi que mirar solo la E da falsos negativos: el
glutamato monosodico, los guanilatos y los inosinatos salian «no autorizados».

Comprobado: E621, E627, E631, E282 y E132 estan en la parte C; E171 no esta en
ninguna de las dos.

RETIRADAS ENTRE VERSIONES. Comparar la parte B con la E encuentra lo que sigue
listado pero ya no se autoriza. No encuentra lo que desaparecio del reglamento
ENTERO, y eso tambien es una retirada activa: el sorbato calcico (E203) y los
galatos de octilo y dodecilo (E311, E312) estaban autorizados en 2012 y no
figuran en 2026.

Cellar publica 67 versiones consolidadas, asi que la comparacion es directa.

PERO DESAPARECER NO SIEMPRE ES RETIRARSE. Los glucosidos de esteviol (E960)
tambien desaparecen entre 2012 y 2026, y no se prohibieron: se desglosaron en
E960a, E960b, E960c y E960d. Son 5.389 apariciones en el catalogo y marcarlas
como prohibidas habria sido un error grave. Por eso, antes de dar una
desaparicion por retirada, se comprueba que el numero no siga vivo con sufijos.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone

CELEX = '02008R1333-20260218'
URL = f'http://publications.europa.eu/resource/celex/{CELEX}'
UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)'

# `E 171`, `E171`, `E 160b`, `E 160b(i)`
NUMERO = re.compile(r'\bE\s?(\d{3,4}[a-z]*(?:\([ivx]+\))?)\b')
# `E 535-538`, `E 338-452`: el reglamento abrevia grupos con rangos, y el
# ferrocianuro potasico (E536) esta autorizado SOLO asi. Sin expandirlos salia
# como no autorizado, que es el error peligroso.
RANGO = re.compile(r'\bE\s?(\d{3,4})\s?[-–—]\s?(\d{3,4})\b')


def descargar():
    req = urllib.request.Request(URL, headers={
        'User-Agent': UA,
        'Accept': 'application/xhtml+xml',
        'Accept-Language': 'spa',
    })
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read().decode('utf8', 'ignore')


def texto_plano(html):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', html))


def partes(plano):
    """Corta el Anexo II en sus partes. El orden en el texto es el del anexo."""
    marcas = {}
    for p in ('PARTE A', 'PARTE B', 'PARTE C', 'PARTE D', 'PARTE E'):
        i = plano.find(p)
        if i < 0:
            raise SystemExit(f'no se encontro «{p}»: ha cambiado la estructura')
        marcas[p] = i
    orden = sorted(marcas.items(), key=lambda x: x[1])
    fuera = {}
    for i, (nombre, ini) in enumerate(orden):
        fin = orden[i + 1][1] if i + 1 < len(orden) else len(plano)
        fuera[nombre] = plano[ini:fin]
    return fuera


def numeros(fragmento):
    return {m.group(1).lower() for m in NUMERO.finditer(fragmento)}


def rangos(fragmento, universo):
    """
    Expande `E 535-538` a sus miembros, limitado a los que el reglamento
    LISTA de verdad. Expandir a ciegas daria por autorizado cualquier numero
    intermedio, existiera o no como aditivo.
    """
    fuera = set()
    for m in RANGO.finditer(fragmento):
        a, b = int(m.group(1)), int(m.group(2))
        if not 0 < b - a < 200:
            continue
        for e in universo:
            base = re.match(r'^(\d{3,4})', e)
            if base and a <= int(base.group(1)) <= b:
                fuera.add(e)
    return fuera


def retiradas(plano_viejo, plano_nuevo):
    """
    Numeros E autorizados en una version anterior y ausentes de la actual.

    Comparar la parte B con la E encuentra lo que sigue listado y ya no se
    autoriza; no encuentra lo que desaparecio del reglamento ENTERO, y eso
    tambien es retirada activa: el sorbato calcico (E203) y los galatos de
    octilo y dodecilo (E311, E312) estaban autorizados en 2012 y no figuran en
    2026.

    PERO DESAPARECER NO SIEMPRE ES RETIRARSE. Los glucosidos de esteviol (E960)
    tambien desaparecen, y no se prohibieron: se desglosaron en E960a, E960b,
    E960c y E960d. Son 5.389 apariciones en el catalogo, y marcarlas como
    prohibidas habria sido un error grave. Por eso se descarta lo que sigue
    vivo con sufijos.
    """
    pv, pn = partes(plano_viejo), partes(plano_nuevo)
    lv, ln = numeros(pv['PARTE B']), numeros(pn['PARTE B'])
    av = (numeros(pv['PARTE C']) | numeros(pv['PARTE E'])
          | rangos(pv['PARTE C'], lv) | rangos(pv['PARTE E'], lv))
    an = (numeros(pn['PARTE C']) | numeros(pn['PARTE E'])
          | rangos(pn['PARTE C'], ln) | rangos(pn['PARTE E'], ln))
    fuera = set()
    for e in av - an:
        m = re.fullmatch(r'(\d{3,4})([a-z]*)', e)
        # Los numeros E van de 100 a ~1599. `E6436` salia del texto de 2012 y
        # no es un aditivo: es un numero cualquiera precedido de una E.
        if not m or not 100 <= int(m.group(1)) <= 1599:
            continue
        if any(o != e and o.startswith(e) for o in an):
            continue                       # renumeracion, no retirada
        fuera.add(e)
    return fuera


def main(salida, cache=None, cache_viejo=None,
         celex_viejo='02008R1333-20120524'):
    if cache:
        try:
            html = open(cache, encoding='utf8').read()
        except FileNotFoundError:
            html = descargar()
            open(cache, 'w', encoding='utf8').write(html)
    else:
        html = descargar()

    plano = texto_plano(html)
    p = partes(plano)
    listados = numeros(p['PARTE B'])
    en_grupos = numeros(p['PARTE C']) | rangos(p['PARTE C'], listados)
    autorizados_e = numeros(p['PARTE E']) | rangos(p['PARTE E'], listados)
    autorizados = en_grupos | autorizados_e

    # Nombre tal como lo escribe el reglamento, de la tabla de la parte B.
    nombres = {}
    for m in re.finditer(
            r'\bE\s?(\d{3,4}[a-z]*)\s+([A-ZÁÉÍÓÚÑ][^E]{2,44}?)(?=\s+E\s?\d|\s*$)',
            p['PARTE B']):
        nombres.setdefault(m.group(1).lower(), m.group(2).strip(' .▼'))

    # Retiradas comprobadas contra una version anterior.
    salieron = set()
    if cache_viejo:
        try:
            viejo = texto_plano(open(cache_viejo, encoding='utf8').read())
            salieron = retiradas(viejo, plano)
        except (FileNotFoundError, SystemExit):
            pass

    ahora = datetime.now(timezone.utc).isoformat()
    filas = []
    for e in sorted(listados | autorizados | salieron):
        esta = e in autorizados and e not in salieron
        filas.append({
            '_id': e,
            'numero_e': e,
            'nombre_reglamento': nombres.get(e),
            'autorizado': esta,
            # De donde sale la autorizacion: nombrado en la parte E, o miembro
            # de un grupo en la C. Sin esto no se puede auditar el veredicto.
            'via': ('parte-e' if e in autorizados_e else
                    'grupo-parte-c' if e in en_grupos else None),
            'listado_parte_b': e in listados,
            # Estaba autorizado en una version anterior y ya no. Es una
            # retirada activa aunque ya ni figure en el reglamento.
            'retirado': e in salieron,
            'referencia_anterior': celex_viejo if e in salieron else None,
            'fuente': {'celex': CELEX, 'url': URL, 'consultado': ahora},
        })

    with open(salida, 'w', encoding='utf8') as f:
        for d in filas:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    no = [d for d in filas if not d['autorizado']]
    print(f'CELEX {CELEX}')
    print(f'   listados en la parte B      : {len(listados)}')
    print(f'   nombrados en la parte E     : {len(autorizados_e)}')
    print(f'   en grupos de la parte C     : {len(en_grupos)}')
    print(f'   AUTORIZADOS (union C u E)   : {len(autorizados)}')
    print(f'   listados pero NO autorizados: {len(no)}')
    if salieron:
        print(f'   RETIRADOS desde {celex_viejo}: {len(salieron)}')
        for e in sorted(salieron):
            print(f'      E{e}')
    for d in no:
        print(f"      E{d['numero_e']:<8} {d['nombre_reglamento'] or ''}")
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection cellar --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:5])
