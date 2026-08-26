# Modos de prueba

Dos banderas para trabajar antes de tener todas las piezas: una para descubrir cómo manda los datos GHL,
otra para operar sin credenciales de Zoho.

Se pueden usar juntas. Es la configuración de la etapa actual del proyecto.

---

## Modo captura

Para descubrir en qué formato exacto GHL manda los datos, antes de escribir la limpieza de la ingesta.

Mientras esté encendido, `POST /v1/captura` está **abierto: no pide clave** y devuelve lo que recibe. Es
deliberadamente inseguro, y por eso se apaga solo.

### Encender

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

### Qué devuelve

**El cuerpo de la respuesta es exactamente el JSON que llegó**, sin envoltorio. Así se ve la integración
tal cual, y GHL puede volver a leer su propio payload sin desenvolver nada.

```http
POST /v1/captura
{"contact_id":"abc123","first_name":"Juan","customData":{"patente":"BCDF12"}}
```

```http
200 OK
x-captura-numero: 1
x-captura-restantes: 49
x-captura-ip: 34.72.15.9
x-captura-content-type: application/json

{"contact_id":"abc123","first_name":"Juan","customData":{"patente":"BCDF12"}}
```

El origen viaja en las cabeceras de respuesta para no ensuciar el cuerpo:

- `x-captura-ip` es de dónde vino de verdad. Sirve para saber si GHL tiene rango fijo y llenar `IPS_GHL`.
- `x-captura-content-type` delata si GHL manda JSON o formulario.

Si el cuerpo no era JSON, se devuelve el texto crudo tal cual. También es un dato útil.

### Releer las capturas con todo el detalle

El cuerpo de la respuesta va limpio, pero la captura completa —cabeceras de GHL incluidas, que es donde
se ve si trae firma propia— queda guardada. La lectura sí exige la clave:

```bash
curl -s -H "X-Mgapi-Key: $MGAPI_KEY" https://<DOMINIO>/v1/capturas | jq
```

También quedan en el log del servidor:

```bash
docker compose logs mgapi | grep modo_captura_peticion_recibida
```

### Por qué se apaga solo

Un endpoint abierto que devuelve todo lo que recibe es un problema el día que alguien se olvida de
cerrarlo. Por eso no depende de la memoria de nadie: tras `CAPTURA_MAXIMA` peticiones deja de capturar y
responde `410 captura_agotada`. Para seguir capturando hay que volver a intervenir a propósito.

Aun así, apagarlo apenas se tenga el formato: `MODO_CAPTURA=false` y `docker compose up -d`.

### Lo que el modo captura NO toca

- `/v1/reclamos` sigue exigiendo clave, allowlist, bloqueo por fuerza bruta y `Content-Type` JSON. Hay
  pruebas que lo verifican con el modo captura encendido ([`test/captura.test.ts`](../test/captura.test.ts)).
- La clave propia nunca se devuelve ni se guarda: si el llamante manda `X-Mgapi-Key`, queda `[oculto]`.
- Las capturas viven en memoria, no en disco. Un reinicio las borra.

### Cuidado con la allowlist

Si `IPS_GHL` tiene reglas, Caddy bloquea antes de que la petición llegue a `/v1/captura`. Durante la
captura esa variable va vacía, que es su valor por defecto.

---

## Diagnóstico de entrada

Para saber **qué llegó exactamente** cuando un reclamo se rechaza, sin depender de lo que muestre GHL.

```bash
DIAGNOSTICO_ENTRADA=true
```

Con eso, cada reclamo rechazado se guarda cifrado y se lee después:

```bash
curl -s -H "X-Mgapi-Key: $MGAPI_KEY" https://<DOMINIO>/v1/diagnostico | jq
```

```json
{
  "total": 2,
  "rechazos": [
    {
      "recibidoEn": "2026-08-26T23:03:36.000Z",
      "forma": "objeto con claves: body",
      "campos": [{ "campo": "contacto", "mensaje": "expected object, received undefined" }],
      "cuerpoRecibido": "{\"body\":\"{...}\"}"
    }
  ]
}
```

`forma` es la pieza clave: dice si el cuerpo llegó vacío, envuelto en otra clave, o con otros nombres
de campo, sin exponer ningún valor. **Esa línea sola aparece siempre en el log y en la respuesta 400,
esté el diagnóstico encendido o no**, porque no contiene datos personales.

### Cubre también el JSON roto

Un cuerpo que ni siquiera es JSON válido lo rechaza Fastify antes de llegar a la ruta. Antes eso
devolvía un `solicitud_invalida` genérico y no dejaba rastro. Ahora responde:

```json
{
  "error": "json_invalido",
  "pista": "suele pasar cuando el texto del usuario trae comillas y rompe el JSON"
}
```

y el cuerpo queda igualmente guardado. Es el caso típico cuando el origen arma el JSON pegando texto
del usuario sin escapar las comillas.

### Apagarlo

Guarda datos personales, así que es temporal. Se limita solo —últimos `DIAGNOSTICO_MAXIMO`, borrado a
las `DIAGNOSTICO_RETENCION_HORAS`— pero conviene apagarlo al terminar:

```bash
DIAGNOSTICO_ENTRADA=false
```

Un reclamo aceptado nunca se guarda: solo los rechazados.

---

## Modo sin Zoho

Para operar el endpoint real sin tener credenciales de Zoho todavía.

```bash
UPSTREAM_ACTIVO=false
```

Con eso, `UPSTREAM_URL` y las tres credenciales de Zoho pasan a ser opcionales y **la API arranca sin
ellas**. Con
`UPSTREAM_ACTIVO=true` vuelven a ser obligatorias y el proceso no parte si faltan: no se despliega a
producción a medias por accidente.

`/v1/reclamos` sigue funcionando completo —clave, perímetro, validación, normalización— pero en vez de
llamar a Zoho responde lo que le habría enviado:

```json
{
  "estado": "simulado",
  "idCorrelacion": "b3f1...",
  "mensaje": "UPSTREAM_ACTIVO=false: no se envio nada a Zoho.",
  "seHabriaEnviado": {
    "nombre": "Juan Perez Soto",
    "rut": "123456785",
    "email": "juan@ejemplo.cl",
    "vehiculo": { "patente": "BCDF12", "marca": "Toyota", "modelo": "Yaris", "anio": 2019 }
  }
}
```

`seHabriaEnviado` es el reclamo **ya limpio**: RUT sin puntos ni guion, email en minúsculas, patente en
mayúsculas. Sirve para revisar el resultado de la limpieza antes de que Zoho exista.

Una prueba verifica que con esta bandera no sale ninguna petición al exterior, espiando `fetch`
([`test/sin-zoho.test.ts`](../test/sin-zoho.test.ts)).

---

## Configuración de la etapa actual

```bash
MODO_CAPTURA=true       # descubrir el formato de GHL
UPSTREAM_ACTIVO=false   # no tocar Zoho todavia
IPS_GHL=                # vacia, o Caddy bloquea a GHL
```

Con esto no hace falta ni una credencial de Zoho para levantar el servicio.

## Después

Con el payload real en mano, lo que sigue es el mapa de campos: de qué campo de GHL sale cada dato del
reclamo, cómo se limpia, y qué se descarta. Todo lo que no esté en ese mapa no viaja a Zoho.
