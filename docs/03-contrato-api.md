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

Máximo 32 KB. **Cualquier campo no listado aquí hace que la petición se rechace con 400.**

```json
{
  "nombre": "Juan Perez Soto",
  "rut": "12.345.678-5",
  "email": "juan.perez@ejemplo.cl",
  "telefono": "+56912345678",
  "vehiculo": {
    "patente": "BCDF12",
    "marca": "Toyota",
    "modelo": "Yaris",
    "anio": 2019
  },
  "motivo": "El vehiculo presenta una falla recurrente en el sistema de frenos.",
  "referenciaGhl": "opcional-id-del-contacto"
}
```

| Campo | Reglas |
|---|---|
| `nombre` | 2 a 120 caracteres |
| `rut` | RUT chileno válido por módulo 11. Se aceptan puntos y guion; se normalizan |
| `email` | Formato de correo, máximo 200 caracteres. Se pasa a minúsculas |
| `telefono` | 8 a 20 dígitos, opcionalmente con `+`, espacios o guiones |
| `vehiculo.patente` | Formatos chilenos: `AABB12`, `AA1234` o `AAA12`. Se pasa a mayúsculas |
| `vehiculo.marca` | 1 a 60 caracteres |
| `vehiculo.modelo` | 1 a 60 caracteres |
| `vehiculo.anio` | Entre 1900 y el año próximo |
| `motivo` | 10 a 2000 caracteres |
| `referenciaGhl` | Opcional, hasta 120 caracteres |

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
{ "error": "entrada_invalida", "campos": [{ "campo": "rut", "mensaje": "RUT invalido" }] }
```

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
4. Cuerpo: el JSON de arriba, mapeando los campos del formulario.
5. Si GHL entrega un rango fijo de IP de salida, cargarlo en `IPS_GHL`. Si no lo entrega, dejar la
   variable vacía: la clave es el candado real.

Tras 10 llamadas seguidas con clave incorrecta, la IP queda bloqueada 15 minutos. Si al configurar el
webhook aparece un 429 persistente, es eso: corregir la clave y esperar a que expire el bloqueo.

Tratar 202 igual que 200: en ambos casos el reclamo fue aceptado.

## Lo que falta definir

El cuerpo que espera la API externa todavía no está definido. Hoy `src/upstream/cliente.ts` reenvía el
reclamo validado tal cual. Cuando se conozca el formato real, la traducción va ahí y solo ahí.
