"""
Aplana `prohibiciones.json` a JSONL para cargarlo con mongoimport.

Lo unico que hace es marcar cada entrada con su `tipo` -`prohibicion` o
`retirada`- y sacarla de su bloque. Esa marca es la que decide si penaliza, asi
que va aqui y no en `enriquecer.js`: el fichero de datos dice QUE es cada cosa;
el script de enlace solo lo aplica.

Se comprueba de paso que ningun tag este en los dos bloques, que seria una
contradiccion silenciosa.
"""
import json
import sys


def main(entrada, salida):
    d = json.load(open(entrada, encoding='utf8'))
    filas = []
    vistos = {}
    for tipo in ('prohibiciones', 'retiradas'):
        for e in d.get(tipo, []):
            t = e['tag']
            singular = 'prohibicion' if tipo == 'prohibiciones' else 'retirada'
            if t in vistos and vistos[t] != singular:
                raise SystemExit(
                    f'{t} aparece como {vistos[t]} y como {singular}: '
                    'son estados incompatibles, hay que decidir cual es')
            vistos[t] = singular
            filas.append({**e, 'tipo': singular,
                          '_id': f'{t}:{e["jurisdiccion"]}'})

    with open(salida, 'w', encoding='utf8') as f:
        for x in filas:
            f.write(json.dumps(x, ensure_ascii=False) + '\n')

    n_p = sum(1 for x in filas if x['tipo'] == 'prohibicion')
    print(f'prohibiciones : {n_p}')
    print(f'retiradas     : {len(filas) - n_p}')
    for x in filas:
        marca = 'PROHIBIDO' if x['tipo'] == 'prohibicion' else 'retirado '
        extra = ''
        if x.get('alcance') == 'parcial':
            extra = '  [PARCIAL]'
        if x.get('no_cubre'):
            extra += f"  [no cubre {', '.join(x['no_cubre'])}]"
        otras = len(x.get('tambien') or [])
        if otras:
            extra += f'  (+{otras} jurisdicciones)'
        print(f'   {x["tag"]:<12} {marca} {x["jurisdiccion"][:22]:<24}'
              f'{x["referencia"][:34]:<36}{extra}')
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection prohibiciones --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
