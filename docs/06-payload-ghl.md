# Payload de GHL

Contrato de lo que GoHighLevel debe enviar a mgAPI, y a qué campo de Zoho termina yendo cada dato.

## El problema del payload anterior

Antes GHL armaba el JSON de Zoho por su cuenta, y para dos campos concatenaba muchas variables
separadas por un carácter invisible:

```json
"cf_model": "{{contact.mg4}}​{{contact.mg4_xpower}}​{{contact.mg3}}​..."
```

La idea era que solo uno de esos campos tuviera valor, así la concatenación devolvía ese único valor.
**Pero no es lo que pasa.** El contacto de GHL acumula histórico: si la persona ya reportó un MG3 y hoy
reporta un MG4, los dos campos siguen llenos. La concatenación entonces produce `MG3MG5` pegados, más
los caracteres invisibles de las variables vacías, y eso es lo que se guarda en Zoho.

Es un fallo silencioso: nada avisa, y el dato queda mal.

## Los dos campos que se confundían

Esto es lo que hace que el problema se resuelva solo:

| Campo Zoho | Qué es de verdad | Ejemplo |
|---|---|---|
| `cf_series` | **El modelo** | `MG4` |
| `cf_model` | **La variante de ese modelo** | `XPOWER` |

Los 13 campos `mg4`, `mg3`, `mg_zs`… no son 13 modelos posibles. Cada uno guarda **la variante de su
propio modelo**: `contact.mg4` tiene la variante del MG4, `contact.mg_zs` la del ZS.

## La regla de selección

No hay que desempatar nada, y el histórico acumulado deja de importar.

> **La variante correcta es la del campo cuyo nombre corresponde al modelo declarado en
> `modelo_del_auto`.**

Si `modelo_del_auto` dice `MG4`, se lee `modelo_mg.mg4` y los demás doce se ignoran, estén llenos o
vacíos. Un MG3 viejo arrastrado de un reclamo anterior no interfiere: nunca se lee.

Selección por nombre, no por contenido. Determinista, sin ambigüedad y sin reglas de prioridad
arbitrarias.

### Cómo se deriva el nombre del campo

GHL genera el slug **eliminando los caracteres acentuados**, no transcribiéndolos. Verificado contra los
nombres reales del proyecto:

| Nombre en el formulario | Slug de GHL |
|---|---|
| `año del vehículo` | `ao_del_vehculo` |
| `descripción del problema` | `descripcin_del_problema` |
| `Círculo Autos` | `crculo_autos` |
| `MG4 XPOWER` | `mg4_xpower` |
| `MG ZS EV` | `mg_zs_ev` |

La regla: quitar los caracteres acentuados, pasar a minúsculas, y todo lo que no sea letra o número se
vuelve `_`.

mgAPI va a llevar **un mapa explícito** de valor a campo, no solo esta derivación automática. Si el valor
de `modelo_del_auto` no corresponde a ningún campo conocido, tiene que fallar con un error claro en vez
de mandar la variante vacía a Zoho. Un mapa explícito hace visible ese caso; la derivación sola lo
escondería.

### Las sucursales siguen la misma forma — falta confirmar

`nombre_convesionario` es el concesionario (`Bruno Fritsch`) y los 15 campos `sucursales_*` guardan **la
sucursal de ese concesionario**: `sucursales_bruno_fritsch` tiene la sucursal de Bruno Fritsch. Misma
regla, mismo mapa.

**Esto es una deducción por paralelismo con el modelo, no está confirmado.** Si las sucursales funcionan
distinto, hay que decirlo antes de escribir la limpieza.

## Lo que GHL debe enviar

Pegar tal cual en el cuerpo del webhook de GHL. Son las mismas 42 variables, sin concatenar.

