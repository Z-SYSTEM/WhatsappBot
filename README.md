# WhatsApp Bot

Bot de WhatsApp desarrollado con Node.js y Baileys que proporciona una API REST para enviar mensajes, obtener información de contactos y gestionar la conexión con WhatsApp.

## Características

### **Características Principales**
- ✅ Conexión automática a WhatsApp Web usando Baileys
- ✅ API REST completa para envío de mensajes y gestión
- ✅ Sistema de autenticación por token Bearer
- ✅ Health checks automáticos cada 5 minutos
- ✅ Sistema de logs avanzado con rotación diaria y compresión
- ✅ Reconexión automática inteligente con backoff exponencial
- ✅ Validación robusta de datos de entrada
- ✅ Notificaciones FCM (opcional)

### **Gestión de Sesiones**
- ✅ Conexión directa sin validaciones complejas (Baileys maneja internamente)
- ✅ Backup automático de sesiones con rotación
- ✅ Limpieza automática de sesiones corruptas
- ✅ Reconexión automática con limpieza de sesión si es necesario
- ✅ Prevención de pérdida de mensajes por sesiones inválidas

### **Tipos de Mensajes Soportados**
- ✅ Mensajes de texto (conversación y texto extendido)
- ✅ Imágenes (con caption y descarga automática)
- ✅ Videos (con caption y descarga automática)
- ✅ Audios (con descarga automática)
- ✅ Documentos/PDFs (con descarga automática)
- ✅ Ubicaciones (coordenadas GPS)
- ✅ Contactos (vCard y objetos de contacto)
- ✅ Álbumes de imágenes (agrupación automática)
- ✅ Llamadas (aceptación/rechazo configurable)

### **Funcionalidades Avanzadas**
- ✅ Manejo de álbumes con timeout y agrupación automática
- ✅ Detección de mensajes reenviados
- ✅ Prevención de duplicados con tracking de IDs
- ✅ Descarga automática de medios en base64
- ✅ Webhooks configurables para mensajes entrantes
- ✅ Logs detallados de requests en archivos separados

### **Sistema de Monitoreo**
- ✅ Health checks de memoria y conectividad
- ✅ Estadísticas de health checks
- ✅ Monitoreo de uso de recursos del sistema
- ✅ Detección de problemas críticos automática

### **Seguridad y Robustez**
- ✅ Manejo de errores no capturados (uncaughtException)
- ✅ Manejo de promesas rechazadas (unhandledRejection)
- ✅ Recuperación automática ante fallos con limpieza de sesión
- ✅ Shutdown graceful con backup forzado
- ✅ Verificación de instancia única (prevención de conflictos)
- ✅ Sanitización de datos de entrada
- ✅ Validación de URLs y números de teléfono
- ✅ Gestión automática con PM2 para producción
- ✅ Scripts de limpieza y recuperación automática

## Requisitos

- Node.js 16 o superior
- NPM o Yarn
- Cuenta de WhatsApp activa

## Instalación

1. Clonar el repositorio:
```bash
git clone <repository-url>
cd WhatsappBot
```

2. Instalar dependencias:
```bash
npm install
```

3. Configurar variables de entorno:
```bash
cp env.example .env
```

4. Editar el archivo `.env` con tus configuraciones (ver sección de configuración)

5. Ejecutar el bot:

### Opción 1: Desarrollo
```bash
npm run dev
```

### Opción 2: Producción con PM2 (Recomendado)
```bash
# Instalar PM2 globalmente
npm install -g pm2

# Iniciar con script automático
./start.sh

# O manualmente
pm2 start ecosystem.config.js
```

## Configuración

### Variables de Entorno

Copia el archivo `env.example` a `.env` y configura las siguientes variables:

#### Configuración Básica
```env
# Nombre del bot
BOT_NAME=MiBot

# Puerto del servidor
PORT=4002

# Token de autenticación para la API
TOKENACCESS=tu_token_secreto_aqui
```

