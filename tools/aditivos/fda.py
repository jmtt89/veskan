"""
Estado legal en Estados Unidos: sustancias prohibidas en alimentos.

POR QUE HACE FALTA UNA SEGUNDA JURISDICCION. La regla acordada es «prohibido en
alguna jurisdiccion penaliza en todas», porque una prohibicion no se decreta
sin expediente detras. Pero con una sola fuente regulatoria esa regla se
convierte de hecho en «lo que diga Bruselas», y el efecto es asimetrico:

    E924b bromato potasico   prohibido en la UE, permitido en EE.UU.  -> se veia
    E952  ciclamato          permitido en la UE, prohibido en EE.UU.  -> NO se veia

El ciclamato lleva prohibido en Estados Unidos desde 1969 y es un edulcorante
legal en Europa. Sin esta fuente era invisible.

DE DONDE. El eCFR -el Codigo de Regulaciones Federales electronico- tiene API
publica y abierta. La parte 189 del titulo 21 es literalmente «Substances
Prohibited from Use in Human Food».

    https://www.ecfr.gov/api/versioner/v1/full/<fecha>/title-21.xml?part=189

CUIDADO: ese endpoint EXIGE compresion. Sin `Accept-Encoding` devuelve 406 con
el mensaje «This endpoint requires response compression», que es facil
confundir con un problema de permisos o de cabeceras.

LO QUE NO CUBRE, y va aparte en `manual-fda.json`: las revocaciones recientes
todavia no reflejadas en el texto. El FD&C Red No. 3 -eritrosina, E127- se
revoco el 15 de enero de 2025 por la clausula Delaney, tras evidencia de cancer
de tiroides en ratas, pero el CFR aun lo lista con una nota que apunta a la
enmienda porque el plazo de cumplimiento llega hasta enero de 2027. Son 5.904
apariciones en nuestro catalogo.

Regulacion federal de Estados Unidos: dominio publico.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone

API = 'https://www.ecfr.gov/api/versioner/v1'
UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)'
# Si bajan de esto, la estructura cambio y hay que mirarlo antes de usarlo.
MINIMO = 10


def pedir(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        # Obligatorio: el endpoint responde 406 sin esto.
        'Accept-Encoding': 'gzip, deflate',
    })
    import gzip
    import zlib
    with urllib.request.urlopen(req, timeout=180) as r:
        datos = r.read()
        cod = (r.headers.get('Content-Encoding') or '').lower()
    if cod == 'gzip':
        datos = gzip.decompress(datos)
    elif cod == 'deflate':
        datos = zlib.decompress(datos)
    return datos.decode('utf8', 'ignore')


def ultima_fecha():
    d = json.loads(pedir(f'{API}/titles.json'))
    t = next(x for x in d['titles'] if x['number'] == 21)
    return t.get('latest_issue_date')


def main(salida, cache=None):
    fecha = ultima_fecha()
    url = (f'{API}/full/{fecha}/title-21.xml'
           '?chapter=I&subchapter=B&part=189')
    if cache:
        try:
            xml = open(cache, encoding='utf8').read()
        except FileNotFoundError:
            xml = pedir(url)
            open(cache, 'w', encoding='utf8').write(xml)
    else:
        xml = pedir(url)

    # Los encabezados de seccion son `§ 189.NNN Nombre.`
    titulos = [re.sub(r'<[^>]+>', '', m.group(1))
               for m in re.finditer(r'<HEAD>(.*?)</HEAD>', xml, re.S)]
    ahora = datetime.now(timezone.utc).isoformat()
    filas = []
    for t in titulos:
        t = (t.replace('&#x2014;', '—').replace('&#xA7;', '§')
              .replace('&amp;', '&').strip())
        m = re.match(r'§\s*189\.(\d+)\s+(.+?)\.?$', t)
        if not m:
            continue
        seccion, nombre = m.group(1), m.group(2).strip()
        # 189.1 y 189.5 son disposiciones generales, no sustancias.
        if seccion in ('1', '5'):
            continue
        filas.append({
            '_id': f'21CFR189.{seccion}',
            'seccion': f'21 CFR 189.{seccion}',
            'nombre': nombre,
            'jurisdiccion': 'Estados Unidos',
            'prohibido': True,
            'fuente': {'titulo': 21, 'parte': 189, 'fecha': fecha,
                       'url': url, 'consultado': ahora},
        })

    if len(filas) < MINIMO:
        raise SystemExit(
            f'solo {len(filas)} sustancias prohibidas (se esperaban >= {MINIMO}): '
            'la estructura del eCFR ha cambiado, revisar antes de usar')

    with open(salida, 'w', encoding='utf8') as f:
        for d in filas:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    print(f'21 CFR 189, version {fecha}')
    print(f'   sustancias prohibidas en alimentos: {len(filas)}')
    for d in filas:
        print(f"      {d['seccion']:<16} {d['nombre'][:58]}")
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection fda --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
