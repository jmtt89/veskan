"""
Estados Unidos, segunda parte: colorantes cuya autorizacion se RETIRO.

EL AGUJERO QUE DESTAPO EL AMARANTO. `fda.py` lee la parte 189 del titulo 21,
«Substances Prohibited from Use in Human Food», y parecia bastar. No basta: los
colorantes no se prohiben ahi. Tienen su propio regimen -las Color Additive
Amendments de 1960- y su retirada se anota en la PARTE 81, que la parte 189 no
menciona.

    E123 amaranto = FD&C Red No. 2   retirado en 1976   invisible para nosotros

No era un caso aislado sino la forma del fallo. El E127 -eritrosina- ya habia
tenido que entrar a mano en `manual-fda.json`, y se justifico entonces diciendo
que el CFR «aun no lo refleja». Era verdad a medias: lo que no refleja la parte
189 es NINGUNA retirada de colorante, ni la de 2025 ni la de 1976. Un parche a
mano por cada una habria ido tapando los sintomas de una fuente que faltaba
entera.

QUE HAY EN LA PARTE 81. Tres secciones, 31 kB, misma API que ya usamos:

    § 81.1   colorantes en lista provisional
    § 81.10  TERMINACION de listados provisionales   <- lo que nos interesa
    § 81.30  cancelacion de certificados

La § 81.10 tiene la misma virtud que los considerandos de Cellar: nombra la
sustancia Y da el motivo con las palabras del regulador. No hay que interpretar
desde fuera.

    (c) FD&C Red No. 1    dano hepatico en rata, raton y perro
    (d) FD&C Red No. 4    vejiga y suprarrenales en perro
    (f) FD&C Red No. 2    «in order to protect the public health» y nada mas

SOLO CINCO AFECTAN A ALIMENTOS. De los veintiun parrafos, la mayoria son
`D&C` y `Ext. D&C`: farmacos y cosmetica. Un colorante de barra de labios no
tiene por que penalizar una galleta. La frase operativa -«terminates the
provisional listing of X for use in Y»- dice el alcance, asi que el filtro sale
del texto y no de una lista escrita aqui.

EL PARRAFO (u) ES UNA TRAMPA, y es la misma de siempre: confundir el conjunto
con el elemento. Dice que se retira el Red No. 3 para cosmetica y farmacos
externos, Y ADEMAS sus LACAS para alimentos. El colorante directo en alimentos
siguio permitido hasta 2025. Un filtro que busque «food» en el parrafo marca
alimentos y se equivoca de sustancia: la laca de un colorante es un compuesto
distinto. Por eso cada clausula se extrae por separado y las que hablan de
lacas se marcan, en vez de fundirse con el resto.

LO QUE ESTA SECCION NO PUEDE DAR. El parrafo del amaranto no aporta ni un dato
cientifico. El expediente esta en 41 FR 5823 (10 de febrero de 1976), que no es
CFR y no se sirve por esta API. Aqui se registra `no-consta-en-el-cfr` y la
referencia; inventar un motivo para rellenar el hueco seria justo lo que
`motivos.py` lleva tres intentos evitando.

Regulacion federal de Estados Unidos: dominio publico.
"""
import gzip
import json
import re
import sys
import urllib.request
import zlib
from datetime import datetime, timezone

API = 'https://www.ecfr.gov/api/versioner/v1'
UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)'
# Si bajan de esto, la estructura cambio y hay que mirarlo antes de usarlo.
MINIMO_PARRAFOS = 15
MINIMO_ALIMENTOS = 4

