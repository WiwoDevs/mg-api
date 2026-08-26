# Seguridad

Este documento describe qué se está protegiendo, de quién, y qué hace cada control.

## Qué hay que proteger

1. **Los datos personales del reclamante** — nombre, RUT, email, teléfono, y los datos del vehículo.
2. **Las credenciales de Zoho** — `client_secret` y `refresh_token`. Si se filtran, el atacante ya no
   necesita mgAPI: habla directo con el CRM en nuestro nombre. El refresh token **no expira**, así que
   una filtración dura hasta que alguien lo revoque a mano.
3. **La disponibilidad y el presupuesto** — si la API externa cobra por consulta, un abuso no solo
   filtra datos: vacía la cuenta.

## Modelo de amenazas

| Amenaza | Control principal | Dónde |
|---|---|---|
| Alguien que no es GHL llama al endpoint | Clave compartida verificada en tiempo constante + allowlist de IP en Caddy y en la aplicación | `src/security/autenticacion.ts`, `src/security/perimetro.ts`, `Caddyfile` |
| Fuerza bruta contra la clave | Bloqueo de la IP tras N intentos fallidos, y cada intento nuevo alarga el bloqueo | `src/security/perimetro.ts` |
| Suplantación de IP con `X-Forwarded-For` | La cabecera solo se cree si viene de la red interna donde está Caddy | `src/app.ts` |
| Captura y repetición de una llamada legítima | Firma HMAC con marca de tiempo y registro de firmas ya usadas | `src/security/autenticacion.ts` |
| Inyección de campos no previstos en el cuerpo | Esquema Zod estricto: campo no declarado es rechazo | `src/schemas/reclamo.ts` |
| Agotamiento de recursos con cuerpos gigantes | Límite de 32 KB por cuerpo | `src/app.ts` |
| Abuso masivo del endpoint | Límite de tasa por IP + presupuesto diario de llamadas a la API externa | `src/app.ts`, `src/upstream/cliente.ts` |
| Fuga de datos por los logs | Log automático de Fastify apagado + redacción de campos sensibles | `src/app.ts` |
| Fuga de datos en la respuesta a GHL | Lista blanca de campos: por defecto no sale nada | `src/schemas/reclamo.ts` |
| Fuga del token de la API externa por redirección | El cliente rechaza redirecciones en vez de seguirlas | `src/upstream/cliente.ts` |
| Lectura de la cola por acceso al disco | AES-256-GCM y permisos 0600 sobre el archivo | `src/cola/cola.ts` |
| Ejecución remota que intenta persistir | Contenedor de solo lectura, sin capacidades, usuario sin privilegios | `compose.yml` |
| Filtración de estructura interna de la API externa | Sus errores nunca se reenvían en crudo: se traducen a códigos propios | `src/routes/reclamos.ts` |

## Los controles, capa por capa

Cada capa asume que la anterior falló.

### 1. Borde: Caddy

HTTPS automático con Let's Encrypt y HSTS. La primera regla del `Caddyfile` es la allowlist: una
petición desde una IP que no es de GHL recibe 403 sin llegar nunca a la aplicación.

La aplicación no publica ningún puerto al host. Vive en una red interna de Docker y solo Caddy la
alcanza. `/salud` no se proxea: se consulta desde dentro del servidor.

La misma lista `IPS_GHL` la aplican Caddy y la aplicación. No son dos configuraciones que mantener en
sincronía: es una sola variable leída dos veces. Si Caddy se configura mal o alguien alcanza el
contenedor por otro camino, la aplicación sigue filtrando por su cuenta.

**Sobre `X-Forwarded-For`:** la aplicación solo cree esa cabecera cuando la petición viene de la red
interna donde vive Caddy (`PROXY_CONFIABLE`). Configurarla como `true` sería dejar que cualquiera
declare su propia IP en un header y con eso burle tanto el límite de tasa como la allowlist.

### 2. Identidad del llamante

