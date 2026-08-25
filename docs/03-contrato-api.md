# Contrato de la API

Base: `https://<DOMINIO>/v1`

## POST /reclamos

Ingresa un reclamo. Es el único endpoint público.

### Cabeceras

| Cabecera | Obligatoria | Descripción |
|---|---|---|
| `Content-Type: application/json` | Sí | Otro tipo devuelve 415 |
| `X-Mgapi-Key` | Sí | Clave compartida con GHL |
| `X-Mgapi-Timestamp` | Solo con `HMAC_ACTIVO=true` | Segundos Unix, tolerancia de 300 s |
| `X-Mgapi-Firma` | Solo con `HMAC_ACTIVO=true` | `HMAC-SHA256(HMAC_SECRETO, "<timestamp>.<cuerpo crudo>")` en hexadecimal |

### Cuerpo

Máximo 32 KB. Es el cuerpo crudo de GHL: las 42 variables del contacto, una por campo. Está listo para
pegar en [`docs/webhook-ghl.json`](webhook-ghl.json), y el contrato completo con la regla de selección
está en [Payload de GHL](06-payload-ghl.md).

mgAPI hace la limpieza: elige la variante y la sucursal que corresponden al modelo y al concesionario
declarados, valida cada campo, resuelve todo contra el catálogo oficial de MG y traduce a los nombres
`cf_*` de Zoho. GHL no arma nada.

| Campo de GHL | Reglas |
|---|---|
| `contacto.first_name` | 2 a 60 caracteres |
| `contacto.last_name` | 2 a 60 caracteres |
| `contacto.rut` | RUT chileno válido por módulo 11. Se aceptan puntos y guion; se normalizan |
| `contacto.email` | Formato de correo, máximo 200 caracteres. Se pasa a minúsculas |
| `contacto.phone` | 8 a 20 dígitos, opcionalmente con `+`, espacios o guiones |
| `vehiculo.patente_del_vehculo` | Formatos chilenos: `AABB12`, `AA1234` o `AAA12`. Se pasa a mayúsculas |
| `vehiculo.modelo_del_auto` | Debe existir en el catálogo. Decide qué campo de variante se lee |
| `vehiculo.ao_del_vehculo` | Entre 1900 y el año próximo |
| `vehiculo.vin_del_vehculo` | Opcional. 17 caracteres, sin I, O ni Q |
| `vehiculo.kilometraje` | Opcional. Entero; acepta separadores de miles y los quita |
| `variante_por_modelo` | Grupo abierto. Se lee **solo** el campo del modelo declarado |
| `concesionario.nombre_convesionario` | Debe existir entre los concesionarios activos en posventa |
| `sucursal_por_concesionario` | Grupo abierto. Se lee **solo** el campo del concesionario declarado |
| `reclamo.descripcin_del_problema` | 10 a 2000 caracteres |
| `reclamo.imgenes_o_respaldo` | Opcional. URL absoluta |
| `ghl_contact_id` | Opcional, hasta 120 caracteres |

Los objetos de campos fijos son estrictos: un campo no declarado devuelve 400. Los dos grupos son
abiertos, para que GHL pueda mandar un modelo nuevo antes de que exista en el catálogo sin que se caiga
el reclamo.

Un valor vacío, o un literal `{{contact.algo}}` que GHL no alcanzó a reemplazar, cuenta como ausente.

### Respuestas

**200 — entregado a la API externa.** Solo trae los campos de la lista blanca.

```json
{
  "estado": "recibido",
  "idCorrelacion": "b3f1...",
  "resumen": { "folio": "F-123", "estado": "ingresado" }
}
```

**202 — la API externa no estaba disponible; el reclamo quedó en la cola cifrada y se reintenta solo.**
Para GHL es un éxito: el reclamo no se perdió.

```json
{ "estado": "encolado", "idCorrelacion": "b3f1..." }
```

**400 — entrada inválida.** Se devuelve el nombre del campo y el motivo, nunca el valor recibido.

```json
{
  "error": "entrada_invalida",
  "campos": [
    { "campo": "variante_por_modelo.mg5", "mensaje": "no hay variante cargada para el modelo MG5" }
  ]
}
```

El nombre del campo apunta al lugar exacto de GHL que hay que corregir.

**Otros códigos**

| Código | Cuerpo | Significado |
|---|---|---|
| 401 | `{"error": "no_autorizado"}` | Clave ausente, incorrecta, firma inválida, o IP fuera de la allowlist |
| 413 | `{"error": "cuerpo_demasiado_grande"}` | Sobre 32 KB |
| 415 | `{"error": "tipo_no_soportado"}` | `Content-Type` distinto de `application/json` |
| 422 | `{"error": "reclamo_rechazado"}` | La API externa lo rechazó de forma definitiva |
| 429 | `{"error": "demasiadas_solicitudes"}` | Límite de tasa por IP, o IP bloqueada por claves incorrectas seguidas |
| 429 | `{"error": "presupuesto_agotado"}` | Se agotó el presupuesto diario de llamadas |
| 500 | `{"error": "error_interno"}` | Falla nuestra. El detalle queda solo en los logs |

Los mensajes de error son genéricos a propósito. El detalle real queda en el log del servidor,
identificable por `idCorrelacion`.

## GET /salud

Solo alcanzable desde dentro del servidor: Caddy no lo proxea. Sin autenticación.

```json
{ "estado": "ok", "pendientes": 0 }
```

## Configuración en GHL

1. En la automatización, agregar una acción de **Webhook**.
2. Método `POST`, URL `https://<DOMINIO>/v1/reclamos`.
3. Cabeceras: `Content-Type: application/json` y `X-Mgapi-Key: <valor de MGAPI_KEY>`.
4. Cuerpo: pegar [`docs/webhook-ghl.json`](webhook-ghl.json) tal cual.
5. Si GHL entrega un rango fijo de IP de salida, cargarlo en `IPS_GHL`. Si no lo entrega, dejar la
   variable vacía: la clave es el candado real.

Tras 10 llamadas seguidas con clave incorrecta, la IP queda bloqueada 15 minutos. Si al configurar el
webhook aparece un 429 persistente, es eso: corregir la clave y esperar a que expire el bloqueo.

Tratar 202 igual que 200: en ambos casos el reclamo fue aceptado.

## Lo que falta definir

El cuerpo que espera la API externa todavía no está definido. Hoy `src/upstream/cliente.ts` reenvía el
reclamo validado tal cual. Cuando se conozca el formato real, la traducción va ahí y solo ahí.