```json
{
  "ghl_contact_id": "{{contact.id}}",

  "contacto": {
    "first_name": "{{contact.first_name}}",
    "last_name": "{{contact.last_name}}",
    "rut": "{{contact.rut}}",
    "phone": "{{contact.phone}}",
    "email": "{{contact.email}}"
  },

  "vehiculo": {
    "patente_del_vehculo": "{{contact.patente_del_vehculo}}",
    "ao_del_vehculo": "{{contact.ao_del_vehculo}}",
    "vin_del_vehculo": "{{contact.vin_del_vehculo}}",
    "kilometraje": "{{contact.kilometraje}}",
    "modelo_del_auto": "{{contact.modelo_del_auto}}"
  },

  "variante_por_modelo": {
    "mg4": "{{contact.mg4}}",
    "mg4_xpower": "{{contact.mg4_xpower}}",
    "mg3": "{{contact.mg3}}",
    "mg5": "{{contact.mg5}}",
    "mg_hs": "{{contact.mg_hs}}",
    "mg_gt": "{{contact.mg_gt}}",
    "mg_zs": "{{contact.mg_zs}}",
    "mg_zx": "{{contact.mg_zx}}",
    "mg_one": "{{contact.mg_one}}",
    "mg_rx5": "{{contact.mg_rx5}}",
    "mg_rx9": "{{contact.mg_rx9}}",
    "mg_marvel_r": "{{contact.mg_marvel_r}}",
    "mg_zs_ev": "{{contact.mg_zs_ev}}"
  },

  "concesionario": {
    "nombre_convesionario": "{{contact.nombre_convesionario}}"
  },

  "sucursal_por_concesionario": {
    "antivero": "{{contact.sucursales_antivero}}",
    "autosummit": "{{contact.sucursales_autosummit}}",
    "bruno_fritsch": "{{contact.sucursales_bruno_fritsch}}",
    "carmona": "{{contact.sucursales_carmona}}",
    "cartoni": "{{contact.sucursales_cartoni}}",
    "crculo_autos": "{{contact.sucursales_crculo_autos}}",
    "difor": "{{contact.sucursales_difor}}",
    "forcenter": "{{contact.sucursales_forcenter}}",
    "fronza": "{{contact.sucursales_fronza}}",
    "movicenter": "{{contact.sucursales_movicenter}}",
    "pompeyo_carrasco": "{{contact.sucursales_pompeyo_carrasco}}",
    "portillo": "{{contact.sucursales_portillo}}",
    "salazar_israel": "{{contact.sucursales_salazar_israel}}",
    "servimaq": "{{contact.sucursales_servimaq}}",
    "sociedad_real": "{{contact.sucursales_sociedad_real}}"
  },

  "reclamo": {
    "descripcin_del_problema": "{{contact.descripcin_del_problema}}",
    "imgenes_o_respaldo": "{{contact.imgenes_o_respaldo}}"
  }
}
```

Los grupos se llaman `variante_por_modelo` y `sucursal_por_concesionario` porque eso es lo que son: la
clave dice de qué modelo o concesionario es cada valor. El nombre deja escrita la regla de selección.

### Sobre los nombres con errores de tipeo

`patente_del_vehculo`, `ao_del_vehculo`, `descripcin_del_problema`, `imgenes_o_respaldo`,
`crculo_autos` y `nombre_convesionario` están escritos así a propósito: son los slugs reales que genera
GHL. **No corregirlos.** Si se arreglan, GHL manda el campo vacío y el dato se pierde en silencio.

`nombre_convesionario` además tiene un error de tipeo humano en el formulario (falta la `c` de
"concesionario"). Si algún día se corrige en GHL, hay que corregirlo también aquí.

## Traducción a Zoho

| Campo en Zoho | Sale de | Limpieza que aplica mgAPI |
|---|---|---|
| `cf_first_name` | `contacto.first_name` | Recorte de espacios |
| `cf_last_name` | `contacto.last_name` | Recorte de espacios |
| `cf_id_number` | `contacto.rut` | Normalización y validación por módulo 11 |
| `cf_mobile` | `contacto.phone` | Normalización a formato internacional |
| `email` | `contacto.email` | Minúsculas y validación de formato |
| `cf_license_plate` | `vehiculo.patente_del_vehculo` | Mayúsculas, sin guiones, validación de formato chileno |
| `cf_model_year` | `vehiculo.ao_del_vehculo` | Entero dentro de un rango razonable |
| `cf_vin` | `vehiculo.vin_del_vehculo` | Mayúsculas, 17 caracteres |
| `cf_mileage` | `vehiculo.kilometraje` | Entero, sin puntos ni separadores |
| `cf_series` | `vehiculo.modelo_del_auto` | Valor del mapa de modelos conocidos |
| `cf_model` | `variante_por_modelo[slug(modelo_del_auto)]` | **Selección por nombre**, no por contenido |
| `cf_website_dealer` | `concesionario.nombre_convesionario` | Recorte de espacios |
| `cf_website_dealer_pos` | `sucursal_por_concesionario[slug(nombre_convesionario)]` | **Selección por nombre** |
| `description` | `reclamo.descripcin_del_problema` | Recorte de espacios |
| `cf_attachment_url` | `reclamo.imgenes_o_respaldo` | Validación de URL |
| `cf_website_id` | `ghl_contact_id` | Se pasa tal cual |

