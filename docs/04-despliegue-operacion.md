# Despliegue y operación

## Preparar el VPS

Sobre Debian 12 o Ubuntu 24.04 recién instalado, como root:

```bash
# 1. Usuario sin privilegios
adduser --disabled-password --gecos "" mgapi
usermod -aG docker mgapi   # después de instalar Docker

# 2. SSH: solo clave, sin root
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'            /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# 3. Cortafuegos: todo cerrado menos SSH y HTTPS
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable

# 4. Parches de seguridad automáticos y bloqueo de fuerza bruta
apt update && apt install -y unattended-upgrades fail2ban docker.io docker-compose-v2
systemctl enable --now unattended-upgrades fail2ban docker
```

> El puerto 80 se abre solo porque Let's Encrypt lo necesita para emitir y renovar el certificado.
> Caddy redirige todo el tráfico a HTTPS.

## Configurar la aplicación

Como el usuario `mgapi`:

```bash
git clone <repositorio> /home/mgapi/mgAPI
cd /home/mgapi/mgAPI
cp .env.example .env

# Generar los secretos en el servidor, no en un portátil ni en un chat
echo "MGAPI_KEY=$(openssl rand -base64 48)"        >> .env
echo "COLA_CLAVE_CIFRADO=$(openssl rand -base64 32)" >> .env

chmod 600 .env
```

Completar a mano en `.env`: `DOMINIO`, `UPSTREAM_URL` y `UPSTREAM_TOKEN`.

`IPS_GHL` es opcional y va vacía por defecto. GHL no publica IP de salida estables, así que la allowlist
suma una capa solo si el proveedor entrega un rango fijo. Con la variable vacía, Caddy deja pasar y la
aplicación filtra únicamente por clave, que es el control fuerte de todos modos. Después, quitar del archivo las líneas vacías que dejó `.env.example`
para las variables que se generaron.

Levantar:

```bash
docker compose up -d --build
docker compose logs -f mgapi
```

`MGAPI_KEY` es el valor que hay que cargar en la cabecera `X-Mgapi-Key` de la automatización de GHL.
Se transmite una sola vez y por un canal privado, nunca por correo ni por chat de equipo.

## Verificación después de desplegar

```bash
# 1. Salud, desde dentro del servidor
docker compose exec mgapi node -e "fetch('http://127.0.0.1:3000/salud').then(r=>r.text()).then(console.log)"

# 2. Sin clave debe dar 401
curl -i -X POST https://<DOMINIO>/v1/reclamos -H 'Content-Type: application/json' -d '{}'

# 3. Reclamo válido debe dar 200 o 202
curl -i -X POST https://<DOMINIO>/v1/reclamos \
  -H "X-Mgapi-Key: $MGAPI_KEY" -H 'Content-Type: application/json' \
  -d @test/fixtures/reclamo-valido.json

# 4. Ningún dato personal en los logs: esto no debe devolver nada
docker compose logs mgapi | grep -iE 'rut|@ejemplo|patente|BCDF12|Juan Perez'

# 5. La cola en disco está cifrada: esto tampoco debe devolver nada
docker compose exec mgapi sh -c "strings /app/datos/cola.sqlite* | grep -i 'juan perez'"

# 6. Con IPS_GHL configurada, desde una IP fuera de la lista debe dar 401

# 7. Diez claves incorrectas seguidas deben terminar en 429 (bloqueo por fuerza bruta)
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code} " -X POST https://<DOMINIO>/v1/reclamos \
    -H 'X-Mgapi-Key: incorrecta' -H 'Content-Type: application/json' -d '{}'
done; echo
```

## Operación diaria

**Ver la cola.** `pendientes` en `/salud` debería estar en 0 casi siempre. Si sube y no baja, la API
externa está caída o rechazando.

**Reclamos que agotaron reintentos.** Quedan en la tabla `muertos`, cifrados, 7 días. No se pueden leer
desde afuera: hay que descifrarlos con `COLA_CLAVE_CIFRADO`. Si aparecen reclamos ahí, es un incidente
que hay que revisar antes de que la retención los borre.

**Actualizar.**

```bash
git pull && docker compose up -d --build
```

Antes de actualizar, confirmar que la cola está vacía (`/salud`): así ningún reclamo queda a medio
camino durante el reinicio.

## Rotación de secretos

**`MGAPI_KEY`** — generar la nueva, cargarla primero en GHL, después en `.env`, y reiniciar. Hay una
ventana de segundos en que GHL usa la clave nueva y mgAPI todavía la vieja: hacerlo en horario de bajo
tráfico, o aceptar que GHL reintente.

**`UPSTREAM_TOKEN`** — según lo que permita el proveedor externo. Cambiar en `.env` y reiniciar.

**`COLA_CLAVE_CIFRADO`** — **vaciar la cola primero.** Lo que esté cifrado con la clave vieja no se puede
recuperar con la nueva: al fallar el descifrado, esos reclamos pasan a la cola muerta.

```bash
# Confirmar que no hay nada pendiente antes de rotar
docker compose exec mgapi node -e "fetch('http://127.0.0.1:3000/salud').then(r=>r.json()).then(s=>console.log(s.pendientes))"
```

Rotar `MGAPI_KEY` y `UPSTREAM_TOKEN` cada 90 días, y de inmediato ante cualquier sospecha.

## Si hay un incidente

1. **Cortar el paso.** Poner `IPS_GHL=127.0.0.1` en `.env` y `docker compose up -d`: no entra nadie, y
   la cola conserva lo que ya estaba dentro. Ojo: dejar la variable *vacía* hace lo contrario, deja
   pasar a todos.
2. **Rotar `MGAPI_KEY` y `UPSTREAM_TOKEN`.** El token de la API externa primero: es el que permite actuar
   en nuestro nombre fuera de nuestra infraestructura.
3. **Revisar el alcance.** `docker compose logs mgapi | grep autenticacion_rechazada` muestra los
   intentos fallidos. Los logs no contienen datos personales por diseño, así que no hay que revisarlos en
   busca de filtraciones: hay que revisar qué llegó a la API externa.
4. **Avisar.** Si hubo acceso a datos personales, corresponde notificar según la Ley 19.628 y, si hay
   titulares en la Unión Europea, según el GDPR.

## Activar la firma HMAC

Cuando se confirme que GHL puede calcular una firma, o cuando se interponga n8n:

1. `echo "HMAC_SECRETO=$(openssl rand -base64 48)" >> .env`
2. Configurar el paso de firma en el origen: `HMAC-SHA256(HMAC_SECRETO, "<timestamp>.<cuerpo crudo>")`.
3. Probar con `HMAC_ACTIVO=false` que las cabeceras llegan bien.
4. Recién ahí `HMAC_ACTIVO=true` y reiniciar.

El código ya está escrito y probado: solo hay que encender la bandera.