#### Webhooks (Opcional)
```env
# URL para recibir notificaciones de mensajes entrantes
ONMESSAGE=https://tu-servidor.com/webhook/message

#### Notificaciones FCM (Opcional)
```env
# Token del dispositivo para notificaciones push
FCM_DEVICE_TOKEN=tu_fcm_device_token_aqui
```

#### Health Check
```env
# Intervalo en segundos para health checks
HEALTH_CHECK_INTERVAL_SECONDS=30
```

#### Gestión de Llamadas
```env
# Aceptar llamadas (TRUE para aceptar, FALSE para rechazar automáticamente)
ACCEPT_CALL=FALSE
```



## API Endpoints

### Autenticación

Todos los endpoints requieren autenticación mediante token Bearer en el header:

```
Authorization: Bearer tu_token_secreto_aqui
```

### 1. Health Check

**GET** `/api/test`

Verifica el estado del bot y la conexión con WhatsApp.

**Respuesta exitosa:**
```json
{
  "status": "ok",
  "bot_name": "MiBot",
  "is_ready": true,
  "is_connecting": false,
  "restart_attempts": 0,
  "last_health_check": "2024-01-15T10:30:00.000Z",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 2. Enviar Mensaje

**POST** `/api/send`

Envía un mensaje a un número de WhatsApp.

**Body:**
```json
{
  "phoneNumber": "+1234567890",
  "message": "Hola, este es un mensaje de prueba",
  "imageUrl": "https://ejemplo.com/imagen.jpg",
  "imageUrls": ["https://ejemplo.com/imagen1.jpg", "https://ejemplo.com/imagen2.jpg"],
  "pdfUrl": "https://ejemplo.com/documento.pdf",
  "contact": {
    "name": "Juan Pérez",
    "number": "+1234567890"
  },
  "vcard": "BEGIN:VCARD\nVERSION:3.0\nFN:Juan Pérez\nTEL:+1234567890\nEND:VCARD"
}
```

**Campos disponibles:**
- `phoneNumber` (requerido): Número de teléfono en formato internacional (+1234567890)
- `message` (opcional): Mensaje de texto (máximo 4096 caracteres)
- `imageUrl` (opcional): URL de una imagen
- `imageUrls` (opcional): Array de URLs de imágenes (máximo 10)
- `pdfUrl` (opcional): URL de un documento PDF
- `contact` (opcional): Objeto con información de contacto
- `vcard` (opcional): String con formato vCard

**Respuesta exitosa:**
```json
{
  "status": true
}
```

**Para múltiples imágenes:**
```json
{
  "status": true,
  "imagesSent": 3,
  "totalImages": 3
}
```

### 3. Obtener Información de Contacto

**GET** `/api/contact`

Obtiene información de un contacto de WhatsApp.

**Query Parameters:**
- `phoneNumber`: Número de teléfono en formato internacional

**Ejemplo:**
```
GET /api/contact?phoneNumber=+1234567890
```

**Respuesta exitosa:**
```json
{
  "res": true,
  "contact": {
    "id": "1234567890@c.us",
    "name": "Juan Pérez",
    "number": "1234567890",
    "isBusiness": false,
    "profilePicUrl": "https://pps.whatsapp.net/v/t61.24694-24/...",
    "status": "Disponible",
    "verified": false,
    "verifiedName": null
  }
}
```

## Códigos de Error

### HTTP Status Codes

- `200`: Operación exitosa
- `400`: Error de validación en los datos de entrada
- `401`: Token de autenticación inválido o faltante
- `503`: Bot no está conectado a WhatsApp
- `500`: Error interno del servidor

### Respuestas de Error

```json
{
  "res": false,
  "error": "Descripción del error",
  "details": "Detalles adicionales del error"
}
```

## Estructura del Proyecto

```
WhatsappBot/
├── src/
│   ├── index.js          # Archivo principal del servidor
│   ├── config.js         # Configuración centralizada
│   ├── constants.js      # Constantes del proyecto
│   ├── core/             # Clases principales
│   │   ├── WhatsAppBot.js
│   │   ├── WhatsAppConnection.js
│   │   └── SessionManager.js
│   ├── handlers/         # Manejadores de eventos
│   │   ├── MessageHandler.js
│   │   ├── MessageSender.js
│   │   ├── CallHandler.js
│   │   ├── AlbumHandler.js
│   │   └── MediaProcessor.js
│   ├── routes/           # Endpoints de la API
│   ├── middleware/       # Middleware de Express
│   ├── logger.js         # Sistema de logging
│   ├── qr-handler.js     # Manejo de códigos QR
│   ├── health-check.js   # Sistema de health checks
│   ├── validators.js     # Validación de datos
│   └── http-client.js    # Cliente HTTP
├── logs/                 # Archivos de log
├── sessions/             # Sesiones de WhatsApp
├── backups/              # Backups de sesiones
├── env.example          # Ejemplo de configuración
├── package.json         # Dependencias del proyecto
└── README.md           # Este archivo
```

## Logs

El sistema genera logs en el directorio `logs/` con rotación diaria:

- `app.log`: Logs generales de la aplicación
- `error.log`: Logs de errores
- `recovery.log`: Logs de recuperación y reconexión

## Seguridad

- **Autenticación**: Todos los endpoints requieren token Bearer
- **Validación**: Sanitización y validación de todos los datos de entrada
- **Logs**: Registro de todas las operaciones para auditoría

## Gestión de Llamadas

El bot puede configurarse para manejar llamadas entrantes de dos formas:

### Configuración por Defecto
- **ACCEPT_CALL=FALSE**: Las llamadas se rechazan automáticamente (comportamiento por defecto)
- **ACCEPT_CALL=TRUE**: Las llamadas se aceptan automáticamente

### Comportamiento
- **Llamadas de Voz y Video**: Ambas se manejan según la configuración
- **Webhooks**: Se envían notificaciones tanto para llamadas aceptadas como rechazadas
- **Logs**: Se registran todas las acciones de llamadas con detalles del remitente

### Ejemplo de Configuración
```env
# Para rechazar todas las llamadas (por defecto)
ACCEPT_CALL=FALSE

# Para aceptar todas las llamadas
ACCEPT_CALL=TRUE
```

## Monitoreo

### Health Checks

El bot realiza health checks automáticos cada 30 segundos (configurable) para verificar:
- Estado de la conexión con WhatsApp
- Uso de memoria del sistema
- Conectividad de red

### Métricas Disponibles

- Estado de conexión del bot
- Número de intentos de reconexión
- Último health check realizado

## Gestión con PM2

### Comandos Básicos
```bash
# Ver estado del bot
pm2 status

# Ver logs en tiempo real
pm2 logs whatsapp-bot

# Reiniciar bot
pm2 restart whatsapp-bot

# Detener bot
pm2 stop whatsapp-bot

# Eliminar bot de PM2
pm2 delete whatsapp-bot
```

### Limpiar Sesión Corrupta
Si el bot pide QR constantemente o detecta sesión corrupta:

```bash
# Usar script automático
./clean-session.sh

# O manualmente
pm2 stop whatsapp-bot
rm -rf sessions
mkdir sessions
pm2 start ecosystem.config.js
```

## Solución de Problemas

### Bot no se conecta

1. Verificar que el archivo `.env` esté configurado correctamente
2. Asegurar que el número de WhatsApp esté activo
3. Revisar los logs: `pm2 logs whatsapp-bot`
4. Limpiar sesión corrupta: `./clean-session.sh`

### Error de autenticación

1. Verificar que el token en `TOKENACCESS` sea correcto
2. Asegurar que el header `Authorization: Bearer <token>` esté presente
3. Verificar que el token no contenga espacios extra

## Desarrollo

### Scripts Disponibles

```bash
# Desarrollo con auto-reload
npm run dev

# Instalar dependencias
npm install

# Iniciar con PM2 (producción)
./start.sh

# Limpiar sesión corrupta
./clean-session.sh

# Ver logs en tiempo real
pm2 logs whatsapp-bot
```

### Agregar Nuevos Endpoints

1. Crear el endpoint en `src/index.js`
2. Agregar validación en `src/validators.js` si es necesario
3. Documentar en este README
4. Probar con diferentes tipos de datos

## Licencia

MIT License