## Catálogo oficial

Las series, variantes, concesionarios y sucursales válidos salen de los Excel de MG y viven en
[`src/catalogo/catalogo.json`](../src/catalogo/catalogo.json). Se regeneran con `npm run catalogo`; no
se editan a mano.

- `Modelos.xlsx` → **17 series** y **74 variantes**.
- `SUCURSALES ACTIVAS POSVENTA.xlsx` → **14 concesionarios** y **47 sucursales**.

Se usa la planilla de posventa y no la de Lead form: esta API recibe reclamos, que son postventa. Las
dos listas no coinciden — Lead form tiene 13 concesionarios y otros puntos de venta.

La planilla trae dos anotaciones del equipo que el generador respeta: **Círculo queda fuera** (marcado
para eliminar) e **Italmotors queda dentro** con Talca y Linares (marcado para agregar).

**El catálogo canoniza, no bloquea.** Si el valor existe, se reemplaza por el del catálogo —así a Zoho
llega `LA FLORIDA` y no `La Florida - Vicuña Mackenna 9085`. Si no existe, **viaja tal cual y queda una
advertencia**.

El formulario es la fuente: si ofrece una opción, es legítima, y el desactualizado es el Excel. Perder
un reclamo por esa diferencia es peor que aceptar un valor sin canonizar. Las advertencias se van
juntando y muestran qué hay que alinear.

## Desajustes con los campos actuales de GHL

Comparando el catálogo contra los campos que GHL tiene creados hoy. La lista completa y actualizada está
en [`docs/contrato-mgapi.json`](contrato-mgapi.json), en `desajustesConGhl`.

**Faltan crear en GHL** — cinco series sin campo de variante. Quien tenga uno de estos autos no puede
declarar su variante:

| Serie | Variantes que existen |
|---|---|
| MG6 | 4 |
| MG S5 EV | 3 |
| MG 4 Urban EV | 2 |
| MG CYBERSTER | 2 |
| MGRX8 | 2 |

También falta el concesionario **Italmotors** (Talca y Linares).

**Sobran en GHL:**

| Campo | Por qué |
|---|---|
| `mg4_xpower` | `MG 4 XPOWER` es una variante de la serie MG4, no una serie. Viaja en `cf_model` |
| `crculo_autos` | La planilla de posventa marca Círculo para eliminar |
| `movicenter` | Movicenter es una **sucursal de Pompeyo Carrasco**, no un concesionario |

`mg4_xpower` y `movicenter` son el mismo error de fondo: se creó un campo de nivel superior para algo
que en realidad es una opción dentro de otro. Es la misma confusión entre modelo y variante que había en
el payload anterior.

## La llamada a la función de Zoho

```
POST https://www.zohoapis.com/crm/v7/functions/zohodeskcasewebsiteapi/actions/execute
     ?auth_type=oauth&case=<el caso en JSON>

Authorization: Zoho-oauthtoken <access token>
Content-Type: application/json

{ "id": "...", "name": "...", "email": "...", "phone": "..." }
```

**El caso viaja como argumento en la URL, no como cuerpo.** Es la causa probable del error
`INVALID_DATA — "Value is empty and 'get' function cannot be applied"`: la función declara un argumento
`case` y hace `.get()` sobre él, pero el argumento nunca llegaba, así que operaba sobre nada.

En la configuración anterior el caso estaba en la sección de pares clave/valor del cuerpo, mientras el
cuerpo crudo tenía otro JSON. GHL manda uno de los dos, y mandaba el crudo.

