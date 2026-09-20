"""
Evidencia de peligro de EFSA OpenFoodTox: a que dosis dana, y de que forma.

Dos datos por sustancia, y responden a preguntas distintas:

  - **IDA** (`AcceptableDailyIntake`): la dosis diaria que se considera segura.
    Sale de dividir el NOAEL por un factor de incertidumbre, normalmente 100.
  - **Efecto critico** (`CriticalEndpoint`): el efecto que FIJO esa dosis.

LO QUE `CriticalEndpoint` NO ES, y conviene tenerlo escrito: no es «lo peor que
hace la sustancia». Para el nitrito sodico dice «aumento de metahemoglobina»,
mientras IARC lo clasifica 2A por nitrosacion endogena. Se comprobo sobre los
46 aditivos con efecto legible: en las doce etiquetas distintas NO APARECE NI
UNA relacionada con cancer o genotoxicidad. Y es estructural, no una laguna: a
un carcinogeno genotoxico no se le asigna IDA, precisamente porque no se le
supone dosis segura. Por eso el cancer necesita IARC como fuente aparte.

LA ESTRUCTURA. Los valores de referencia apuntan a la sustancia en UN salto
-`Parent UUID` de ToxRefValues es el `Document UUID` de SUB-, pero el efecto
critico es un UUID que apunta a un registro de estudio en otra hoja.

TRES TRAMPAS DEL FORMATO, las tres comprobadas:

  - El xlsx OMITE las celdas vacias, asi que emparejar cabecera y fila por
    posicion desalinea las columnas. Hay que usar la referencia (`r="BC12"`).
  - Los campos estructurados de toxicidad -`TestRs.Toxicity`,
    `TargetSystemOrganToxicity.*`- existen en el esquema y estan VACIOS: 0 de
    65. El dato solo vive en texto libre.
  - Ese texto libre esta en TRES columnas con el mismo prefijo.
    `RemarksOnResults` trae «other:», `.Remarks` la narrativa del experimento y
    `.Other` el patron util `Toxicity: X; Effect desc.: Y`. Aceptar cualquiera
    de las tres metia la narrativa del experimento como si fuera el efecto.

Datos de EFSA OpenFoodTox (CC-BY-ND). Se extraen hechos y se cita la fuente.
"""
import json
import re
import sys
from datetime import datetime, timezone

from extraer import Libro

IDA = 'HumanHealthHazardCharacteristics.AcceptableDailyIntake.'
EFECTO = re.compile(r'\s*Toxicity:\s*([^;]+?)\s*(?:;|$)')
DESC = re.compile(r'Effect desc\.?:\s*(.+)')
# Etiquetas que existen pero no dicen nada util. Mas de la mitad de los casos.
VACIAS = {'systemic', 'not reported'}

# POR QUE no hay IDA. Que falte NO significa ni seguro ni prohibido: puede ser
# que no hiciera falta -toxicidad muy baja- o que no se pudiera establecer
# -genotoxicidad-. Son conclusiones opuestas y EFSA las distingue en
# `Justification`, un campo con 63 valores, los mismos 63 que `NoAllocated`.
#
# AVISO: la etiqueta y el dictamen no siempre coinciden. La goma xantana sale
# como `Incomplete dataset` y su dictamen de 2017 dice «no need for a numerical
# ADI». Por eso estos casos se revisan a mano y no se aplican a ciegas.
SIN_IDA = {
    'genotoxic concern': 'genotoxicidad',
    'not set, genotoxicity inconclusive': 'genotoxicidad',
    'not deemed necessary': 'no-hizo-falta',
    'not deemed necessary.': 'no-hizo-falta',
    'no safety concern under current conditions (refined exposure scenario)': 'no-hizo-falta',
    'incomplete dataset': 'faltan-datos',
    'incomplete dataset; not deemed necessary.': 'faltan-datos',
    'out of scope': 'fuera-de-ambito',
}


def motivo_sin_ida(justificacion):
    if not justificacion:
        return None
    return SIN_IDA.get(justificacion.strip().lower(), 'otro')


