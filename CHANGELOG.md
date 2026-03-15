# Changelog

## [1.0.6] - 2026-03-15

### Agregado
- **Nueva UI**: Interfaz rediseñada con tema oscuro tipo Control Center. Panel lateral con estado del bot, controles y formularios; consola de logs con estilo terminal. Filtros por nivel de log (info, warn, error, debug) persistentes en localStorage. Carga de logs de las últimas 24 horas al refrescar.

## [1.0.5] - 2026-03-15

### Cambiado
- **Health check**: Solo se registran errores en los logs del health check. Se eliminaron los mensajes debug, info y warn cuando el chequeo es correcto.
- **Log en la UI**: El panel de logs ahora mantiene hasta 1000 líneas antes de eliminar las más antiguas (antes 30).

### Dependencias
- **Baileys**: Actualizado `@whiskeysockets/baileys` a la versión 6.17.16. La versión del protocolo de WhatsApp se obtiene dinámicamente en tiempo de ejecución mediante `fetchLatestBaileysVersion()`.

## [1.0.0] - 2025-11-21

### Agregado
- Sistema de versionado automático con incremento en cada push
- Visualización de versión en la interfaz web
- Endpoint `/api/version` para consultar versión y changelog
- Integración con Husky para gestión automática de hooks de git


Todos los cambios notables de este proyecto serán documentados en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/),
y este proyecto adhiere a [Semantic Versioning](https://semver.org/lang/es/).