**Zoho responde `HTTP 200` aunque la función falle**, con el error dentro del cuerpo. Sin revisarlo, un
reclamo rechazado se daría por entregado. `INVALID_DATA`, `MANDATORY_NOT_FOUND` e `INVALID_URL_PATTERN`
se tratan como definitivos; el resto se reintenta desde la cola.

### Sobre la espera de 5 segundos

El flujo anterior esperaba entre pedir el token y llamar a la función, porque GHL encadena pasos sin
garantizar que la respuesta del anterior esté guardada. **Aquí esa espera no hace falta**: mgAPI espera
de verdad la respuesta del token antes de seguir, así que no hay carrera que evitar.

Queda como `ZOHO_ESPERA_MS`, en cero por defecto. Si en pruebas resulta que Zoho sí necesita un margen,
se sube sin tocar código. Vale la pena dejarlo en cero: son 5 segundos que GHL pasa esperando en cada
reclamo.

## Las opciones reales del formulario

El desplegable `nombre_convesionario` ofrece quince valores. Comparados con el catálogo de posventa,
tres están mal:

| Opción | Estado |
|---|---|
| `MOVICENTER` | **Es una sucursal de Pompeyo Carrasco, no un concesionario.** La API la resuelve con un alias para no rechazar el reclamo, pero hay que corregir el formulario |
| `CIRCULO AUTOS` | Ya no atiende posventa. Un reclamo con este valor se rechaza a propósito, para que se derive a un concesionario activo |
| *(falta)* `ITALMOTORS` | Atiende posventa en Talca y Linares, y no aparece entre las opciones |

Las otras doce resuelven correctamente contra el catálogo.

### Por qué `contact.*` y no `form.*` — decidido

El webhook anterior leía `{{form.*}}`, que habría sido mejor: el formulario trae solo lo que la persona
acaba de llenar, mientras que el contacto arrastra respuestas de reclamos anteriores. Habría eliminado
el histórico acumulado en el origen.

**No está disponible, así que se usa `contact.*`.** La selección por nombre deja de ser una segunda red y
pasa a ser la única defensa contra el histórico. Ya está implementada y probada, y es la razón por la
que el problema no llega a Zoho.

#### Qué tan lejos llega el histórico

Casi nada, y por dos razones que se refuerzan:

1. **La selección por nombre nunca lee el campo de otro modelo.** Si se declara MG4, `mg3` no se mira.
2. **Ninguna de las 74 variantes pertenece a más de una serie.** Aunque un valor de otro modelo llegara
   al campo equivocado, el catálogo lo rechazaría: `MG 4 XPOWER` solo existe en MG4, `NEW MG 3 HEV COM`
   solo en MG3.

Un modelo equivocado, entonces, no pasa.

Queda un solo caso, y es estrecho: **mismo modelo, variante distinta, campo en blanco.** Alguien reclamó
por un MG4 STANDARD, después cambió a un MG4 LUXURY, y en el reclamo nuevo deja la variante vacía:
`contact.mg4` conserva `STANDARD` y viaja como si fuera actual.

Si es el mismo auto de siempre, el valor viejo sigue siendo el correcto y no hay nada que arreglar. Solo
falla cuando la persona cambió de variante dentro del mismo modelo.

Hacer obligatoria la variante en el formulario lo cierra del todo, pero es higiene, no urgencia.

## Lo que falta para escribir la limpieza

1. **La lista exacta de opciones de `modelo_del_auto`.** Los valores literales del desplegable en GHL,
   para armar el mapa de modelo a campo. Sin esto hay que adivinar si dice `MG4`, `MG 4` o `Mg4`.
2. **La lista exacta de opciones de `nombre_convesionario`.** Lo mismo para los 15 concesionarios.
3. **Confirmar que las sucursales funcionan como los modelos** (ver arriba).
4. **Qué campos exige Zoho de verdad**, para decidir qué se rechaza y qué viaja incompleto.
5. **Qué hacer si el modelo declarado no tiene variante cargada.** ¿El reclamo entra sin variante o se
   rechaza?

Los puntos 1 y 2 salen de la configuración de los campos personalizados en GHL. Con eso y una captura
real, la limpieza se escribe completa.
