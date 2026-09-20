"""
Carga las asignaciones escritas a mano a sus colecciones.

QUE HACE ESTO AQUI. Hay decisiones que no se pueden derivar de ninguna fuente y
tienen que escribirse: que entrada de IARC aplica a que aditivo cuando IARC
clasifico una EXPOSICION sin numero CAS, o que retirada de la FDA no se refleja
todavia en el texto del CFR.

Se cargan como colecciones en vez de leerse desde el script de enlace para que
la regla sea la misma para todo: `enriquecer.js` solo lee de Mongo, nunca del
disco. Asi no hay dos maneras de que un dato entre en la base.

Cada fichero declara el campo que contiene la lista, porque no comparten forma:

    manual-iarc.json   `asignaciones`   una entrada de IARC -> varios tags
    manual-fda.json    `revocaciones_recientes`  revocacion -> tags

`manual-grupos.json` NO entra aqui: lo consume `enlazar.py`, que es quien
decide los enlaces, y cargarlo dos veces seria pedir una contradiccion.
"""
import json
import sys

FICHEROS = {
    'manual-iarc.json': ('asignaciones', 'iarc_manual'),
    'manual-fda.json': ('revocaciones_recientes', 'fda_manual'),
    # El mapeo parrafo de la § 81.10 -> numero E. Va anidado un nivel mas
    # porque comparte fichero con las revocaciones.
    'manual-fda.json#colorantes': (('colorantes_cfr81', 'asignaciones'),
                                   'cfr81_manual'),
}


def main(directorio, salida_dir):
    for clave, (campo, coleccion) in FICHEROS.items():
        fichero = clave.split('#')[0]
        ruta = f'{directorio}/{fichero}'
        try:
            d = json.load(open(ruta, encoding='utf8'))
        except FileNotFoundError:
            print(f'{fichero:<22} no esta, se salta')
            continue
        if isinstance(campo, tuple):
            for k in campo:
                d = (d or {}).get(k) or {}
            filas = d if isinstance(d, list) else []
        else:
            filas = d.get(campo) or []
        salida = f'{salida_dir}/{coleccion}.jsonl'
        with open(salida, 'w', encoding='utf8') as f:
            for i, x in enumerate(filas):
                f.write(json.dumps({'_id': f'{coleccion}:{i}', **x},
                                   ensure_ascii=False) + '\n')
        tags = sum(len(x.get('aplica_a') or []) for x in filas)
        print(f'{fichero:<22} {len(filas):>3} entradas -> {tags:>3} tags '
              f'-> {coleccion}')
        print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
              f'--collection {coleccion} --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