# Motivos, con el vocabulario de ESTE texto. No se reutilizan los de
# `motivos.py` porque estan afinados al lenguaje de los reglamentos europeos y
# aqui no casan: la UE escribe «no longer be considered safe», el CFR escribe
# «causes cancer in rats». Forzar unas expresiones sobre el otro texto daria
# silencios, que es el fallo mas caro de todos.
SENALES = {
    # Un hallazgo: afirma algo que se observo en la sustancia.
    'riesgo': re.compile(
        r'(causes cancer'
        r'|demonstrated it to be toxic'
        r'|toxic upon ingestion'
        r'|would be unsafe'
        r'|known carcinogen'
        r'|adverse effects were found'
        r'|liver damage'
        r'|no longer be a presumption of safety)', re.I),
    # No se encontro nada; tampoco se pudo demostrar que sea seguro. Bajo las
    # Color Additive Amendments la carga de la prueba es del solicitante, asi
    # que esto basta para retirar.
    'sin_datos': re.compile(
        r'(no scientific evidence that will support a safe tolerance'
        r'|available data do not permit the establishment of a safe level'
        r'|insufficient data'
        r'|inadequate analytical methods'
        r'|unresolved questions'
        r'|cannot be produced with any (?:reasonable )?assurance'
        r'|no method of analysis has been suggested)', re.I),
    # Puramente procedimental: nadie pidio mantenerlo. No dice NADA sobre la
    # sustancia. Ninguno de estos afecta a alimentos, pero se distingue igual
    # para no contarlo como evidencia de dano.
    'sin_peticion': re.compile(
        r'(in the absen[cs]e of a petition'
        r'|petition for th[eo]se color additives was withdrawn'
        r'|no longer exists a basis for (?:their |its )?(?:continued )?provisional'
        r'|failure to comply with the conditions)', re.I),
}

# «... the provisional listing of X for use in Y». Es la frase operativa y de
# ella sale el alcance.
#
# UN VERBO PUEDE ARRASTRAR VARIAS CLAUSULAS. El parrafo (u) dice «terminates
# the provisional listing of FD&C Red No. 3 for use in cosmetics ... AND the
# provisional listing of the LAKES of FD&C Red No. 3 for use in food». Un solo
# «terminates», dos retiradas, sustancias distintas. Atar la expresion al verbo
# solo encuentra la primera y deja la de alimentos sin ver.
#
# Por eso se buscan las clausulas DENTRO de la ventana que abre cada verbo, en
# vez de exigir que cada una lo lleve pegado. El limite de la clausula incluye
# «and the provisional listing», que es donde empieza la siguiente: sin el, la
# captura se comia el inicio de la de al lado.
VERBO = re.compile(r'terminat\w*', re.I)
VENTANA_CLAUSULA = 400
CLAUSULA = re.compile(
    r'provisional\s+listings?\s+of\s+(.{0,160}?)\s+for\s+use\s+in\s+'
    r'(.{0,160}?)(?=,\s*effective|\.|;'
    r'|\s+and\s+the\s+provisional\s+listing|$)', re.I | re.S)


def pedir(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        # Obligatorio: el endpoint responde 406 sin esto.
        'Accept-Encoding': 'gzip, deflate',
    })
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
    return next(x for x in d['titles'] if x['number'] == 21)['latest_issue_date']


def limpiar(s):
    s = re.sub(r'<[^>]+>', ' ', s)
    s = (s.replace('&#xA7;', '§').replace('&amp;', '&')
          .replace('&#x2014;', '—').replace('&#x201C;', '"')
          .replace('&#x201D;', '"').replace('&#x3B2;', 'beta-'))
    s = re.sub(r'&#x([0-9A-Fa-f]+);', lambda m: chr(int(m.group(1), 16)), s)
    return re.sub(r'\s+', ' ', s).strip()


def seccion(xml, numero):
    """El trozo de XML de una seccion, de su encabezado al siguiente."""
    marca = f'§ 81.{numero}'
    cabeceras = [(m.start(), limpiar(m.group(1)))
                 for m in re.finditer(r'<HEAD>(.*?)</HEAD>', xml, re.S)]
    for i, (pos, texto) in enumerate(cabeceras):
        if texto.startswith(marca):
            fin = cabeceras[i + 1][0] if i + 1 < len(cabeceras) else len(xml)
            return xml[pos:fin]
    raise SystemExit(f'no aparece {marca}: la parte 81 ha cambiado de forma')


def parrafos(frag):
    """
    Los parrafos con letra de § 81.10, cada uno con su nombre en cursiva.

    Los subparrafos van numerados -(1), (2)- asi que no compiten con las
    letras; pero existe `(q)(1)`, de modo que el numero opcional se consume
    para que la letra se lea bien.
    """
    puntos = [(m.start(), m.group(1), limpiar(m.group(2)).rstrip('.'))
              for m in re.finditer(
                  r'<P>\(([a-z])\)(?:\(\d+\))?\s*<I>(.*?)</I>', frag, re.S)]
    for i, (pos, letra, nombre) in enumerate(puntos):
        fin = puntos[i + 1][0] if i + 1 < len(puntos) else len(frag)
        yield letra, nombre, limpiar(frag[pos:fin])


