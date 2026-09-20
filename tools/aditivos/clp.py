"""
Clasificacion armonizada de peligro de la UE: Anexo VI del Reglamento CLP.

QUE APORTA. Es la clasificacion oficial europea de cancerigenos, mutagenos y
toxicos para la reproduccion -`Carc.`, `Muta.`, `Repr.`-, que es exactamente
nuestro nivel 1 y nivel 2 de gravedad, dicha por un regulador y con numero CAS
para cruzar.

POR QUE HACE FALTA ADEMAS DE IARC. IARC solo alcanza a 26 de nuestros aditivos,
y 173 de sus entradas no tienen CAS -clasifica exposiciones, no sustancias- asi
que no se pueden cruzar. El Anexo VI trae 6.827 CAS distintos. Son fuentes
INDEPENDIENTES sobre lo mismo: que coincidan refuerza, que discrepen obliga a
mirar.

DE DONDE SE SACA, y no es de donde parece. El portal de ECHA devuelve 403 a
nuestras peticiones. Pero el Anexo VI es LEGISLACION -Reglamento (CE)
1272/2008- y esta en Cellar, la misma API de la Oficina de Publicaciones que ya
usamos para el reglamento de aditivos. Sin claves, sin scraping y sin licencia
que negociar (Decision 2011/833/UE).

La EPA (CompTox/DSSTox) quedo descartada: su API exige clave, y una credencial
es algo que gestionar en un proceso que queremos reproducible.

LAS CLASES QUE IMPORTAN aqui, de las muchas que trae el anexo:

    Carc. 1A   cancerigeno conocido en humanos
    Carc. 1B   cancerigeno presunto
    Carc. 2    sospechoso
    Muta. 1A/1B/2   mutagenico en celulas germinales
    Repr. 1A/1B/2   toxico para la reproduccion

Se ignoran las de inflamabilidad, corrosion o toxicidad acuatica: no dicen nada
sobre comer el producto.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone

CELEX = '02008R1272-20260701'
URL = f'http://publications.europa.eu/resource/celex/{CELEX}'
UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)'
# Si la tabla trae menos, la estructura cambio y hay que mirarlo.
MINIMO_FILAS = 3000

CAS = re.compile(r'\b(\d{2,7}-\d{2}-\d)\b')
# `Carc. 1A`, `Muta. 1B`, `Repr. 2`
CLASE = re.compile(r'\b(Carc|Muta|Repr)\.\s*(1A|1B|2)\b')

SIGNIFICADO = {
    'Carc': 'cancerigeno',
    'Muta': 'mutagenico en celulas germinales',
    'Repr': 'toxico para la reproduccion',
}
CATEGORIA = {
    '1A': 'conocido en humanos',
    '1B': 'presunto',
    '2': 'sospechoso',
}


def texto(html):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', html)).strip()


def descargar(cache=None):
    if cache:
        try:
            return open(cache, encoding='utf8').read()
        except FileNotFoundError:
            pass
    req = urllib.request.Request(URL, headers={
        'User-Agent': UA,
        'Accept': 'application/xhtml+xml',
        'Accept-Language': 'eng',
    })
    with urllib.request.urlopen(req, timeout=300) as r:
        html = r.read().decode('utf8', 'ignore')
    if cache:
        open(cache, 'w', encoding='utf8').write(html)
    return html


def main(salida, cache=None):
    html = descargar(cache)

    # La tabla del Anexo VI es la unica con cientos de numeros CAS.
    tablas = re.findall(r'<table[^>]*>(.*?)</table>', html, re.S)
    candidatas = [t for t in tablas if len(CAS.findall(texto(t))) > 200]
    if not candidatas:
        raise SystemExit('no se encontro la tabla del Anexo VI: revisar la estructura')
    tabla = max(candidatas, key=lambda t: len(CAS.findall(texto(t))))

    filas = re.findall(r'<tr[^>]*>(.*?)</tr>', tabla, re.S)
    if len(filas) < MINIMO_FILAS:
        raise SystemExit(
            f'la tabla trae {len(filas)} filas (se esperaban >= {MINIMO_FILAS}): '
            'la estructura ha cambiado, revisar antes de usar')

    ahora = datetime.now(timezone.utc).isoformat()
    salidas, vistos = [], set()
    for f in filas:
        celdas = [texto(c) for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', f, re.S)]
        if len(celdas) < 5:
            continue                      # cabeceras y marcas de enmienda
        # El CAS esta en su columna, pero el numero de columnas varia entre
        # enmiendas; se busca la primera celda que sea SOLO un CAS.
        cas = next((c for c in celdas[:5] if CAS.fullmatch(c.strip())), None)
        if not cas:
            continue
        clases = CLASE.findall(' '.join(celdas))
        if not clases:
            continue                      # peligro fisico o ambiental, no nos toca
        cas = cas.strip()
        if cas in vistos:
            continue
        vistos.add(cas)
        nombre = next((c for c in celdas[:3] if not CAS.fullmatch(c.strip())
                       and len(c) > 3 and not re.fullmatch(r'[\d-]+', c.strip())), None)
        salidas.append({
            '_id': cas,
            'cas': cas,
            'nombre': nombre,
            'clases': [{'tipo': t, 'categoria': c,
                        'significado': SIGNIFICADO[t],
                        'grado': CATEGORIA[c],
                        'codigo': f'{t}. {c}'} for t, c in sorted(set(clases))],
            # La mas severa, para ordenar sin recorrer la lista.
            'peor': sorted(set(clases), key=lambda x: ('1A', '1B', '2').index(x[1]))[0][1],
            'cancerigeno': any(t == 'Carc' for t, _ in clases),
            'mutagenico': any(t == 'Muta' for t, _ in clases),
            'repro': any(t == 'Repr' for t, _ in clases),
            'fuente': {'celex': CELEX, 'url': URL, 'consultado': ahora},
        })

    with open(salida, 'w', encoding='utf8') as fo:
        for d in salidas:
            fo.write(json.dumps(d, ensure_ascii=False) + '\n')

    print(f'CELEX {CELEX}')
    print(f'   filas en la tabla del Anexo VI : {len(filas)}')
    print(f'   con CAS y clase CMR            : {len(salidas)}')
    print(f'      cancerigenos  : {sum(1 for d in salidas if d["cancerigeno"])}')
    print(f'      mutagenicos   : {sum(1 for d in salidas if d["mutagenico"])}')
    print(f'      repro-toxicos : {sum(1 for d in salidas if d["repro"])}')
    for g in ('1A', '1B', '2'):
        print(f'      peor grado {g:<3}: {sum(1 for d in salidas if d["peor"] == g)}')
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection clp --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