def numero(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main(ruta_oft, salida, version='OpenFoodTox 3.0 (Zenodo 19388272)'):
    lib = Libro(ruta_oft)

    # Sustancias, y el dato quimico que cuelga de su REF_SUB.
    ref = {r['Document UUID']: r for r in lib.filas('REF_SUB') if r.get('Document UUID')}
    sustancias = {}
    for s in lib.filas('SUB'):
        u = s.get('Document UUID')
        if not u:
            continue
        r = ref.get(s.get('ReferenceSubstance.ReferenceSubstance')) or {}
        sustancias[u] = {
            'nombre': s.get('ChemicalName'),
            'cas': (r.get('Inventory.CASNumber') or '').strip() or None,
            'param_code': r.get('EFSA PARAM CODE'),
        }

    # Valores de referencia. `Parent UUID` es la sustancia, en un salto.
    valores, criticos = {}, {}
    for r in lib.filas('FLEX_SUM.ToxRefValues'):
        s = r.get('Parent UUID')
        if s not in sustancias:
            continue
        v = {
            'ida': numero(r.get(IDA + 'Adi.lowerValue')),
            'unidad': r.get(IDA + 'Adi.Unit'),
            # `NoAllocated` marca que EFSA NO asigno IDA. Dice poco por si
            # solo: es verdad tanto cuando no hizo falta -toxicidad muy baja-
            # como cuando no se pudo -genotoxicidad-. Hay que leer el dictamen.
            'sin_ida': r.get(IDA + 'NoAllocated'),
            # El texto tal cual, y nuestra lectura de el. Sin el texto no se
            # puede comprobar la lectura.
            'sin_ida_justificacion': r.get(IDA + 'Justification'),
            'sin_ida_motivo': motivo_sin_ida(r.get(IDA + 'Justification')),
            'comentarios': r.get(IDA + 'JustificationAndComments'),
            'incertidumbre': numero(r.get(IDA + 'OverallUncertainty')),
            'poblacion': r.get(IDA + 'Population'),
            'organismo': r.get(IDA + 'AssessmentBody'),
        }
        if not any(v[k] for k in ('ida', 'sin_ida')):
            continue
        # Entre varios, manda la IDA mas baja: es la mas protectora.
        previo = valores.get(s)
        if previo is None or (v['ida'] is not None and
                              (previo['ida'] is None or v['ida'] < previo['ida'])):
            valores[s] = v
        ce = r.get(IDA + 'CriticalEndpoint')
        if ce:
            criticos[ce] = s

    # Estudios: solo los senalados como criticos por el propio EFSA.
    estudios = {}
    for r in lib.filas('END_STUDY_REC.HumanHealth'):
        u = r.get('Document UUID')
        if u not in criticos:
            continue
        tox = desc = None
        for k, val in r.items():
            if not (isinstance(k, str) and k.endswith('RemarksOnResults.Other')
                    and isinstance(val, str)):
                continue
            m = EFECTO.match(val)
            if m:
                tox = m.group(1).strip()
                d = DESC.search(val)
                desc = d.group(1).strip() if d else None
                break
        estudios[criticos[u]] = {
            'estudio_uuid': u,
            'tipo': r.get('AdministrativeData.Endpoint'),
            'toxicidad': tox,
            'efecto': desc,
            'especie': r.get('MaterialsAndMethods.TestAnimals.Species'),
            'dosis': numero(r.get('ResultsAndDiscussion.EffectLevels.Efflevel.EffectLevel.lowerValue')),
            'dosis_unidad': r.get('ResultsAndDiscussion.EffectLevels.Efflevel.EffectLevel.Unit'),
            'descriptor': r.get('ResultsAndDiscussion.EffectLevels.Efflevel.Endpoint'),
            'util': bool(tox and tox not in VACIAS),
        }

    ahora = datetime.now(timezone.utc).isoformat()
    n_util = 0
    with open(salida, 'w', encoding='utf8') as f:
        for u in sorted(set(valores) | set(estudios.values() and estudios)):
            if u not in valores and u not in estudios:
                continue
            e = estudios.get(u)
            if e and e['util']:
                n_util += 1
            f.write(json.dumps({
                '_id': u,
                **sustancias[u],
                'valor': valores.get(u),
                'critico': e,
                'fuente': {'version': version, 'consultado': ahora},
            }, ensure_ascii=False) + '\n')

    con_ida = sum(1 for v in valores.values() if v['ida'] is not None)
    print(f'sustancias con valor de referencia : {len(valores)}')
    print(f'   con IDA numerica                : {con_ida}')
    print(f'   con «IDA no asignada»           : {len(valores) - con_ida}')
    motivos = {}
    for v in valores.values():
        if v['ida'] is None and v['sin_ida_motivo']:
            motivos[v['sin_ida_motivo']] = motivos.get(v['sin_ida_motivo'], 0) + 1
    for m, n in sorted(motivos.items(), key=lambda x: -x[1]):
        print(f'      {n:>4}  {m}')
    print(f'con efecto critico resuelto        : {len(estudios)}')
    print(f'   con etiqueta UTIL               : {n_util}')
    print(f'   solo «systemic» o «not reported»: {len(estudios) - n_util}')
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection oft --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:4])