def alcance(texto):
    """
    Que usos se retiraron, clausula a clausula.

    Devuelve una lista porque un parrafo puede retirar cosas distintas para
    usos distintos -el (u) lo hace- y fundirlas atribuiria a la sustancia una
    retirada que fue de sus lacas.
    """
    out, vistos = [], set()
    for v in VERBO.finditer(texto):
        for m in CLAUSULA.finditer(texto[v.end():v.end() + VENTANA_CLAUSULA]):
            sustancia, usos = limpiar(m.group(1)), limpiar(m.group(2))
            clave = (sustancia.lower(), usos.lower())
            if clave in vistos:
                continue
            vistos.add(clave)
            out.append({
                'sustancia': sustancia,
                'usos': usos,
                'alimentos': bool(re.search(r'\bfoods?\b', usos, re.I)),
                'es_laca': bool(re.search(r'\blakes?\b', sustancia, re.I)),
            })
    return out


def motivo(texto):
    n = {k: len(p.findall(texto)) for k, p in SENALES.items()}
    # Un hallazgo manda sobre la falta de datos, igual que en `motivos.py`: el
    # Red No. 1 dice las dos cosas y lo que decidio la retirada fue lo primero.
    if n['riesgo']:
        return 'riesgo-identificado', n
    if n['sin_datos']:
        return 'seguridad-no-confirmada', n
    if n['sin_peticion']:
        return 'sin-peticion', n
    # El amaranto cae aqui: «to protect the public health» y ni un dato.
    return 'no-consta-en-el-cfr', n


def main(salida, cache=None):
    fecha = ultima_fecha()
    url = (f'{API}/full/{fecha}/title-21.xml'
           '?chapter=I&subchapter=A&part=81')
    if cache:
        try:
            xml = open(cache, encoding='utf8').read()
        except FileNotFoundError:
            xml = pedir(url)
            open(cache, 'w', encoding='utf8').write(xml)
    else:
        xml = pedir(url)

    frag = seccion(xml, 10)
    ahora = datetime.now(timezone.utc).isoformat()
    filas = []
    for letra, nombre, texto in parrafos(frag):
        clausulas = alcance(texto)
        m, n = motivo(texto)
        # Alimentos solo si alguna clausula lo dice Y no es la de las lacas.
        directo = [c for c in clausulas if c['alimentos'] and not c['es_laca']]
        lacas = [c for c in clausulas if c['alimentos'] and c['es_laca']]
        revisar = []
        if lacas and not directo:
            revisar.append(
                'la retirada en alimentos es de las LACAS, no del colorante '
                'directo: comprobar a que sustancia corresponde')
        if not clausulas:
            revisar.append('no se encontro la clausula «terminates the '
                           'provisional listing of ... for use in ...»')
        filas.append({
            '_id': f'21CFR81.10({letra})',
            'seccion': f'21 CFR 81.10({letra})',
            'nombre': nombre,
            'jurisdiccion': 'Estados Unidos',
            'retirado': True,
            'alimentos': bool(directo),
            'clausulas': clausulas,
            'motivo': m,
            'senales': n,
            'revisar': revisar,
            'fuente': {'titulo': 21, 'parte': 81, 'seccion': '81.10',
                       'fecha': fecha, 'url': url, 'consultado': ahora},
        })

    enAlimentos = [f for f in filas if f['alimentos']]
    if len(filas) < MINIMO_PARRAFOS or len(enAlimentos) < MINIMO_ALIMENTOS:
        raise SystemExit(
            f'solo {len(filas)} parrafos y {len(enAlimentos)} en alimentos '
            f'(se esperaban >= {MINIMO_PARRAFOS} y >= {MINIMO_ALIMENTOS}): '
            'la estructura de la parte 81 ha cambiado, revisar antes de usar')

    with open(salida, 'w', encoding='utf8') as f:
        for d in filas:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    print(f'21 CFR 81.10, version {fecha}')
    print(f'   listados provisionales terminados: {len(filas)}'
          f'   de ellos en alimentos: {len(enAlimentos)}\n')
    for d in filas:
        marca = 'ALIMENTOS' if d['alimentos'] else '         '
        print(f"   {d['seccion']:<18} {marca} {d['nombre'][:38]:<38} "
              f"{d['motivo']}")
        for r in d['revisar']:
            print(f"        revisar: {r}")
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection cfr81 --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
