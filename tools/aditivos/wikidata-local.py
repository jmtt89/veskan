"""
Copia local completa de los items de Wikidata que tocan a los aditivos.

Se guarda el item ENTERO -todas sus declaraciones, etiquetas y enlaces-, no
solo los dos campos que hoy usamos. Dos razones:

  - Wikidata es editable por cualquiera. Sin una copia fechada no se puede
    reproducir una clasificacion: el dato de hoy puede no ser el de manana.
  - Ya sabemos que necesitaremos mas propiedades de las previstas. Empezamos
    por P628 (numero E) y P231 (CAS), y en dos vueltas hizo falta el Q-id, la
    etiqueta y la descripcion. Traer solo lo que se usa obliga a volver.

NO es una copia de Wikidata entera: son los ~600 items alcanzables desde un
numero E mas los que Open Food Facts enlaza en su taxonomia. Del orden de
megabytes, no de los 145 GB del volcado completo.

Se usa la Action API (`wbgetentities`, 50 ids por peticion) y no el endpoint
SPARQL: devuelve el item completo y tiene cuotas mas holgadas. Las peticiones
pequenas y repetidas contra el SPARQL son las que provocaron los 429.

Se escribe un JSONL y se carga con `mongoimport` en vez de usar un cliente de
Python: no hace falta anadir ninguna dependencia al proyecto.

Datos de Wikidata bajo CC0.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = 'https://www.wikidata.org/w/api.php'
WDQS = 'https://query.wikidata.org/sparql'
UA = 'Veskan/0.1 (+https://github.com/jmtt89/veskan)'
LOTE = 50

# Todo item que declare un numero E, tenga o no lo demas.
CONSULTA = """
SELECT DISTINCT ?item WHERE { ?item wdt:P628 ?e }
"""


def pedir(url, datos=None, intentos=4):
    for i in range(intentos):
        try:
            req = urllib.request.Request(
                url, data=datos,
                headers={'User-Agent': UA,
                         'Content-Type': 'application/x-www-form-urlencoded',
                         'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception as e:
            if i == intentos - 1:
                raise
            espera = 15 * (i + 1)
            print(f'   reintento {i + 1} en {espera}s ({e})')
            time.sleep(espera)


def qids_por_numero_e():
    """Una sola peticion. Trocearla es lo que provoca los 429."""
    datos = urllib.parse.urlencode({'query': CONSULTA, 'format': 'json'}).encode()
    filas = pedir(WDQS, datos)['results']['bindings']
    return {f['item']['value'].rsplit('/', 1)[-1] for f in filas}


def qids_de_off(ruta):
    tax = json.loads(Path(ruta).read_text())
    return {q for v in tax.values()
            if (q := (v.get('wikidata') or {}).get('en'))}


def main(ruta_off, salida):
    porE = qids_por_numero_e()
    porOff = qids_de_off(ruta_off)
    qids = sorted(porE | porOff)
    print(f'items con numero E        : {len(porE)}')
    print(f'items enlazados por OFF   : {len(porOff)}')
    print(f'union a descargar         : {len(qids)}')

    ahora = datetime.now(timezone.utc).isoformat()
    total = 0
    with open(salida, 'w', encoding='utf8') as f:
        for i in range(0, len(qids), LOTE):
            lote = qids[i:i + LOTE]
            url = f'{API}?' + urllib.parse.urlencode({
                'action': 'wbgetentities', 'ids': '|'.join(lote),
                'format': 'json', 'maxlag': '5',
            })
            datos = pedir(url).get('entities', {})
            n = 0
            for q, item in datos.items():
                if 'missing' in item:
                    continue
                # El item ENTERO, tal cual lo devuelve Wikidata, mas cuando lo
                # bajamos. Sin la fecha no se puede reproducir nada.
                f.write(json.dumps({**item, '_id': q, 'descargado': ahora},
                                   ensure_ascii=False) + '\n')
                n += 1
            total += n
            print(f'   lote {i // LOTE + 1}/{(len(qids) + LOTE - 1) // LOTE}: '
                  f'{n} items  (total {total})')
            time.sleep(1)
    print(f'\nescritos {total} items en {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection wikidata --drop --jsonArray=false < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:])
