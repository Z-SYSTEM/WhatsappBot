# WhatsApp Bot

Bot de WhatsApp desarrollado con Node.js y Baileys que proporciona una API REST para enviar mensajes, obtener información de contactos y gestionar la conexión con WhatsApp.

## Características

### **Características Principales**
- ✅ Conexión automática a WhatsApp Web usando Baileys
- ✅ API REST completa para envío de mensajes y gestión
- ✅ Sistema de autenticación por token Bearer
- ✅ Rate limiting configurable con bloqueo de IPs
- ✅ Health checks automáticos cada 5 minutos
- ✅ Sistema de logs avanzado con rotación diaria y compresión
- ✅ Reconexión automática inteligente con backoff exponencial
- ✅ Validación robusta de datos de entrada
- ✅ Notificaciones FCM (opcional)

### **Gestión de Sesiones**
- ✅ Sistema de validación de sesiones al inicio
- ✅ Backup automático de sesiones con rotación
- ✅ Restauración automática desde backup si la sesión es inválida
- ✅ Limpieza de sesiones corruptas con respaldo
- ✅ Detección de errores "Bad MAC" y manejo automático
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
- ✅ Llamadas (rechazo automático)

### **Funcionalidades Avanzadas**
- ✅ Manejo de álbumes con timeout y agrupación automática
- ✅ Detección de mensajes reenviados
- ✅ Prevención de duplicados con tracking de IDs
- ✅ Descarga automática de medios en base64
- ✅ Webhooks configurables para mensajes entrantes
- ✅ Logs detallados de requests en archivos separados

### **Sistema de Monitoreo**
- ✅ Health checks de memoria y conectividad
- ✅ Métricas de rate limiting en tiempo real
- ✅ Estadísticas de health checks
- ✅ Monitoreo de uso de recursos del sistema
- ✅ Detección de problemas críticos automática

### **Seguridad y Robustez**
- ✅ Manejo de errores no capturados (uncaughtException)
- ✅ Manejo de promesas rechazadas (unhandledRejection)
- ✅ Recuperación automática ante fallos
- ✅ Shutdown graceful con backup forzado
- ✅ Verificación de instancia única (prevención de conflictos)
- ✅ Sanitización de datos de entrada
- ✅ Validación de URLs y números de teléfono

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
```bash
npm run dev
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

#### Rate Limiting
```env
# Máximo número de requests por ventana de tiempo
RATE_LIMIT_MAX_REQUESTS=200

# Duración del bloqueo en milisegundos (1 hora = 3600000)
RATE_LIMIT_BLOCK_DURATION_MS=3600000
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
- `429`: Rate limit excedido
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
│   ├── logger.js         # Sistema de logging
│   ├── qr-handler.js     # Manejo de códigos QR
│   ├── health-check.js   # Sistema de health checks
│   ├── validators.js     # Validación de datos
│   └── rate-limiter.js   # Control de rate limiting
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
- **Rate Limiting**: Protección contra spam (200 requests/minuto por IP)
- **Validación**: Sanitización y validación de todos los datos de entrada
- **Logs**: Registro de todas las operaciones para auditoría

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
- Estadísticas de rate limiting

## Solución de Problemas

### Bot no se conecta

1. Verificar que el archivo `.env` esté configurado correctamente
2. Asegurar que el número de WhatsApp esté activo
3. Revisar los logs en `logs/error.log`
4. Eliminar la carpeta `sessions/` para forzar nueva autenticación

### Error de autenticación

1. Verificar que el token en `TOKENACCESS` sea correcto
2. Asegurar que el header `Authorization: Bearer <token>` esté presente
3. Verificar que el token no contenga espacios extra

### Rate limit excedido

1. Reducir la frecuencia de requests
2. Aumentar `RATE_LIMIT_MAX_REQUESTS` en la configuración
3. Esperar el tiempo de bloqueo configurado

## Desarrollo

### Scripts Disponibles

```bash
# Desarrollo con auto-reload
npm run dev

# Instalar dependencias
npm install

# Ver logs en tiempo real
tail -f logs/app.log
```

### Agregar Nuevos Endpoints

1. Crear el endpoint en `src/index.js`
2. Agregar validación en `src/validators.js` si es necesario
3. Documentar en este README
4. Probar con diferentes tipos de datos

## Licencia

MIT License
