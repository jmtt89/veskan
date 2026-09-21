"""
Evidencia de exposicion de Open Food Facts: si la gente supera la dosis segura.

ES LA UNICA FUENTE DE ESTO. OpenFoodTox trae el lado del PELIGRO -a que dosis
dana- pero no el de la EXPOSICION: su hoja `FLEX_SUM.ExpectedExposure` tiene
dos filas y esta vacia. La exposicion solo vive en el texto de los dictamenes
de EFSA, y calcularla exige datos de consumo alimentario poblacional.

DE DONDE SALE. No hay ninguna tuberia automatica detras: los colaboradores de
Open Food Facts leyeron los dictamenes A MANO y transcribieron la IDA, que
grupos la superan en consumo medio y cuales en percentil 95.
`efsa_evaluation_overexposure_risk` es un campo DERIVADO de esos dos.

Por eso se paro en 2019 -dejaron de hacerlo, no se cerro ninguna fuente- y por
eso lo podemos continuar nosotros y devolverselo.

POR QUE IMPORTA LA DISTINCION. Peligro y exposicion son ortogonales:

    E123 amaranto     teratogeno, IDA 0,15   casi no se usa   -> sin riesgo
    E250 nitrito      reversible,  IDA 0,1   muy consumido    -> riesgo alto
    E407 carragenato  leve,        IDA 75    esta en todo     -> riesgo alto

Amaranto y nitrito son igual de potentes y acaban en extremos opuestos. Una
escala construida solo sobre la IDA no reproduce esto: se comprobo, y las
medianas de «alto» y «moderado» coinciden en 5,0 mg/kg.

Datos de Open Food Facts bajo ODbL-1.0.
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# Grupos que EFSA trata aparte por ser mas vulnerables a la misma dosis.
VULNERABLES = {'en:infants', 'en:toddlers', 'en:children', 'en:adolescents'}


def valor(v, campo, idioma='en'):
    x = (v.get(campo) or {}).get(idioma)
    return x.strip() if isinstance(x, str) else x


def lista(v, campo):
    x = valor(v, campo)
    if not x:
        return []
    partes = [p.strip() for p in re.split(r'[,;]', x) if p.strip()]
    return [p for p in partes if p != 'en:no-group']


def numero(x):
    try:
        return float(str(x).strip())
    except (TypeError, ValueError):
        return None


def main(ruta_off, salida):
    off = json.loads(Path(ruta_off).read_text())
    ahora = datetime.now(timezone.utc).isoformat()

    filas, con_riesgo, con_dictamen = [], 0, 0
    for tag, v in off.items():
        riesgo = valor(v, 'efsa_evaluation_overexposure_risk')
        riesgo = riesgo.replace('en:', '') if riesgo else None
        fecha = valor(v, 'efsa_evaluation_date')
        medio = lista(v, 'efsa_evaluation_exposure_mean_greater_than_adi')
        p95 = lista(v, 'efsa_evaluation_exposure_95th_greater_than_adi')
        anses = valor(v, 'anses_additives_of_interest') == 'yes'
        if not (riesgo or fecha or medio or p95 or anses):
            continue
        if riesgo:
            con_riesgo += 1
        if fecha:
            con_dictamen += 1
        e = valor(v, 'e_number')
        # OFF deja el campo vacio en algunas entradas aunque el nombre si lo
        # lleve: `en:e170` se llama «E170 - Carbonatos de calcio» y su
        # `e_number` es null. Se deduce del tag, que es la clave canonica.
        if not e:
            m = re.match(r'^en:e(\d{3,4}[a-z]*)$', tag)
            e = m.group(1) if m else None
        filas.append({
            '_id': tag,
            'numero_e': str(e).lower() if e else None,
            'riesgo_sobreexposicion': riesgo,
            # Superar la IDA en consumo MEDIO es mas grave que en el percentil
            # 95: significa que el consumidor tipico ya se pasa, no solo el que
            # mas consume.
            'supera_ida_consumo_medio': medio,
            'supera_ida_percentil95': p95,
            'grupos_vulnerables_afectados': sorted(
                set(medio + p95) & VULNERABLES),
            # La IDA que Open Food Facts transcribio del dictamen. Se guarda
            # para contrastarla con la de OpenFoodTox: si no coinciden, una de
            # las dos transcripciones esta mal o son dictamenes distintos.
            'ida_transcrita': numero(valor(v, 'efsa_evaluation_adi')),
            'anses_vigilancia': anses,
            'dictamen': {
                'titulo': valor(v, 'efsa_evaluation'),
                'fecha': fecha,
                'url': valor(v, 'efsa_evaluation_url'),
            },
            'clases': lista(v, 'additives_classes'),
            'organico_ue': valor(v, 'organic_eu'),
            'fuente': {'origen': 'taxonomia de Open Food Facts',
                       'licencia': 'ODbL-1.0', 'consultado': ahora},
        })

    with open(salida, 'w', encoding='utf8') as f:
        for d in filas:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')

    anios = {}
    for d in filas:
        y = (d['dictamen']['fecha'] or '')[:4]
        if y:
            anios[y] = anios.get(y, 0) + 1
    print(f'aditivos con algo de Open Food Facts : {len(filas)}')
    print(f'   con clase de sobreexposicion      : {con_riesgo}')
    print(f'   con dictamen fechado              : {con_dictamen}')
    print(f'   marcados por ANSES                : {sum(1 for d in filas if d["anses_vigilancia"])}')
    print(f'   que afectan a grupos vulnerables  : '
          f'{sum(1 for d in filas if d["grupos_vulnerables_afectados"])}')
    if anios:
        ultimo = max(anios)
        print(f'\ndictamenes por anio, mas reciente: {ultimo}')
        print('   ' + '  '.join(f'{a}:{n}' for a, n in sorted(anios.items())[-8:]))
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection off --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
