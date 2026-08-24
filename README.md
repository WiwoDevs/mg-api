# mgAPI

API intermediaria de reclamos. Recibe el ingreso desde una automatización de GoHighLevel, lo valida y lo
reenvía a la API externa. No guarda datos personales: los recibe, los entrega y los olvida.

## Arranque rápido

```bash
npm install
cp .env.example .env      # completar los valores; ver docs/04-despliegue-operacion.md
npm test                  # 13 pruebas, sin dependencias externas
npm run dev
```

Requiere Node 24 o superior: el proyecto ejecuta TypeScript directamente, sin paso de compilación.

## Documentación

| Documento | Contenido |
|---|---|
| [Arquitectura](docs/01-arquitectura.md) | Qué hace, cómo está armado y por qué se decidió así |
| [Seguridad](docs/02-seguridad.md) | Modelo de amenazas, los diez controles y los límites conocidos |
| [Contrato de la API](docs/03-contrato-api.md) | Endpoint, cabeceras, cuerpos, códigos de error y configuración en GHL |
| [Despliegue y operación](docs/04-despliegue-operacion.md) | VPS, Docker, Caddy, rotación de secretos y respuesta a incidentes |
| [Modos de prueba](docs/05-modos-de-prueba.md) | Modo captura para descubrir el formato de GHL, y modo sin Zoho para operar sin credenciales |

## Principio

Lo que no se guarda no se puede filtrar.
