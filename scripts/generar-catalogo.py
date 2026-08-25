#!/usr/bin/env python3
"""Genera src/catalogo/catalogo.json a partir de los Excel de MG.

Fuentes (en la raiz del proyecto):
  - Modelos.xlsx                      series y sus variantes
  - SUCURSALES ACTIVAS POSVENTA.xlsx  concesionarios y sus sucursales de posventa

Se usa la planilla de POSVENTA y no la de Lead form: esta API recibe reclamos,
que son postventa. La de Lead form cubre puntos de venta, que no coinciden.

Uso:  python3 scripts/generar-catalogo.py
"""
import json
import re
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / 'src' / 'catalogo' / 'catalogo.json'
CONTRATO = RAIZ / 'docs' / 'contrato-mgapi.json'
WEBHOOK = RAIZ / 'docs' / 'webhook-ghl.json'

# Campos personalizados que GHL tiene creados hoy, tomados del payload anterior.
GHL_CAMPOS_MODELO = [
    'mg4', 'mg4_xpower', 'mg3', 'mg5', 'mg_hs', 'mg_gt', 'mg_zs',
    'mg_zx', 'mg_one', 'mg_rx5', 'mg_rx9', 'mg_marvel_r', 'mg_zs_ev',
]
GHL_CAMPOS_SUCURSAL = [
    'antivero', 'autosummit', 'bruno_fritsch', 'carmona', 'cartoni', 'crculo_autos',
    'difor', 'forcenter', 'fronza', 'movicenter', 'pompeyo_carrasco', 'portillo',
    'salazar_israel', 'servimaq', 'sociedad_real',
]
MOTIVO_CAMPO_SOBRA = {
    'crculo_autos': 'la planilla de posventa marca Circulo para eliminar',
    'movicenter': 'Movicenter es una sucursal de Pompeyo Carrasco, no un concesionario',
}

NS = {
    'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'rel': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'pkg': 'http://schemas.openxmlformats.org/package/2006/relationships',
}

# Nombre corto en la planilla -> campo personalizado que GHL ya tiene creado.
# Hace falta porque la planilla abrevia ("BRUNO") y el formulario usa el nombre
# completo ("Bruno Fritsch"), de donde GHL derivo el slug.
CAMPO_GHL_CONCESIONARIO = {
    'ANTIVERO': 'antivero',
    'AUTOSUMMIT': 'autosummit',
    'BRUNO': 'bruno_fritsch',
    'CARMONA': 'carmona',
    'CARTONI': 'cartoni',
    'DIFOR': 'difor',
    'FORCENTER': 'forcenter',
    'FRONZA': 'fronza',
    'ITALMOTORS': 'italmotors',
    'POMPEYO': 'pompeyo_carrasco',
    'PORTILLO': 'portillo',
    'SALAZAR': 'salazar_israel',
    'SERVIMAQ': 'servimaq',
    'SOCIEDAD REAL': 'sociedad_real',
}

# Nombre comercial completo, para lo que se guarda en Zoho.
NOMBRE_COMPLETO = {
    'BRUNO': 'Bruno Fritsch',
    'POMPEYO': 'Pompeyo Carrasco',
    'SALAZAR': 'Salazar Israel',
    'SOCIEDAD REAL': 'Sociedad Real',
    'ANTIVERO': 'Antivero',
    'AUTOSUMMIT': 'AutoSummit',
    'CARMONA': 'Carmona',
    'CARTONI': 'Cartoni',
    'DIFOR': 'Difor',
    'FORCENTER': 'Forcenter',
    'FRONZA': 'Fronza',
    'ITALMOTORS': 'Italmotors',
    'PORTILLO': 'Portillo',
    'SERVIMAQ': 'Servimaq',
}

# Serie de la planilla -> campo personalizado que GHL ya tiene creado.
# Las series sin entrada aqui no tienen campo en GHL todavia (ver docs/06).
CAMPO_GHL_SERIE = {
    'MG3': 'mg3',
    'MG4': 'mg4',
    'MG5': 'mg5',
    'MGGT': 'mg_gt',
    'MGHS': 'mg_hs',
    'MGRX5': 'mg_rx5',
    'MGRX9': 'mg_rx9',
    'MGZS': 'mg_zs',
    'MGZX': 'mg_zx',
    'MG One': 'mg_one',
    'MARVELR': 'mg_marvel_r',
    'ZSEV': 'mg_zs_ev',
}

# Filas que son anotaciones del equipo, no datos.
A_ELIMINAR = re.compile(r'HAY QUE ELIMINARLO', re.I)
ANOTACION = re.compile(r'\s*-?\s*\(?HAY QUE (AGREGAR|ELIMINARLO)\)?', re.I)


def slug(texto: str) -> str:
    """Reproduce como GHL arma el slug: elimina los acentuados, no los transcribe."""
    sin_acentos = ''.join(
        c for c in texto if unicodedata.normalize('NFD', c)[0] == c and not unicodedata.combining(c)
    )
    return re.sub(r'[^a-z0-9]+', '_', sin_acentos.lower()).strip('_')


def _cadenas(z):
    if 'xl/sharedStrings.xml' not in z.namelist():
        return []
    raiz = ET.fromstring(z.read('xl/sharedStrings.xml'))
    return [
        ''.join(t.text or '' for t in si.iter(f'{{{NS["main"]}}}t'))
        for si in raiz.findall('main:si', NS)
    ]


def _columna(ref: str) -> int:
    n = 0
    for c in re.match(r'([A-Z]+)', ref).group(1):
        n = n * 26 + (ord(c) - 64)
    return n - 1


