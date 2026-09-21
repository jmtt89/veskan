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

LA SEGUNDA RAMA, que la primera version no leia y costo 143 sustancias. Una
fila de ToxRefValues puede colgar su dato de DOS sitios distintos:

    HumanHealthHazardCharacteristics.AcceptableDailyIntake.*     <- se leia
    HumanHealthHazardCharacteristics.OtherReferenceValues.*      <- no

Descartar la fila cuando la primera rama viene vacia parecia inocuo -«no hay
IDA, no hay dato»- y no lo era: de 203 sustancias enlazadas que se quedaron sin
cargar, 143 SI tenian filas, solo que en la otra rama. Se vio porque los seis
parabenos aparecian enlazados y sin ningun dato detras.

Lo que hay ahi no es ruido. Son otros valores de referencia -TDI, TWI, UL- y,
sobre todo, el MOTIVO de que no exista IDA, escrito por EFSA:

    E216 propilparabeno   «Incomplete dataset»
    E554 silicato Na-Al   «Incomplete dataset» (x4)
    E559 caolin           «critical study not identified»
                          «Not deemed necessary; no exposure expected»

Eso es justo lo que hace falta para distinguir «no se pudo evaluar» de «no hizo
falta evaluarlo», que son cosas opuestas y ambas se veian como un hueco.

NO SE MEZCLAN CON LA IDA, y no es un detalle de estilo. Una TWI es semanal y
una IDA diaria; una TTC Cramer no es una dosis segura medida sino un umbral
generico por estructura quimica. Meterlas en el campo `ida` corromperia
`posicion_en_nivel`, que ordena por potencia dentro de un nivel comparando
IDAs. Van en `otros_valores`, con su tipo y su unidad.

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

from extraer import Libro, arreglar_mojibake

IDA = 'HumanHealthHazardCharacteristics.AcceptableDailyIntake.'
# La OTRA rama, la que esta version no leia. Ver «LA SEGUNDA RAMA» arriba.
OTROS = 'HumanHealthHazardCharacteristics.OtherReferenceValues.'
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


# Descriptores que NO son una dosis sino la razon de que no la haya. Conviene
# separarlos porque dicen cosas opuestas: «incomplete dataset» es una laguna,
# «not deemed necessary» es una evaluacion que concluyo que no hacia falta.
SIN_DOSIS = {
    'incomplete dataset': 'datos-incompletos',
    'critical study not identified': 'sin-estudio-critico',
    'not deemed necessary': 'no-necesario',
    'margin of safety': 'margen-de-seguridad',
}


def clasificar_descriptor(d):
    bajo = (d or '').strip().lower()
    for clave, etiqueta in SIN_DOSIS.items():
        if bajo.startswith(clave):
            return etiqueta
    return None


def otro_valor(r):
    """
    La rama `OtherReferenceValues` de una fila sin IDA.

    Devuelve None si tampoco hay nada aqui: hay filas que solo llevan los tres
    campos de estructura -`Document UUID`, `Definition`, `Parent UUID`- y esas
    no aportan, se descartan igual que antes.
    """
    tipo = (r.get(OTROS + 'ReferenceValueDescriptor.Other')
            or r.get(OTROS + 'ReferenceValueDescriptor'))
    valor = numero(r.get(OTROS + 'RefValue.lowerValue'))
    just = r.get(OTROS + 'JustificationAndComments')
    ce = r.get(OTROS + 'CriticalEndpoint')
    if not any((tipo, valor is not None, just, ce)):
        return None
    return {
        'tipo': tipo,
        # Cuando el descriptor explica por que NO hay dosis, se anota aparte:
        # es la respuesta a «no tiene IDA, pero por que».
        'sin_dosis_motivo': clasificar_descriptor(tipo),
        'valor': valor,
        'unidad': arreglar_mojibake(
            r.get(OTROS + 'RefValue.Unit') or r.get(OTROS + 'RefValue.Unit.Other')),
        'poblacion': r.get(OTROS + 'Population'),
        'organismo': r.get(OTROS + 'AssessmentBody'),
        'justificacion': just,
        'critico_uuid': ce,
    }


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
    valores, criticos, otros = {}, {}, {}
    for r in lib.filas('FLEX_SUM.ToxRefValues'):
        s = r.get('Parent UUID')
        if s not in sustancias:
            continue
        v = {
            'ida': numero(r.get(IDA + 'Adi.lowerValue')),
            'unidad': arreglar_mojibake(r.get(IDA + 'Adi.Unit')),
            # `NoAllocated` marca que EFSA NO asigno IDA. Dice poco por si
            # solo: es verdad tanto cuando no hizo falta -toxicidad muy baja-
            # como cuando no se pudo -genotoxicidad-. Hay que leer el dictamen.
            #
            # Viene del xlsx como la CADENA "1", no como booleano. Se convierte
            # aqui: un consumidor que haga `if fila.sin_ida` con la cadena "0"
            # -si algun dia aparece- acertaria por casualidad y fallaria el dia
            # que cambie.
            'sin_ida': bool(r.get(IDA + 'NoAllocated')) or None,
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
            # La fila no trae IDA, pero puede traer otro valor de referencia o
            # el motivo de que no lo haya. Antes se descartaba aqui mismo.
            o = otro_valor(r)
            if o:
                otros.setdefault(s, []).append(o)
                if o['critico_uuid']:
                    criticos[o['critico_uuid']] = s
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
        for u in sorted(set(valores) | set(estudios) | set(otros)):
            e = estudios.get(u)
            if e and e['util']:
                n_util += 1
            o = otros.get(u)
            f.write(json.dumps({
                '_id': u,
                **sustancias[u],
                'valor': valores.get(u),
                'critico': e,
                # Otros valores de referencia y, si no hay ninguno, el motivo
                # que da EFSA. Nunca se mezclan con `valor`: unidades distintas.
                'otros_valores': o,
                'sin_dosis_motivo': next(
                    (x['sin_dosis_motivo'] for x in (o or [])
                     if x['sin_dosis_motivo']), None),
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
    solo_otros = set(otros) - set(valores)
    print(f'sustancias SIN IDA pero con otra rama : {len(solo_otros)}')
    motivos_otros = {}
    for u in otros:
        for x in otros[u]:
            if x['sin_dosis_motivo']:
                motivos_otros[x['sin_dosis_motivo']] = \
                    motivos_otros.get(x['sin_dosis_motivo'], 0) + 1
    for m, n in sorted(motivos_otros.items(), key=lambda x: -x[1]):
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
