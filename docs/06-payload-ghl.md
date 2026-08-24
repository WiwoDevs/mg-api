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