**Lo primero, sin adornos: GHL no publica IP de salida estables.** Sus webhooks salen de rangos de
Google Cloud que cambian sin aviso. Por eso la allowlist de IP es una capa de apoyo, no el candado. El
candado es la clave compartida. Si alguna vez GHL entrega un rango fijo, se agrega a `IPS_GHL` y suma
una capa; mientras tanto, la lista puede quedar vacía y el sistema sigue siendo seguro por la clave.

La verificación corre en tres pasos, en este orden, y **antes de leer el cuerpo**: a un desconocido no
se le parsea ni un byte de JSON.

1. **¿Está bloqueada esta IP?** Tras `AUTH_FALLOS_MAX` claves incorrectas, la IP queda fuera por
   `AUTH_BLOQUEO_MINUTOS`. Cada intento nuevo reinicia el reloj: insistir alarga el castigo en vez de
   acortarlo. Esto es lo que hace que una clave de 48 caracteres no se pueda romper a fuerza bruta.
2. **¿Está en la allowlist?** Si `IPS_GHL` tiene reglas, se compara contra IPv4 exactas y bloques CIDR.
   Una IP denegada recibe exactamente la misma respuesta que una clave incorrecta: sondear desde afuera
   no revela si existe una allowlist ni cuál es.
3. **¿Trae la clave correcta?**

Cabecera `X-Mgapi-Key` con una clave de al menos 32 caracteres aleatorios. La comparación se hace sobre
los digest SHA-256 de ambos valores con `timingSafeEqual`, no sobre los textos: así ni el contenido ni
el largo de la clave recibida se filtran por el tiempo que tarda la respuesta.

La verificación por firma HMAC ya está escrita y probada, apagada tras `HMAC_ACTIVO=false`. Cuando se
active, GHL (o n8n, si se interpone) debe mandar:

- `X-Mgapi-Timestamp`: segundos Unix, con una tolerancia de 300 segundos.
- `X-Mgapi-Firma`: `HMAC-SHA256(HMAC_SECRETO, "<timestamp>.<cuerpo crudo>")` en hexadecimal.

Una firma ya usada se rechaza aunque siga dentro de la ventana: una llamada capturada no se puede
repetir.

### 3. Entrada

Cuerpo máximo de 32 KB. `Content-Type: application/json` obligatorio. El esquema Zod está en modo
estricto: un campo no declarado devuelve 400, no se ignora en silencio. Un campo ignorado en silencio es
como se cuelan los datos que nadie revisó.

RUT y patente no se aceptan por formato nomás: el RUT se verifica por módulo 11 y la patente contra los
formatos chilenos reales.

### 4. Abuso y costo

Límite de tasa por IP configurable en `LIMITE_POR_MINUTO`. Encima de eso, un contador de presupuesto
diario (`UPSTREAM_PRESUPUESTO_DIARIO`): agotado el presupuesto, mgAPI responde 429 y deja de gastar.

> El presupuesto vive en memoria del proceso. Con una sola instancia es exacto. Si algún día se corren
> varias, hay que moverlo a un contador compartido.

### 5. Secretos

Solo por variables de entorno, validadas al arrancar por `src/env.ts`. Si falta una, el proceso no
parte, y el mensaje de error nombra la variable pero nunca imprime su valor.

El archivo `.env` va con permisos 0600 y está en `.gitignore` desde el primer commit. `.env.example`
documenta los nombres sin ningún valor real.

### 6. Registros

El log automático de Fastify está apagado porque incluye datos de la petición. En su lugar se emite una
línea por petición con identificador de correlación, método, patrón de ruta, estado y duración. Nunca el
cuerpo, nunca la URL cruda, nunca las cabeceras de autenticación.

Como segunda red, la redacción de pino borra `rut`, `email`, `telefono`, `nombre`, `patente` y las
cabeceras sensibles esté donde esté, por si alguien registra de más en el futuro.

Los mensajes de error tampoco se registran: el error de JSON inválido de Node puede incluir un fragmento
del cuerpo recibido. Se registra el código del error, no su texto.

### 7. Salida hacia Zoho

