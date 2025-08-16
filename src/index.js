const express = require('express');
const axios = require('axios');
const { DisconnectReason } = require('@whiskeysockets/baileys');

// Importar módulos refactorizados
const config = require('./config/environment');
const { logger } = require('./logger');
const { checkExistingInstance } = require('./utils/helpers');
const SessionManager = require('./services/session-manager');
const RecoveryManager = require('./services/recovery-manager');
const WhatsAppClient = require('./services/whatsapp-client');
const MessageHandler = require('./services/message-handler');
const AlbumHandler = require('./services/album-handler');
const MessageSender = require('./services/message-sender');
const ApiRoutes = require('./routes/api');
const HealthChecker = require('./health-check');
const RateLimiter = require('./rate-limiter');

// Inicializar servicios
const sessionManager = new SessionManager();
const recoveryManager = new RecoveryManager();
const whatsappClient = new WhatsAppClient();
const messageHandler = new MessageHandler();
const albumHandler = new AlbumHandler();
const healthChecker = new HealthChecker();
const rateLimiter = new RateLimiter();

// Variables globales
let messageSender = null;
let apiRoutes = null;
let server = null;

// Función para enviar webhook ONMESSAGE
async function sendOnMessageWebhook(webhookData) {
  if (config.ONMESSAGE) {
    try {
      await axios.post(config.ONMESSAGE, webhookData, {
        timeout: 10000,
      headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Bot/1.0'
      }
    });
      logger.debug(`[WEBHOOK] Webhook enviado exitosamente a ${config.ONMESSAGE}`);
  } catch (error) {
      logger.error('[WEBHOOK] Error enviando webhook ONMESSAGE:', error.message);
    }
  }
}

// Función para manejar actualizaciones de conexión
async function handleConnectionUpdate(status, shouldReconnect = false, error = null) {
  if (status === 'open') {
    logger.info('[CONNECTION] Bot conectado exitosamente');
    
    // Actualizar estado del message sender
    if (messageSender) {
      messageSender.setConnectionStatus(true);
    }
    
    // Enviar notificación FCM si está configurado
    if (config.FCM_DEVICE_TOKEN) {
      try {
        await axios.post('https://fcm.googleapis.com/fcm/send', {
          to: config.FCM_DEVICE_TOKEN,
          notification: {
            title: `Bot ${config.BOT_NAME}`,
            body: 'Bot conectado exitosamente',
            priority: 'high'
          },
          data: {
            bot_name: config.BOT_NAME,
            status: 'connected',
            timestamp: new Date().toISOString()
          }
        }, {
          headers: {
            'Authorization': `key=${config.FCM_DEVICE_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
        logger.info('Notificación FCM de conexión enviada');
      } catch (error) {
        logger.error('Error enviando notificación FCM de conexión:', error.message);
      }
    }
    
  } else if (status === 'close') {
    logger.warn('[CONNECTION] Bot desconectado');
    
    // Actualizar estado del message sender
    if (messageSender) {
      messageSender.setConnectionStatus(false);
    }
    
    // Enviar webhook ONDOWN
    await whatsappClient.sendOnDownWebhook(error?.message || 'Connection closed');
    
    // Manejar reintento si es necesario
        if (shouldReconnect) {
      await recoveryManager.handleRetry('connection_lost', error, connectToWhatsApp);
    }
  }
}

// Función para manejar mensajes entrantes
async function handleIncomingMessage(msg) {
  await messageHandler.handleIncomingMessage(msg, albumHandler, sendOnMessageWebhook);
}

// Función para manejar llamadas entrantes
async function handleIncomingCall(json) {
  await messageHandler.handleCall(json, sendOnMessageWebhook);
}

// Función principal de conexión
async function connectToWhatsApp() {
  try {
    // Verificar si ya existe otra instancia corriendo
    await checkExistingInstance(config.PORT);
    
    // Verificar si la sesión está corrupta
    const isCorrupted = await sessionManager.isSessionCorrupted();
    if (isCorrupted) {
      logger.warn('[SESSION] Sesión corrupta detectada, intentando restaurar desde backup...');
      const restored = await sessionManager.restoreSessionFromBackup();
      if (!restored) {
        logger.warn('[SESSION] No se pudo restaurar desde backup, continuando con sesión limpia');
      }
    }
    
    // Conectar a WhatsApp
    await whatsappClient.connectToWhatsApp(
      handleConnectionUpdate,
      handleIncomingMessage,
      handleIncomingCall
    );
    
    // Inicializar message sender
    messageSender = new MessageSender(whatsappClient.getSocket());
    messageSender.setConnectionStatus(whatsappClient.isConnected());
    
    // Inicializar rutas de API
    apiRoutes = new ApiRoutes(messageSender, healthChecker, rateLimiter);

// Configurar Express
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // Aplicar rate limiting
app.use(rateLimiter.middleware());

    // Configurar rutas
    app.use('/api', apiRoutes.getRouter());
    
    // Iniciar servidor
    server = app.listen(config.PORT, () => {
      logger.info(`[SERVER] Servidor iniciado en puerto ${config.PORT}`);
      console.log(`${new Date().toISOString()} info: Servidor iniciado en puerto ${config.PORT}`);
    });
    
    // Configurar manejo de errores no capturados
    process.on('uncaughtException', async (err) => {
      await recoveryManager.handleUncaughtException(err, connectToWhatsApp);
    });
    
    process.on('unhandledRejection', async (reason) => {
      await recoveryManager.handleUnhandledRejection(reason, connectToWhatsApp);
    });
    
    // Configurar limpieza de álbumes
    setInterval(() => {
      albumHandler.cleanupExpiredAlbums();
    }, 30000); // Cada 30 segundos
    
    // Configurar health checks
    healthChecker.start();
    
    // Hacer backup de sesión al inicio
    await sessionManager.backupSession(true);

      } catch (error) {
    logger.error('[CONNECT] Error en conexión inicial:', error.message);
    await recoveryManager.handleRetry('initial_connection_failed', error, connectToWhatsApp);
  }
}

// Función de limpieza al cerrar
function cleanup() {
  logger.info('[CLEANUP] Iniciando limpieza...');
  
  if (server) {
    server.close();
  }
  
  if (whatsappClient) {
    whatsappClient.close();
  }
  
  if (healthChecker) {
    healthChecker.stop();
  }
  
  // Hacer backup de sesión al cerrar
  sessionManager.backupSession(true);
  
  logger.info('[CLEANUP] Limpieza completada');
}

// Manejar señales de terminación
process.on('SIGINT', () => {
  logger.info('[SIGNAL] SIGINT recibido, cerrando...');
  cleanup();
          process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('[SIGNAL] SIGTERM recibido, cerrando...');
  cleanup();
  process.exit(0);
});

// Iniciar la aplicación
logger.info(`[STARTUP] Iniciando bot ${config.BOT_NAME}...`);
connectToWhatsApp().catch(error => {
  logger.error('[STARTUP] Error fatal al iniciar:', error.message);
    process.exit(1);
});
