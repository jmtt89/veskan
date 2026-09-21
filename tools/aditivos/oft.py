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


# Un DOI tal cual lo escribe EFSA: `doi:10.2903/...`, `doi: 10.2903/...` y
# `doi. org/10.2903/...` conviven en el mismo fichero -292 de 9.170 con una de
# las dos formas raras-. Se publica desnudo para que el consumidor componga
# `https://doi.org/<doi>` sin tener que quitar prefijos ni espacios.
DOI = re.compile(r'(10\.\d{4,9}/\S+)')


def doi_limpio(v):
    m = DOI.search(str(v)) if v else None
    return m.group(1) if m else None


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

    fecha_dossier = {}
    for r in lib.filas('DOSSIER'):
        u = r.get('Document UUID')
        if not u:
            continue
        f = r.get('LiteratureReference.DateOfEvaluation')
        if not f:
            # Algunos dictamenes solo traen la fecha dentro de un comentario.
            m = re.search(r'(\d{4}-\d{2}-\d{2})',
                          str(r.get('DossierSubject.DossierSubmissionRemark') or ''))
            f = m.group(1) if m else None
        fecha_dossier[u] = {
            'fecha': str(f)[:10] if f else None,
            'titulo': r.get('LiteratureReference.EFSAOutputTitle'),
            'doi': doi_limpio(
                r.get('LiteratureReference.LinkToPersistentIdentifier')),
        }
    # Tanto los resumenes de endpoint como las fichas de valores de
    # referencia cuelgan de un dictamen, y por eso se pueden emparejar: lo
    # que encontraron los estudios y lo que EFSA concluyo, del MISMO acto.
    dossier_de_doc = {}
    for r in lib.filas('DOSSIER_DOCS'):
        if r.get('DOCUMENT TYPE') in ('ENDPOINT_SUMMARY', 'FLEXIBLE_SUMMARY'):
            dossier_de_doc[r.get('DOCUMENT UUID')] = r.get('DOSSIER UUID')

    # Valores de referencia. `Parent UUID` es la sustancia, en un salto.
    valores, criticos, otros = {}, {}, {}
    # Lo que EFSA concluyo, dictamen a dictamen. Va por separado de
    # `valores` porque aquello se queda con la IDA mas protectora de todas
    # y aqui hace falta la de CADA acto, para poder ponerla al lado de sus
    # propios hallazgos.
    conclusiones = {}
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
        du = dossier_de_doc.get(r.get('Document UUID'))
        c = (conclusiones.setdefault(s, {}).setdefault(
                du, {'ida': None, 'sin_ida_motivo': None,
                     'justificacion': None})
             if du else None)
        if c is not None:
            if v['ida'] is not None and c['ida'] is None:
                c['ida'] = v['ida']
            if v['sin_ida_motivo'] and not c['sin_ida_motivo']:
                c['sin_ida_motivo'] = v['sin_ida_motivo']
                c['justificacion'] = v['sin_ida_justificacion']

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

    # Veredicto de genotoxicidad y carcinogenicidad, de la hoja END_SUM.
    #
    # POR QUE ESTA HOJA IMPORTA. Las otras dos ramas dan DOSIS: a partir de
    # cuanto hace dano. Esta da lo contrario, un juicio sobre si hace ese tipo
    # de dano en absoluto, y con un vocabulario que separa justo lo que se
    # confunde una y otra vez:
    #
    #     Negative        se midio y no hay efecto   -> evidencia de AUSENCIA
    #     Positive        se midio y lo hay
    #     Ambiguous       equivoco, no concluyente   -> cola de revision
    #     No data         nadie lo ha medido         -> HUECO
    #     Not determined  no se evaluo               -> HUECO
    #
    # Sin esto, «negativo medido» y «nadie lo ha mirado» llegan al algoritmo
    # como la misma cosa -la ausencia de `critico`- y no lo son.
    #
    # NO ES LA CONCLUSION DEL PANEL, Y CONFUNDIRLO ES GRAVE. Esto resume los
    # HALLAZGOS DE LOS ESTUDIOS del expediente, no lo que EFSA dictamino. El
    # indigo carmin (E132) lo demuestra: su dictamen de 2023 sale aqui con
    # `Carcinogenic: Positive`, y lo que dice ese dictamen es
    #
    #     «the Panel confirmed the ADI of 5 mg/kg bw per day for indigo
    #      carmine (E 132) disodium salts [...] The Panel concluded that there
    #      is no safety concern for the use of indigo carmine (E 132)»
    #                            doi:10.2903/j.efsa.2023.8103, EFSA Journal
    #
    # es decir, lo contrario. Ademas va sobre efectos testiculares y
    # especificaciones, no sobre cancer. Y hay una comprobacion interna que lo
    # confirma sin salir del fichero: EFSA no asigna IDA a un carcinogeno
    # genotoxico, y el E132 conserva la suya.
    #
    # Por eso el campo se llama `hallazgo` y no `veredicto`, y por eso NO
    # alimenta el nivel de gravedad. Sirve para lo contrario de lo que parece:
    # para poder distinguir «se estudio» de «nadie lo miro», y como cola de
    # revision cuando un expediente reciente trae un positivo.
    #
    # `Ambiguous` tampoco es un hallazgo firme: el acido ascorbico sale
    # `mutagenic: Ambiguous` y llamarlo mutageno seria absurdo.
    #
    # UNA SUSTANCIA TIENE VARIOS VEREDICTOS, UNO POR DICTAMEN, Y SE
    # CONTRADICEN. No es un defecto del fichero: es que EFSA vuelve sobre el
    # mismo aditivo cuando hay datos nuevos. El dioxido de titanio tiene DOCE
    # filas aqui:
    #
    #     2016  reevaluacion del panel ANS          Genotoxic: Negative
    #     2019  enmienda de especificaciones        Genotoxic: Negative
    #     2021  evaluacion actualizada, con datos
    #           de nanoparticulas y estudio EOGRT   Genotoxic: POSITIVE
    #
    # La de 2021 es la que llevo a prohibirlo en la Union. Quedarse con
    # cualquier otra -o peor, con la que caiga la ultima al recorrer la hoja-
    # da exactamente la conclusion contraria a la realidad. Por eso cada
    # hallazgo se FECHA por su dictamen y manda el mas reciente que diga algo.
    CAMPOS = ('genotoxic', 'mutagenic', 'carcinogenic')
    # Para resolver las dos mitades de un mismo dictamen. No es una escala de
    # gravedad: es cuanto DICE cada respuesta.
    PESO_VEREDICTO = {'positive': 4, 'ambiguous': 3, 'negative': 2,
                      'other': 1, 'not applicable': 1,
                      'no data': 0, 'not determined': 0}
    dictamenes = {}
    for r in lib.filas('END_SUM'):
        u = r.get('Parent UUID')
        if u not in sustancias:
            continue
        ki = r.get('KeyInformation.KeyInformation')
        if not ki:
            continue
        vs = {}
        for parte in re.split(r'[;\n]', str(ki)):
            if ':' not in parte:
                continue
            k, v = (x.strip() for x in parte.split(':', 1))
            if k.lower() in CAMPOS and v:
                vs[k.lower()] = v
        if not vs:
            continue
        # SE AGRUPA POR DICTAMEN, NO POR FILA. Un mismo dictamen aporta dos
        # filas -una de genotoxicidad y otra de carcinogenicidad- y no son
        # dictamenes rivales: son dos mitades del mismo. El dioxido de titanio
        # de 2021 trae `Genotoxic: Positive` en una y `Mutagenic: Negative` en
        # la otra; tratarlas como dos opiniones distintas, con identica fecha,
        # deja el desempate al azar y puede perder justo el positivo.
        du = dossier_de_doc.get(r.get('Document UUID'))
        d = fecha_dossier.get(du, {})
        clave = du or r.get('Document UUID')
        acc = dictamenes.setdefault(u, {}).setdefault(clave, {
            'fecha': d.get('fecha'),
            'titulo': d.get('titulo'),
            'doi': d.get('doi'),
        })
        for k, v in vs.items():
            # Dentro del MISMO dictamen manda lo adverso: si una mitad mide un
            # efecto y la otra no lo mira, el efecto esta medido.
            if k not in acc or PESO_VEREDICTO.get(str(v).lower(), 0) > \
                    PESO_VEREDICTO.get(str(acc[k]).lower(), 0):
                acc[k] = v

    def clasificar(d):
        """Que encontraron los estudios de ESTE dictamen. No que concluyo."""
        vals = {str(d.get(c) or '').lower() for c in CAMPOS}
        return ('positivo' if 'positive' in vals
                else 'ambiguo' if 'ambiguous' in vals
                else 'negativo' if 'negative' in vals
                else 'sin-dato')

    genotox = {}
    for u, por_dictamen in dictamenes.items():
        ds = list(por_dictamen.values())
        for clave, d in por_dictamen.items():
            d['hallazgo'] = clasificar(d)
            # Lo que EFSA fijo EN ESE MISMO dictamen. Son hechos, no un
            # juicio: la IDA que asigno, o el motivo codificado de no asignar
            # ninguna. No se sintetiza un veredicto a partir de ellos.
            #
            # Se intento, y se cayo solo: mapear el descriptor
            # `margin of safety` a «preocupacion» etiquetaba asi los
            # dictamenes de 2004 y 2016 sobre el dioxido de titanio, que
            # concluyeron que era aceptable. Ese descriptor dice como se
            # expreso el valor de referencia, no lo que opina el panel.
            c = (conclusiones.get(u) or {}).get(clave) or {}
            d['ida_dictamen'] = c.get('ida')
            d['sin_ida_motivo_dictamen'] = c.get('sin_ida_motivo')
        # El mas reciente que DIGA algo. Un dictamen sin fecha no puede
        # desbancar a uno fechado: va al final.
        dichos = [d for d in ds if d['hallazgo'] != 'sin-dato']
        orden = sorted(dichos or ds,
                       key=lambda d: (d['fecha'] or ''), reverse=True)
        mejor = orden[0]
        otras_conclusiones = ({d['hallazgo'] for d in dichos}
                              - {mejor['hallazgo']})
        genotox[u] = {
            **{c: mejor.get(c) for c in CAMPOS if mejor.get(c)},
            'hallazgo': mejor['hallazgo'],
            'estudiado': mejor['hallazgo'] != 'sin-dato',
            # La otra mitad de la fila. Sin ella `hallazgo: positivo` se lee
            # como si EFSA hubiera dictaminado eso, y en el indigo carmin dice
            # lo contrario.
            'ida_dictamen': mejor['ida_dictamen'],
            'sin_ida_motivo_dictamen': mejor['sin_ida_motivo_dictamen'],
            'fecha': mejor['fecha'],
            'dictamen': mejor['titulo'],
            'doi': mejor['doi'],
            'dictamenes': len(ds),
            # Dictamenes anteriores que concluyeron otra cosa. No es un error:
            # es la historia del aditivo, y conviene poder leerla.
            'discrepan': sorted(otras_conclusiones) or None,
            'historial': ([{k: d[k] for k in
                            ('fecha', 'hallazgo', 'titulo', 'doi',
                             'ida_dictamen', 'sin_ida_motivo_dictamen')}
                           for d in orden[1:]] if len(orden) > 1 else None),
        }

    ahora = datetime.now(timezone.utc).isoformat()
    n_util = 0
    with open(salida, 'w', encoding='utf8') as f:
        for u in sorted(set(valores) | set(estudios) | set(otros)
                        | set(genotox)):
            e = estudios.get(u)
            if e and e['util']:
                n_util += 1
            o = otros.get(u)
            f.write(json.dumps({
                '_id': u,
                **sustancias[u],
                'valor': valores.get(u),
                'critico': e,
                # Se midio la genotoxicidad/carcinogenicidad y que salio.
                'genotox': genotox.get(u),
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
    reparto = {}
    for d in genotox.values():
        reparto[d['hallazgo']] = reparto.get(d['hallazgo'], 0) + 1
    print(f'sustancias con hallazgos de geno/carcinogenicidad : {len(genotox)}')
    for v in ('positivo', 'ambiguo', 'negativo', 'sin-dato'):
        if reparto.get(v):
            print(f'      {reparto[v]:>4}  {v}')
    con_ida_dict = sum(1 for d in genotox.values()
                       if d['ida_dictamen'] is not None)
    motivos_dict = {}
    for d in genotox.values():
        m = d['sin_ida_motivo_dictamen']
        if m:
            motivos_dict[m] = motivos_dict.get(m, 0) + 1
    print(f'      con IDA fijada en ESE dictamen  : {con_ida_dict}')
    print(f'      con motivo de no fijarla        : {sum(motivos_dict.values())}')
    for k, n in sorted(motivos_dict.items(), key=lambda x: -x[1]):
        print(f'         {n:>4}  {k}')
    varios = sum(1 for d in genotox.values() if d['dictamenes'] > 1)
    discrepan = sum(1 for d in genotox.values() if d['discrepan'])
    sin_fecha = sum(1 for d in genotox.values() if not d['fecha'])
    print(f'      evaluadas en mas de un dictamen : {varios}')
    print(f'      ...y los dictamenes DISCREPAN   : {discrepan}')
    print(f'      sin fecha de dictamen           : {sin_fecha}')
    print(f'con efecto critico resuelto        : {len(estudios)}')
    print(f'   con etiqueta UTIL               : {n_util}')
    print(f'   solo «systemic» o «not reported»: {len(estudios) - n_util}')
    print(f'\nescrito {salida}')
    print('cargar con:')
    print(f'   docker exec -i <contenedor> mongoimport --db aditivos '
          f'--collection oft --drop < {salida}')


if __name__ == '__main__':
    main(*sys.argv[1:4])
