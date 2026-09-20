"""
Por que se retiro cada aditivo: lo dicen los considerandos del reglamento.

LA DISTINCION QUE IMPORTA. «Prohibido en alguna jurisdiccion» se adopto como
senal fuerte porque una prohibicion no se decreta sin expediente. Pero al
comprobarlo aditivo por aditivo resulta que no todas las retiradas dicen lo
mismo:

    E171  dioxido de titanio   EFSA evaluo y no pudo descartar genotoxicidad
    E203  sorbato calcico      faltaban datos y por eso no se pudo confirmar
    E311  galato de octilo     «no business operator committed to providing
    E312  galato de dodecilo    the requested toxicological data»

El tercero no dice nada sobre la sustancia: dice algo sobre el mercado. Un
aditivo que dejo de usarse y nadie quiso pagar su reevaluacion. Penalizarlo
como «prohibido por peligroso» seria inventar evidencia que no existe.

DOS MOTIVOS, no tres. Se empezo con tres -riesgo, seguridad no confirmable y
sin interes comercial- y al comprobarlo resultaron ser dos: los tres ultimos
casos son la MISMA situacion contada de dos maneras. En el reglamento del
sorbato calcico conviven «no business operator committed to providing the
requested genotoxicity data» y «the Authority was not able to confirm the
safety»: no son dos motivos, es causa y consecuencia.

    riesgo-identificado      se evaluo y aparecio un problema
    seguridad-no-confirmada  no aparecio ningun problema, pero tampoco se pudo
                             establecer que sea seguro

CUIDADO CON LAS PALABRAS DE PELIGRO: casi siempre hablan de datos que faltan,
no de hallazgos. Dos versiones anteriores se equivocaron por esto.

La primera cazaba «genotox» en cualquier contexto y daba cuatro señales de
riesgo para el sorbato calcico, cuando sus cuatro menciones eran «lack of
genotoxicity DATA», «genotoxicity studies need to be performed», «the requested
genotoxicity data» y «absence of appropriate genotoxicity data».

La segunda añadio un filtro de la palabra siguiente, y seguia fallando con los
esteres montanicos: «The available data on short-term and subchronic toxicity,
genotoxicity and chronic toxicity and carcinogenicity ... were limited». Ahi
«genotoxicity» no va seguida de «data» pero la frase entera habla de datos
limitados. Es una enumeracion de estudios que faltan.

NO SE PUEDE RESOLVER MIRANDO UNA PALABRA. Hace falta el contexto: si en la
ventana alrededor aparecen terminos de disponibilidad -«data», «limited»,
«submitted», «lack», «absence»- la mencion habla de lo que no se sabe, no de lo
que se encontro.

PERO EL FILTRO NO VALE PARA TODO. Aplicado a ciegas tumbaba tambien al dioxido
de titanio, cuyo reglamento dice «no longer be considered safe when used as a
food additive» y «concern for genotoxicity could not be ruled out». Esas son
frases inequivocas: afirman un veredicto, no describen una laguna, y su entorno
menciona datos como cualquier texto de EFSA.

Por eso hay DOS niveles. Las frases explicitas cuentan siempre; las palabras
sueltas solo cuando el contexto no habla de disponibilidad. Aun asi es una
heuristica sobre texto legal, no una extraccion estructurada: por eso se
guardan los recuentos, para revisar la clasificacion contra la fuente.

SE EXTRAE DEL TEXTO. Cada retirada la hizo un reglamento modificativo con su
propio CELEX, y sus considerandos explican el motivo. Cellar los sirve igual
que el consolidado. Probado sobre los tres casos conocidos, la separacion es
limpia: el de titanio da cuatro senales de riesgo y ninguna de falta de datos;
el de los galatos, al reves.

QUE REGLAMENTO retiro cada aditivo NO se puede deducir del consolidado, asi que
esa parte va a mano en `retiradas-ue.json`. Son pocas y el mapeo es estable;
la interpretacion, que es la parte delicada, si es automatica y comprobable.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone

UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)'

# Señales en los considerandos. Se cuentan las dos y decide cual pesa mas.
# Un hallazgo afirma algo sobre la sustancia. Se exige que la palabra de
# peligro NO vaya seguida de «data», «studies» o «information»: «genotoxicity
# data» habla de lo que falta, no de lo que se encontro.
# El `\b` es imprescindible: sin el, `genotox\w*` retrocede y casa
# «genotoxicit» dejando la «y» fuera, con lo que el filtro de abajo no ve
# «data» a continuacion y la exclusion no sirve de nada.
PELIGRO = r'(?:genotox\w*|carcinogen\w*|mutagen\w*)\b'
NO_ES_DATO = r'(?!\s+(?:data|studies|study|information|testing|tests))'

# Terminos que delatan que la frase habla de DISPONIBILIDAD de informacion.
CONTEXTO_DATOS = re.compile(
    r'\b(data|information|evidence|studies|study|limited|available|submitted'
    r'|provided|lack|absence|requested|missing|insufficient)\b', re.I)
VENTANA = 140

SENALES = {
    # Veredictos. Afirman algo sobre la sustancia y valen por si solos.
    'riesgo': re.compile(
        r'(no longer.{0,25}(?:be )?(?:considered )?safe'
        r'|(?:could|can)not be (?:ruled out|excluded)'
        r'|safety concern|concern for (?:the )?consumer'
        r'|concern.{0,30}could not be ruled out)', re.I),
    # Palabras de peligro sueltas. Solo cuentan si el contexto NO habla de
    # datos que faltan: casi siempre lo hace.
    'riesgo_palabra': re.compile(PELIGRO + NO_ES_DATO, re.I),
    'sin_datos': re.compile(
        r'(no (?:interested )?(?:business )?operator|not.{0,30}(?:submitted|provided)'
        r'.{0,30}data|lack of.{0,20}data|data (?:were|are) (?:not|in)'
        r'(?:sufficient|available)|absence of.{0,25}data'
        r'|not able to confirm the safety'
        r'|information.{0,60}(?:is |was |were )?not provided'
        r'|absence of.{0,40}(?:evidence|information)'
        r'|no longer be justified)', re.I),
    # Detalle que se conserva aunque no cambie el motivo: distingue «no existe
    # la informacion» de «nadie quiso pagarla».
    'nadie_aporto': re.compile(
        r'no (?:interested )?business operator.{0,60}(?:committed|provided)', re.I),
}


def descargar(celex, cache=None):
    ruta = f'{cache}/{celex}.xhtml' if cache else None
    if ruta:
        try:
            return open(ruta, encoding='utf8').read()
        except FileNotFoundError:
            pass
    req = urllib.request.Request(
        f'http://publications.europa.eu/resource/celex/{celex}',
        headers={'User-Agent': UA, 'Accept': 'application/xhtml+xml',
                 'Accept-Language': 'eng'})
    with urllib.request.urlopen(req, timeout=180) as r:
        html = r.read().decode('utf8', 'ignore')
    if ruta:
        open(ruta, 'w', encoding='utf8').write(html)
    return html


def motivo(texto):
    """
    Clasifica la retirada.

    La falta de datos manda sobre el hallazgo: si el reglamento dice que no se
    pudo confirmar la seguridad, eso describe el estado real aunque el texto
    mencione peligros por otras razones. Afirmar «se encontro un riesgo» cuando
    lo que hubo fue ausencia de estudios seria inventar evidencia.
    """
    n = {}
    for k, p in SENALES.items():
        if k != 'riesgo_palabra':
            n[k] = len(p.findall(texto))
            continue
        n[k] = sum(
            1 for m in p.finditer(texto)
            if not CONTEXTO_DATOS.search(
                texto[max(0, m.start() - VENTANA):m.end() + VENTANA])
        )
    # Un veredicto explicito manda sobre la falta de datos: el reglamento del
    # dioxido de titanio dice las dos cosas y lo que decidio la retirada fue lo
    # primero.
    if n['riesgo']:
        return 'riesgo-identificado', n
    if n['sin_datos']:
        return 'seguridad-no-confirmada', n
    if n['riesgo_palabra']:
        return 'riesgo-identificado', n
    return None, n


def main(mapa, salida, cache=None):
    entradas = json.load(open(mapa, encoding='utf8'))['retiradas']
    ahora = datetime.now(timezone.utc).isoformat()
    filas = []
    for e in entradas:
        if not e.get('celex'):
            filas.append({**e, 'motivo': None, 'senales': None,
                          'pendiente': 'falta identificar el reglamento'})
            print(f"   {e['numero_e']:<8} SIN REGLAMENTO IDENTIFICADO")
            continue
        html = descargar(e['celex'], cache)
        texto = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', html))
        m, n = motivo(texto)
        filas.append({
            '_id': e['numero_e'],
            'numero_e': e['numero_e'],
            'nombre': e.get('nombre'),
            'jurisdiccion': e.get('jurisdiccion', 'Union Europea'),
            'celex': e['celex'],
            'motivo': m,
            'senales': n,
            'fuente': {'consultado': ahora},
        })
        print(f"   {e['numero_e']:<8} {str(m):<26} "
              f"veredicto={n['riesgo']} palabra={n['riesgo_palabra']} "
              f"sin_datos={n['sin_datos']} nadie_aporto={n['nadie_aporto']}")

    with open(salida, 'w', encoding='utf8') as f:
        for d in filas:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')
    print(f'\nescrito {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:4])
