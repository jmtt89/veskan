"""
Clasificacion de cancerigenos de IARC (Monografias de la OMS).

POR QUE HACE FALTA ESTA FUENTE. Es la unica por la que el cancer puede entrar
en el modelo. Comprobado: en las doce etiquetas de efecto critico de
OpenFoodTox, sobre los 46 aditivos con dato legible, NO APARECE NI UNA
relacionada con cancer o genotoxicidad. Y es estructural: a un carcinogeno
genotoxico no se le asigna IDA -no se le supone dosis segura-, asi que nunca
tendra «efecto critico». Sin IARC no podriamos mostrar riesgo de cancer de
ningun aditivo, jamas.

El caso que lo destapo: el nitrito sodico. Su efecto critico en OpenFoodTox es
«aumento de metahemoglobina», y IARC lo clasifica 2A por nitrosacion endogena.
Una ficha construida solo sobre el endpoint critico seria tecnicamente correcta
y engañosa en lo que importa.

DE DONDE SE SACA. No hay API publica -se probaron siete rutas, todas 404- y la
pagina de clasificaciones no trae ni una fila en el HTML: la tabla la monta
JavaScript. Pero los datos estan INCRUSTADOS en el bundle de esa aplicacion,
`webapi.iarc.who.int/loc/loc.app.js`, como objetos con nombre, grupo, CAS,
volumen y año.

Se descarto el PDF `ClassificationsAlphaOrder.pdf`: es de 2018 (volumenes
1-123, cuando van por 142) y habria que extraer texto maquetado.

CUIDADO CON EL FORMATO. Los registros NO tienen todos los mismos campos:

  - Las referencias cruzadas no llevan grupo:
    `{name:"1,4-Butanediol dimethanesulfonate (see Busulfan)",cas:[...]}`
  - Los agentes biologicos no llevan CAS:
    `{name:"<i>Aloe vera</i>, whole leaf extract",group:"2B",volume:[...]}`

Una expresion regular con el orden fijo de campos perdia 331 de 1.128 registros
EN SILENCIO. Por eso aqui se parsea equilibrando llaves y los campos son todos
opcionales.

LIMITE CONOCIDO. IARC clasifica a veces una EXPOSICION, no una sustancia:
«Ingested nitrate or nitrite under conditions that result in endogenous
nitrosation». Esas entradas no tienen CAS y no se pueden cruzar
automaticamente; se resuelven a mano y quedan anotadas.

Es el bundle de una aplicacion web, no un fichero de datos publicado. Puede
cambiar de forma sin aviso, asi que si el patron deja de encajar esto ABORTA en
vez de devolver una lista corta.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone

URL = 'https://webapi.iarc.who.int/loc/loc.app.js'
UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)'
# Si el bundle cambia y quedan menos, algo se rompio y hay que mirarlo.
MINIMO = 1000

GRUPOS = {
    '1': 'cancerigeno para humanos',
    '2A': 'probablemente cancerigeno',
    '2B': 'posiblemente cancerigeno',
    '3': 'no clasificable',
}


def objetos(js):
    """
    Extrae los objetos `{name:"...",...}` equilibrando llaves.

    No vale una expresion regular con el orden de campos fijo: los registros
    tienen campos opcionales y se pierden sin avisar.
    """
    for m in re.finditer(r'\{name:"', js):
        i = m.start()
        nivel, j, en_cadena, escape = 0, i, False, False
        while j < len(js):
            c = js[j]
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == '"':
                en_cadena = not en_cadena
            elif not en_cadena:
                if c == '{':
                    nivel += 1
                elif c == '}':
                    nivel -= 1
                    if nivel == 0:
                        yield js[i:j + 1]
                        break
            j += 1


def a_json(fragmento):
    """
    Notacion de objeto JS -> JSON.

    Dos diferencias con JSON, y la segunda costo una clasificacion:

    1. Las claves van sin comillas.
    2. Los valores pueden ir entre COMILLAS SIMPLES, que JSON no admite. IARC
       las usa cuando el texto lleva comillas dobles dentro:

           comment:'The term "Talc" includes "Talc containing asbestiform..."'

       La primera version solo arreglaba las claves, asi que estos registros
       no convertian y se descartaban EN SILENCIO: 20 objetos de 1.128, de los
       cuales 11 traian grupo y CAS. Entre ellos el talco, que la IARC
       clasifico 2A en 2024 y es el aditivo E553b.

    Las comillas dobles de dentro se escapan antes de cambiar las de fuera; al
    reves, el resultado seria JSON invalido de otra manera.
    """
    def comilla_simple(m):
        return '"' + m.group(1).replace('\\', '\\\\').replace('"', '\\"') + '"'

    s = re.sub(r'([{,])\s*([A-Za-z_]\w*)\s*:', r'\1"\2":', fragmento)
    # Solo los valores: van detras de `":`, nunca al principio del objeto.
    s = re.sub(r"(?<=:)'((?:[^'\\]|\\.)*)'", comilla_simple, s)
    # `!0` y `!1` son el true y el false del JavaScript minificado. Los usa
    # `in_prep`, que marca una monografia ANUNCIADA pero aun sin publicar: son
    # 9 clasificaciones, y descartarlas en silencio ocultaba que existen.
    s = re.sub(r'(?<=:)!0\b', 'true', s)
    s = re.sub(r'(?<=:)!1\b', 'false', s)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return None


def limpiar(nombre):
    """Los nombres llevan cursivas HTML: `<i>Aloe vera</i>`."""
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', nombre)).strip()


def main(salida, cache=None):
    if cache:
        try:
            js = open(cache, encoding='utf8').read()
        except FileNotFoundError:
            req = urllib.request.Request(URL, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                js = r.read().decode('utf8', 'ignore')
            open(cache, 'w', encoding='utf8').write(js)
    else:
        req = urllib.request.Request(URL, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            js = r.read().decode('utf8', 'ignore')

    candidatos = list(objetos(js))
    ahora = datetime.now(timezone.utc).isoformat()
    filas, sin_grupo, sin_cas = [], 0, 0
    for frag in candidatos:
        d = a_json(frag)
        if not d or 'name' not in d:
            continue
        grupo = d.get('group')
        if not grupo:
            # Referencia cruzada del indice, no una clasificacion.
            sin_grupo += 1
            continue
        cas = [str(c).strip() for c in (d.get('cas') or []) if str(c).strip()]
        if not cas:
            sin_cas += 1
        filas.append({
            '_id': f"{grupo}:{limpiar(d['name'])[:90]}",
            'nombre': limpiar(d['name']),
            'grupo': grupo,
            'significado': GRUPOS.get(grupo),
            'cas': cas,
            # Sin CAS no hay cruce automatico: son exposiciones o agentes
            # biologicos, y se resuelven a mano.
            'cruzable': bool(cas),
            'volumen': [str(v) for v in (d.get('volume') or [])],
            'anio': d.get('year'),
            'anio_evaluacion': d.get('yeareval'),
            # La monografia esta anunciada pero todavia no publicada. El
            # veredicto existe; el documento que lo sustenta, aun no.
            'en_preparacion': bool(d.get('in_prep')),
            # QUE ABARCA la clasificacion. Lo traen 95 registros y cambia como
            # hay que leerlos: el del talco aclara que el termino incluye «talc
            # containing asbestiform fibres other than asbestos», que no es lo
            # mismo que el talco alimentario. Sin esta nota, un grupo 2A se lee
            # como si fuera de la sustancia sin mas.
            'comentario': limpiar(d['comment']) if d.get('comment') else None,
            'fuente': {'url': URL, 'consultado': ahora},
        })

    if len(candidatos) < MINIMO:
        raise SystemExit(
            f'solo se encontraron {len(candidatos)} registros (se esperaban '
            f'>= {MINIMO}): el bundle ha cambiado de forma, revisar antes de usar')

    with open(salida, 'w', encoding='utf8') as f:
        for d in filas:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    por_grupo = {}
    for d in filas:
        por_grupo[d['grupo']] = por_grupo.get(d['grupo'], 0) + 1
    print(f'objetos en el bundle        : {len(candidatos)}')
    print(f'   clasificaciones          : {len(filas)}')
    print(f'   referencias cruzadas     : {sin_grupo}')
    print(f'   sin CAS (no cruzables)   : {sin_cas}')
    print('\npor grupo:')
    for g in ('1', '2A', '2B', '3'):
        print(f'   {por_grupo.get(g, 0):>4}  Grupo {g:<3} {GRUPOS[g]}')
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection iarc --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
