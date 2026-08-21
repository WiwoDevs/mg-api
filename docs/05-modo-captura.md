# Modo captura

Modo temporal para descubrir en qué formato exacto GHL manda los datos, antes de escribir la limpieza
de la ingesta.

Mientras esté encendido, `POST /v1/captura` está **abierto: no pide clave** y devuelve todo lo que
recibe. Es deliberadamente inseguro, y por eso se apaga solo.

## Encender

En `.env`:

```bash
MODO_CAPTURA=true
CAPTURA_MAXIMA=50
```

```bash
docker compose up -d
```

Al arrancar, el log deja una advertencia. En GHL, apuntar el webhook a
`https://<DOMINIO>/v1/captura` y disparar la automatización con un contacto de prueba.

## Qué devuelve

```json
{
  "recibido": {
    "numero": 1,
    "recibidoEn": "2026-08-21T14:03:11.482Z",
    "metodo": "POST",
    "ip": "34.72.15.9",
    "cabeceras": { "content-type": "application/json", "user-agent": "GHL/1.0" },
    "cuerpoCrudo": "{\"contact_id\":\"abc\",\"first_name\":\"Juan\"}",
    "cuerpo": { "contact_id": "abc", "first_name": "Juan" }
  },
  "captura": { "numero": 1, "restantes": 49 }
}
```

- `ip` es de dónde vino de verdad. Sirve para saber si GHL tiene rango fijo y llenar `IPS_GHL`.
- `cabeceras` trae todo lo que mandó GHL, incluidas sus propias cabeceras de firma si las tiene. Con eso
  se decide si se puede activar HMAC sin poner n8n en el medio.
- `cuerpoCrudo` es el texto exacto. `cuerpo` es ese texto parseado como JSON, o `null` si GHL manda
  formulario en vez de JSON — que también es un dato útil.

Acepta cualquier `Content-Type`: JSON, formulario o texto plano.

## Releer las capturas

GHL no siempre muestra el cuerpo de la respuesta. La lectura sí exige la clave:

```bash
curl -s -H "X-Mgapi-Key: $MGAPI_KEY" https://<DOMINIO>/v1/capturas | jq
```

También quedan en el log del servidor:

```bash
docker compose logs mgapi | grep modo_captura_peticion_recibida
```

## Por qué se apaga solo

Un endpoint abierto que devuelve todo lo que recibe es un problema el día que alguien se olvida de
cerrarlo. Por eso no depende de la memoria de nadie: tras `CAPTURA_MAXIMA` peticiones deja de capturar y
responde `410 captura_agotada`. Para seguir capturando hay que volver a intervenir a propósito.

Aun así, apagarlo apenas se tenga el formato:

```bash
# en .env
MODO_CAPTURA=false
```

```bash
docker compose up -d
```

## Lo que el modo captura NO toca

- `/v1/reclamos` sigue exigiendo clave, allowlist, bloqueo por fuerza bruta y `Content-Type` JSON. Hay
  pruebas que lo verifican con el modo captura encendido ([`test/captura.test.ts`](../test/captura.test.ts)).
- La clave propia nunca se devuelve: si el llamante manda `X-Mgapi-Key`, se responde `[oculto]`.
- Las capturas viven en memoria, no en disco. Un reinicio las borra.

## Cuidado con la allowlist

Si `IPS_GHL` tiene reglas, Caddy bloquea antes de que la petición llegue a `/v1/captura`. Durante la
captura esa variable va vacía — que es su valor por defecto.

## Después

Con el payload real en mano, lo que sigue es el mapa de campos: de qué campo de GHL sale cada dato del
reclamo, cómo se limpia, y qué se descarta. Todo lo que no esté en ese mapa no viaja a la API externa.