def leer_primera_hoja(ruta: Path) -> list[list[str]]:
    """Devuelve las filas no vacias de la primera hoja, como listas de texto."""
    with zipfile.ZipFile(ruta) as z:
        compartidas = _cadenas(z)
        libro = ET.fromstring(z.read('xl/workbook.xml'))
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        destinos = {r.get('Id'): r.get('Target') for r in rels.findall('pkg:Relationship', NS)}
        primera = libro.find('main:sheets', NS)[0]
        destino = destinos[primera.get(f'{{{NS["rel"]}}}id')]
        if not destino.startswith('xl/'):
            destino = 'xl/' + destino.lstrip('/')

        hoja = ET.fromstring(z.read(destino))
        filas = []
        for fila in hoja.iter(f'{{{NS["main"]}}}row'):
            celdas = {}
            for celda in fila.findall('main:c', NS):
                v = celda.find('main:v', NS)
                if v is None:
                    continue
                texto = compartidas[int(v.text)] if celda.get('t') == 's' else (v.text or '')
                if texto.strip():
                    celdas[_columna(celda.get('r'))] = texto.strip()
            if celdas:
                filas.append([celdas.get(i, '') for i in range(max(celdas) + 1)])
        return filas


def construir_modelos() -> list[dict]:
    filas = leer_primera_hoja(RAIZ / 'Modelos.xlsx')[1:]
    series: dict[str, list[str]] = {}
    for fila in filas:
        serie = fila[0] if fila else ''
        variante = fila[1] if len(fila) > 1 else ''
        if serie and variante:
            series.setdefault(serie, []).append(variante)

    return [
        {
            'serie': serie,
            'slug': slug(serie),
            'campoGhl': CAMPO_GHL_SERIE.get(serie),
            'variantes': sorted(set(variantes)),
        }
        for serie, variantes in sorted(series.items())
    ]


def construir_concesionarios() -> list[dict]:
    filas = leer_primera_hoja(RAIZ / 'SUCURSALES ACTIVAS POSVENTA.xlsx')[1:]
    concesionarios: dict[str, list[str]] = {}
    for fila in filas:
        crudo = fila[0] if fila else ''
        sucursal = fila[1] if len(fila) > 1 else ''
        if not crudo or A_ELIMINAR.search(crudo):
            continue
        nombre = ANOTACION.sub('', crudo).strip().rstrip('-').strip()
        if sucursal:
            concesionarios.setdefault(nombre, []).append(sucursal)

    return [
        {
            'nombre': NOMBRE_COMPLETO.get(clave, clave.title()),
            'clavePlanilla': clave,
            'campoGhl': CAMPO_GHL_CONCESIONARIO.get(clave),
            'sucursales': sorted(set(sucursales)),
        }
        for clave, sucursales in sorted(concesionarios.items())
    ]


def calcular_desajustes(modelos: list[dict], concesionarios: list[dict]) -> dict:
    """Compara el catalogo oficial con los campos que GHL tiene creados hoy."""
    esperados_serie = {m['campoGhl'] for m in modelos if m['campoGhl']}
    esperados_dealer = {c['campoGhl'] for c in concesionarios if c['campoGhl']}

    return {
        'seriesSinCampoEnGhl': [
            {'serie': m['serie'], 'variantes': len(m['variantes'])}
            for m in modelos
            if not m['campoGhl']
        ],
        'camposDeModeloQueSobran': [
            {
                'campo': campo,
                'motivo': 'es una variante de MG4, no una serie: viaja en cf_model, no necesita campo propio',
            }
            for campo in GHL_CAMPOS_MODELO
            if campo not in esperados_serie
        ],
        'concesionariosSinCampoEnGhl': [
            c['nombre'] for c in concesionarios if c['campoGhl'] not in GHL_CAMPOS_SUCURSAL
        ],
        'camposDeSucursalQueSobran': [
            {
                'campo': campo,
                'motivo': MOTIVO_CAMPO_SOBRA.get(campo, 'no corresponde a ningun concesionario activo en posventa'),
            }
            for campo in GHL_CAMPOS_SUCURSAL
            if campo not in esperados_dealer
        ],
    }


def main() -> None:
    modelos = construir_modelos()
    concesionarios = construir_concesionarios()

    catalogo = {
        'fuentes': ['Modelos.xlsx', 'SUCURSALES ACTIVAS POSVENTA.xlsx'],
        'modelos': modelos,
        'concesionarios': concesionarios,
    }
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(json.dumps(catalogo, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    contrato = json.loads((RAIZ / 'scripts' / 'contrato.plantilla.json').read_text(encoding='utf-8'))
    contrato['catalogo'] = catalogo
    contrato['desajustesConGhl'] = calcular_desajustes(modelos, concesionarios)
    CONTRATO.write_text(json.dumps(contrato, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    # El cuerpo suelto, listo para pegar en la accion de webhook de GHL.
    plantilla = contrato['payloadDesdeGhl']['plantilla']
    WEBHOOK.write_text(json.dumps(plantilla, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'{SALIDA.relative_to(RAIZ)}')
    print(f'  {len(modelos)} series, {sum(len(m["variantes"]) for m in modelos)} variantes')
    print(f'  {len(concesionarios)} concesionarios, {sum(len(c["sucursales"]) for c in concesionarios)} sucursales')
    print(f'{WEBHOOK.relative_to(RAIZ)}')
    print(f'{CONTRATO.relative_to(RAIZ)}')
    for clave, valor in contrato['desajustesConGhl'].items():
        if valor:
            print(f'  {clave}: {len(valor)}')


if __name__ == '__main__':
    main()
