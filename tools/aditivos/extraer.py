"""
Extrae de OpenFoodTox la rebanada que nos interesa y la deja en SQLite.

OpenFoodTox es la base de peligros quimicos de EFSA entera -7.880 sustancias:
plaguicidas, contaminantes, aromas, aditivos de piensos-. Los aditivos
alimentarios son una categoria de ella, `Domain.FoodDomain = food additives`.

El export viene en un xlsx de 18 hojas con jerarquia IUCLID: los valores de
referencia no apuntan a la sustancia sino a un documento, que apunta a otro,
hasta llegar a ella. Por eso hay que subir por `Parent UUID`.

Se lee el xlsx como lo que es -un zip con XML- para no arrastrar dependencias.
Las celdas vacias se OMITEN en el formato, asi que emparejar por posicion
desalinea las columnas: hay que usar la referencia de celda (`r="BC12"`).

Datos de EFSA (CC-BY-ND). Se extraen hechos y se cita la fuente; no se
republica su tabla.
"""
import re, sqlite3, sys, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def indice_columna(ref):
    """`BC12` -> 54. El xlsx omite celdas vacias; sin esto se desalinea todo."""
    letras = re.match(r'([A-Z]+)', ref).group(1)
    n = 0
    for ch in letras:
        n = n * 26 + ord(ch) - 64
    return n - 1



# El xlsx trae algunas celdas con la UTF-8 pasada dos veces: «Âµg/kg» en vez
# de «µg/kg». Pasa en 5 de 4.387 filas, todas unidades. Se arregla deshaciendo
# la doble codificacion, no con una tabla de reemplazos: la tabla solo cubre
# los casos que ya se vieron.
def arreglar_mojibake(v):
    if not isinstance(v, str) or 'Â' not in v:
        return v
    try:
        return v.encode('latin-1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return v


class Libro:
    def __init__(self, ruta):
        self.z = zipfile.ZipFile(ruta)
        self.cadenas = [
            ''.join(t.text or '' for t in e.iter(NS + 't'))
            for e in ET.fromstring(self.z.read('xl/sharedStrings.xml'))
        ]
        wb = self.z.read('xl/workbook.xml').decode('utf8', 'ignore')
        rels = self.z.read('xl/_rels/workbook.xml.rels').decode('utf8', 'ignore')
        rid = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(worksheets/[^"]+)"', rels))
        self.hojas = {
            n: 'xl/' + rid[r]
            for n, r in re.findall(r'<sheet name="([^"]+)"[^>]*r:id="(rId\d+)"', wb)
            if r in rid
        }

    def filas(self, hoja):
        cab = None
        for _, el in ET.iterparse(self.z.open(self.hojas[hoja]), events=('end',)):
            if el.tag != NS + 'row':
                continue
            d = {}
            for c in el.iter(NS + 'c'):
                v = c.find(NS + 'v')
                if v is None:
                    continue
                d[indice_columna(c.get('r'))] = (
                    self.cadenas[int(v.text)] if c.get('t') == 's' else (v.text or '')
                )
            if cab is None:
                cab = dict(d)
            else:
                yield {cab.get(i, i): x for i, x in d.items()}
            el.clear()


def main(origen, destino, dominio='food additives'):
    lib = Libro(origen)

    # Que dossieres son de la categoria pedida, y la cadena de padres completa.
    dossier, padre = {}, {}
    for r in lib.filas('DOSSIER'):
        u = r.get('Document UUID')
        if not u:
            continue
        dossier[u] = r.get('Domain.FoodDomain')
        padre[u] = r.get('Parent UUID')
    for hoja in ('DOSSIER_DOCS', 'FLEX_REC', 'REF_SUB'):
        for r in lib.filas(hoja):
            u = r.get('Document UUID')
            if u:
                padre[u] = r.get('Parent UUID')

    sustancias = {}
    for r in lib.filas('SUB'):
        u = r.get('Document UUID')
        if u and r.get('ChemicalName'):
            sustancias[u] = r['ChemicalName']
            padre[u] = r.get('Parent UUID')

    def sube(uuid, predicado, saltos=6):
        cur = uuid
        for _ in range(saltos):
            if cur is None:
                return None
            if predicado(cur):
                return cur
            cur = padre.get(cur)
        return None

    # Sustancias cuyo dossier es de la categoria.
    del_dominio = {
        u for u in sustancias
        if sube(u, lambda x: dossier.get(x) == dominio) is not None
    }
    print(f'sustancias en «{dominio}»: {len(del_dominio)} de {len(sustancias)}')

    db = sqlite3.connect(destino)
    db.executescript((Path(__file__).parent / 'esquema-oft.sql').read_text())
    db.executemany(
        'INSERT INTO sustancias (uuid, nombre) VALUES (?,?)',
        [(u, sustancias[u]) for u in sorted(del_dominio)],
    )

    P = 'HumanHealthHazardCharacteristics.AcceptableDailyIntake.'
    valores = []
    for r in lib.filas('FLEX_SUM.ToxRefValues'):
        s = sube(r.get('Parent UUID'), lambda x: x in del_dominio)
        if not s:
            continue
        valores.append((
            s, r.get(P + 'Adi.lowerValue'), r.get(P + 'Adi.Unit'),
            r.get(P + 'NoAllocated'), r.get(P + 'OverallUncertainty'),
            r.get(P + 'CriticalEndpoint'), r.get(P + 'Population'),
        ))
    db.executemany(
        'INSERT INTO valores (sustancia, ida, unidad, sin_ida, incertidumbre,'
        ' endpoint_critico, poblacion) VALUES (?,?,?,?,?,?,?)', valores)
    print(f'valores de referencia: {len(valores)}')

    # Estudios: solo el tipo de efecto, no el registro entero.
    estudios = []
    for r in lib.filas('END_STUDY_REC.HumanHealth'):
        s = sube(r.get('Parent UUID'), lambda x: x in del_dominio)
        if not s:
            continue
        tox = efecto = None
        for k, v in r.items():
            if isinstance(k, str) and k.endswith('RemarksOnResults.Other') and isinstance(v, str):
                m = re.match(r'\s*Toxicity:\s*([^;]+?)\s*(?:;|$)', v)
                if m:
                    tox = m.group(1).strip()
                    m2 = re.search(r'Effect desc\.?:\s*(.+)', v)
                    efecto = m2.group(1).strip() if m2 else None
                    break
        if not tox and not r.get('AdministrativeData.Endpoint'):
            continue
        estudios.append((
            r.get('Document UUID'), s, r.get('AdministrativeData.Endpoint'),
            tox, efecto, r.get('MaterialsAndMethods.TestAnimals.Species'),
        ))
    db.executemany(
        'INSERT INTO estudios (uuid, sustancia, tipo, toxicidad, efecto, especie)'
        ' VALUES (?,?,?,?,?,?)', estudios)
    print(f'estudios: {len(estudios)}')

    db.commit()
    db.execute('VACUUM')
    db.close()


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'food additives')
