"""
¿Nos dejamos algo en las fuentes de peligro? Se comprueba una a una.

LA PREGUNTA. Que un aditivo no tenga dato de IARC puede significar dos cosas
opuestas, y el numero de enlaces no las distingue:

    el CAS esta en la fuente y no lo enlazamos   -> fallo nuestro
    el CAS no esta en la fuente                  -> no hay nada que enlazar

La segunda es lo normal y no se arregla; la primera es un fallo. Sin separarlas
no se puede decir si la cobertura es baja porque extraemos mal o porque las
fuentes no cubren los aditivos alimentarios.

CONTRA EL FICHERO, NO CONTRA LO CARGADO. Es la leccion de la primera version de
este audit: se cruzo contra la coleccion `oft`, que son 4.387 sustancias porque
`oft.py` descarta las que no tienen ningun valor. El fichero de EFSA trae 7.890.
Una sustancia puede estar en el fichero, no tener datos y por tanto no estar
cargada: contra la coleccion parece ausente y no lo esta. Aqui se cruza contra
la fuente entera.

Eso importa especialmente en el CLP: `clp.py` extrae solo las entradas con
clasificacion CMR -1.365 de unas 4.600-, asi que un aditivo puede estar en el
Anexo VI con otra clasificacion y parecer ausente.

QUE SE COMPARA. El CAS de Wikidata (P231, que puede traer varios) contra el CAS
de cada fuente. Solo eso: es la via que usan los extractores, comprobada de
forma exhaustiva. Las otras vias -nombre, numero E- se prueban aparte porque
tienen falsos positivos y aqui se busca certeza, no cobertura.

Uso:
    python3 auditar.py <aditivos.jsonl> --clp <clp.xhtml> --iarc <loc.js>
"""
import json
import re
import sys

# `1333-86-4`, tolerando espacios y guiones tipograficos. Los ceros a la
# izquierda no son significativos: `0064-17-5` es `64-17-5`.
CAS = re.compile(r'(\d{2,7})\s*[-–—]\s*(\d{2})\s*[-–—]\s*(\d)')


def normalizar(v):
    if not isinstance(v, str):
        return None
    m = CAS.search(v.strip())
    return f'{int(m.group(1))}-{m.group(2)}-{m.group(3)}' if m else None


def cas_de_wikidata(d):
    fuera = []
    for s in (d.get('claims') or {}).get('P231') or []:
        v = ((s.get('mainsnak') or {}).get('datavalue') or {}).get('value')
        n = normalizar(v)
        if n and n not in fuera:
            fuera.append(n)
    return fuera


def cas_del_clp(ruta):
    """
    Todos los CAS del Anexo VI, con clasificacion CMR o sin ella.

    El anexo es una tabla enorme en XHTML. No se parsea la estructura: se
    recogen todos los CAS que aparecen, porque para este audit basta saber si
    la sustancia FIGURA, no que dice de ella.
    """
    texto = open(ruta, encoding='utf8', errors='ignore').read()
    return {normalizar(m.group(0)) for m in CAS.finditer(texto)} - {None}


def cas_de_iarc(ruta):
    """Los CAS del bundle de IARC, que los lleva como listas en el JS."""
    texto = open(ruta, encoding='utf8', errors='ignore').read()
    return {normalizar(m.group(0)) for m in CAS.finditer(texto)} - {None}


def auditar(nombre, universo, filas, campo_enlace):
    """Compara nuestros CAS contra el universo de una fuente."""
    con_cas = [f for f in filas if f['cas']]
    existe = [f for f in con_cas if set(f['cas']) & universo]
    perdidos = [f for f in existe if not f[campo_enlace]]
    enlazados_fuera = [f for f in filas
                       if f[campo_enlace] and not (set(f['cas']) & universo)]

    print(f'\n{nombre}')
    print(f'   CAS distintos en la fuente        : {len(universo)}')
    print(f'   nuestros aditivos con CAS         : {len(con_cas)}')
    print(f'      su CAS SI figura en la fuente  : {len(existe)}')
    print(f'      su CAS NO figura               : {len(con_cas) - len(existe)}')
    print(f'   enlazados hoy                     : '
          f'{sum(1 for f in filas if f[campo_enlace])}')
    print(f'   FIGURA Y NO LO ENLAZAMOS          : {len(perdidos)}'
          f'{"   <- revisar" if perdidos else ""}')
    if enlazados_fuera:
        print(f'   enlazado pero su CAS no figura    : {len(enlazados_fuera)}'
              f'   <- enlazado por otra via')
    for f in perdidos[:20]:
        print(f'      {f["tag"]:<12}{str(f["nombre"])[:30]:<32}'
              f'{"|".join(sorted(set(f["cas"]) & universo))}')
    if len(perdidos) > 20:
        print(f'      ... y {len(perdidos) - 20} mas')
    return perdidos


def main(ruta_aditivos, *args):
    rutas = {}
    for i in range(0, len(args) - 1, 2):
        if args[i].startswith('--'):
            rutas[args[i][2:]] = args[i + 1]

    filas = []
    for linea in open(ruta_aditivos, encoding='utf8'):
        d = json.loads(linea)
        off = (d.get('enlaces') or {}).get('off') or []
        if not off:
            continue
        filas.append({
            'wikidata': d['_id'],
            'tag': off[0].get('tag'),
            'nombre': off[0].get('nombre'),
            'cas': cas_de_wikidata(d),
            'tiene_iarc': bool(d.get('iarc')),
            'tiene_clp': bool(d.get('clp')),
        })

    print(f'aditivos con tag de Open Food Facts : {len(filas)}')
    print(f'   con al menos un CAS              : '
          f'{sum(1 for f in filas if f["cas"])}')

    if 'clp' in rutas:
        auditar('CLP — Anexo VI del Reglamento 1272/2008',
                cas_del_clp(rutas['clp']), filas, 'tiene_clp')
    if 'iarc' in rutas:
        auditar('IARC — monografias',
                cas_de_iarc(rutas['iarc']), filas, 'tiene_iarc')


if __name__ == '__main__':
    main(*sys.argv[1:])