**El refresh token de Zoho vive solo en el servidor.** Antes lo guardaba GoHighLevel dentro de la
configuración del webhook, donde lo veía cualquiera con acceso a esa cuenta y no se podía rotar sin
editar el flujo. mgAPI pide el access token por su cuenta y GHL no vuelve a ver una credencial de Zoho.

El access token dura una hora y se guarda en memoria, nunca en disco. Se renueva solo cuando está por
vencer, con un margen configurable para que ninguno caduque en vuelo. Si llegan varios reclamos a la vez
con el token vencido, se hace **una sola** petición de token: las demás esperan esa.

Un `401` de Zoho descarta el token guardado y reintenta una vez con uno nuevo, por si caducó antes de lo
que decía. Dos `401` seguidos cortan: el reclamo queda en cola en vez de girar en un bucle.

Un error de credenciales (`invalid_client` y similares) se marca **no reintentable**: reintentar no
arregla una credencial mala, y encolar un reclamo que nunca va a entrar solo esconde el problema. Ojo con
esto: Zoho responde `HTTP 200` aunque falle, con el error dentro del cuerpo, así que mirar el código de
estado no alcanza.

Timeout configurable. `redirect: 'error'`: una redirección maliciosa no puede desviar el token a otro
host, porque el cliente corta en vez de seguirla. El cuerpo de una respuesta con error se descarta sin
leerlo, y el token nunca aparece en un log ni en el detalle de un error.

### 8. Respuesta hacia GHL

`mapearRespuesta()` copia únicamente los campos de `CAMPOS_RESPUESTA_PERMITIDOS`, y solo si son
escalares. Todo lo demás se queda afuera. Ampliar la lista es una decisión explícita, con una línea de
código visible en la revisión.

Los errores de la API externa se traducen a códigos propios (`reclamo_rechazado`, `error_interno`). Su
estructura interna, sus mensajes y sus identificadores nunca salen.

### 9. Cola de reintentos

AES-256-GCM con clave de 32 bytes en `COLA_CLAVE_CIFRADO`. GCM además autentica: un cambio en el archivo
hace fallar el descifrado en vez de devolver basura. Archivo SQLite con permisos 0600 en un volumen
dedicado.

Espera creciente entre reintentos, hasta `COLA_INTENTOS_MAX`. Lo que agota los reintentos pasa a la cola
muerta, también cifrada, purgada automáticamente a los `COLA_RETENCION_MUERTOS_DIAS` días.

### 10. Contenedor y máquina

Usuario sin privilegios, `read_only: true`, `cap_drop: ALL`, `no-new-privileges`. En el VPS: SSH solo por
clave, sin acceso root remoto, UFW con denegación por defecto, `unattended-upgrades` y `fail2ban`.

## Límites conocidos

Vale más tenerlos escritos que descubrirlos después:

- **El presupuesto diario y el anti-repetición de firmas viven en memoria.** Se reinician si el proceso
  se reinicia, y no se comparten entre instancias.
- **Mientras `HMAC_ACTIVO=false`, la seguridad del llamante descansa en la clave compartida.** Si la
  clave se filtra, un atacante puede ingresar reclamos falsos. No puede leer nada: el endpoint solo
  escribe, y nunca devuelve datos que no haya recibido en esa misma llamada.
- **La allowlist de IP es una capa de apoyo, no el candado.** GHL no publica IP de salida estables. Si
  `IPS_GHL` está vacía, la aplicación lo advierte en el log al arrancar en producción.
- **El registro de bloqueos por fuerza bruta vive en memoria.** Se pierde al reiniciar el proceso y no
  se comparte entre instancias.
- **Las IP quedan en los logs de seguridad**, a propósito, para poder investigar un incidente. Es el
  único dato con carga personal que se registra.
- **Con `MODO_CAPTURA=true` hay un endpoint abierto** que devuelve y registra todo lo que recibe. Es
  temporal, se apaga solo tras `CAPTURA_MAXIMA` peticiones, y no toca la seguridad de `/v1/reclamos`.
  Detalle en [Modos de prueba](05-modos-de-prueba.md).
- **Rotar `COLA_CLAVE_CIFRADO` invalida lo que ya esté en cola.** Vaciar la cola antes de rotar.
