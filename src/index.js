import express from 'express';
import fs from 'fs-extra';
import cron from 'node-cron';
// import net from 'net'; // No longer needed
import { logger } from './logger.js';
import { cleanupOldLogs } from './logger.js';
import config from './config.js';
import WhatsAppBot from './core/WhatsAppBot.js';
import { authenticateToken } from './middleware/auth.js';
import setupRoutes from './routes/index.js';
import { createWebServer } from './web/web-server.js';

// Crear directorios necesarios
const dirs = [config.dirs.logs, config.dirs.sessions, config.dirs.backups];
dirs.forEach(dir => {
  fs.ensureDirSync(dir);
});

// Variable global para el bot
let bot = null;

// Configurar Express
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Inicializar bot
async function initializeBot(io) {
  try {
    logger.info('[INIT] Inicializando WhatsApp Bot...');
    
    bot = new WhatsAppBot(config, io);
    await bot.initialize();
    
    logger.info('[INIT] Bot inicializado, conectando a WhatsApp...');
    
    await bot.connect();
    
    logger.info('[INIT] Bot conectado y listo');
    
  } catch (error) {
    logger.error('[INIT] Error inicializando bot:', error.message);
    throw error;
  }
}

// Configurar cron job para limpieza de álbumes expirados
cron.schedule('0 */2 * * * *', () => {
  if (bot) {
    bot.cleanupExpiredAlbums();
  }
});

// Configurar cron job para limpieza de logs antiguos (diario a las 2 AM)
cron.schedule('0 2 * * *', async () => {
  await cleanupOldLogs();
});

// Configurar cron job para health check
if (config.healthCheckInterval > 0) {
  cron.schedule(`*/${config.healthCheckInterval} * * * * *`, () => {
    logger.debug('[CRON] Ejecutando health check...');
    if (bot) {
      bot.healthCheck();
    }
  });
}

// Iniciar servidor
async function startServer() {
  // Verificar instancia única
  // await checkExistingInstance(); // REMOVED
  
  // Iniciar servidor web UI
  let io = null;
  if (config.portWeb) {
    const webServer = createWebServer(config);
    io = webServer.io;

    // Monkey-patch logger to emit logs to UI
    const originalLog = logger.log;
    logger.log = function(...args) {
      const result = originalLog.apply(this, args); // Log first
      if (io) {
        try {
          const info = args[0];
          let logData = null;
          if (typeof info === 'object' && info !== null) {
            logData = { level: info.level, message: info.message };
          } else if (typeof info === 'string') {
            logData = { level: info, message: args[1] };
          }
          
          if (logData && logData.message) {
            let messageContent = logData.message;
            if (typeof messageContent !== 'string') {
              // Handle non-string messages, like objects
              messageContent = JSON.stringify(messageContent, null, 2);
            }

            io.emit('log_entry', {
                timestamp: new Date().toISOString(),
                level: logData.level || 'info',
                message: messageContent,
            });
          }
        } catch (e) {
          // Failsafe to prevent crashing the logger
          console.error('Error in logger monkey-patch:', e);
        }
      }
      return result;
    };

    io.on('connection', (socket) => {
      // Proteger conexión de socket
      if (!socket.request.session.isAuthenticated) {
        socket.disconnect(true);
        return;
      }

      if (bot) {
        const status = bot.getStatus();
        socket.emit('status_update', { 
            isReady: status.isReady, 
            isConnecting: status.isConnecting,
            message: status.isReady ? 'Bot conectado' : (status.isConnecting ? 'Conectando...' : 'Bot desconectado')
        });

        // Enviar QR actual si existe
        const currentQR = bot.getQRCode();
        if (currentQR) {
          socket.emit('qr_update', currentQR);
        }
      } else {
        socket.emit('status_update', { isReady: false, isConnecting: true, message: 'Inicializando bot...' });
      }

      socket.on('send_test_message', async (data) => {
        if (!data.phone || !data.message) {
            return socket.emit('test_message_result', { success: false, error: 'Número y mensaje son requeridos.', phone: data.phone });
        }
        if (bot && bot.isReady()) {
            try {
                logger.info(`[WEB_UI] Enviando mensaje de prueba a ${data.phone}`);
                const result = await bot.sendMessage({
                    phone: data.phone,
                    message: data.message,
                    type: 'text'
                });
                socket.emit('test_message_result', { ...result, phone: data.phone });
            } catch (error) {
                logger.error(`[WEB_UI] Error enviando mensaje de prueba: ${error.message}`);
                socket.emit('test_message_result', { success: false, error: error.message, phone: data.phone });
            }
        } else {
            logger.warn(`[WEB_UI] Intento de enviar mensaje de prueba pero el bot no está listo.`);
            socket.emit('test_message_result', { success: false, error: 'Bot no está listo.', phone: data.phone });
        }
      });
    });
  }
  
  // Inicializar y conectar bot ANTES de configurar las rutas
  try {
    await initializeBot(io);
  } catch (error) {
    logger.error('[STARTUP] Error inicial conectando a WhatsApp:', error.message);
  }
  
  // Configurar rutas DESPUÉS de inicializar el bot
  const authMiddleware = authenticateToken(config.tokenAccess);
  setupRoutes(app, bot, config, authMiddleware);
  
  const server = app.listen(config.port, async () => {
    logger.info(`Servidor API iniciado en puerto ${config.port}`);
    logger.info(`Bot name: ${config.botName}`);
    logger.info('[STARTUP] Servidor y bot listos');
  });

  // Manejar errores del servidor
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`[SERVER] El puerto API ${config.port} ya está en uso por otra instancia`);
      logger.error('[SERVER] Cerrando esta instancia para evitar conflictos');
      process.exit(1);
    } else {
      logger.error('[SERVER] Error al iniciar servidor API:', err.message);
      process.exit(1);
    }
  });
}

// Manejo de señales para shutdown graceful
process.on('SIGINT', async () => {
  logger.info('Recibida señal SIGINT, cerrando aplicación...');
  if (bot) {
    await bot.backupSession(true);
    await bot.disconnect();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Recibida señal SIGTERM, cerrando aplicación...');
  if (bot) {
    await bot.backupSession(true);
    await bot.disconnect();
  }
  process.exit(0);
});

// Manejo de errores no capturados
process.on('uncaughtException', async (err) => {
  // Ignorar errores de sesión de Baileys que son comunes y no críticos
  if (err && err.message && (err.message.includes('Bad MAC') || err.message.includes('Failed to decrypt message'))) {
    logger.debug(`[RECOVERY] Ignorando error de sesión no crítico (uncaught): ${err.message}`);
    return;
  }

  logger.error('Uncaught Exception:', {
    message: err && err.message,
    stack: err && err.stack,
    full: err
  });
  
  let errorType = 'unknown';
  if (err && err.message) {
    if (err.message.includes('Out of memory')) errorType = 'memory';
    else if (err.message.includes('ECONNREFUSED')) errorType = 'connection_refused';
    else if (err.message.includes('EADDRINUSE')) errorType = 'address_in_use';
    else if (err.message.includes('Session closed')) errorType = 'session_closed';
    else if (err.message.includes('connection')) errorType = 'baileys_connection';
    else if (err.message.includes('disconnect')) errorType = 'baileys_disconnect';
    else if (err.message.includes('timeout')) errorType = 'timeout';
  }
  
  logger.warn(`[RECOVERY] Tipo de error detectado: ${errorType}`);
  
  // Si el error es EADDRINUSE, salir
  if (errorType === 'address_in_use') {
    logger.error('[RECOVERY] Puerto ya en uso. Cerrando aplicación...');
    process.exit(1);
    return;
  }
  
  // Enviar notificación FCM
  if (config.fcmDeviceToken && bot) {
    try {
      const HttpClient = (await import('./http-client.js')).default;
      const httpClient = new HttpClient();
      await httpClient.sendFCMNotification(config.fcmDeviceToken, {
        to: config.fcmDeviceToken,
        notification: {
          title: `Bot ${config.botName}`,
          body: `Bot se colgó por uncaughtException: ${err && err.message} | Tipo: ${errorType}`,
          priority: 'high'
        },
        data: {
          bot_name: config.botName,
          error_type: errorType,
          timestamp: new Date().toISOString()
        }
      });
    } catch (fcmError) {
      logger.error('[RECOVERY] Error enviando notificación FCM:', fcmError.message);
    }
  }
  
  // Intentar reconectar el bot
  try {
    if (bot) {
      logger.warn('[RECOVERY] Intentando reconectar bot...');
      await bot.disconnect();
      await bot.connect();
      logger.info('[RECOVERY] Bot reconectado tras uncaughtException.');
      
      // Notificación FCM de recuperación
      if (config.fcmDeviceToken) {
        try {
          const HttpClient = (await import('./http-client.js')).default;
          const httpClient = new HttpClient();
          await httpClient.sendFCMNotification(config.fcmDeviceToken, {
            to: config.fcmDeviceToken,
            notification: {
              title: `Bot ${config.botName}`,
              body: `Bot fue reiniciado tras uncaughtException. | Tipo: ${errorType}`,
              priority: 'high'
            },
            data: {
              bot_name: config.botName,
              error_type: errorType,
              timestamp: new Date().toISOString()
            }
          });
        } catch (fcmError) {
          logger.error('[RECOVERY] Error enviando notificación FCM de recuperación:', fcmError.message);
        }
      }
    }
  } catch (e) {
    logger.error('[RECOVERY] Error al reiniciar bot tras uncaughtException:', e);
  }
  
  // Si el error es crítico de memoria, salir
  if (err && err.message && err.message.includes('Out of memory')) {
    logger.error('[RECOVERY] Error crítico de memoria detectado, saliendo...');
    process.exit(1);
  }
});

process.on('unhandledRejection', async (reason, promise) => {
  // Ignorar errores de sesión de Baileys que son comunes y no críticos
  if (reason && reason.message && (reason.message.includes('Bad MAC') || reason.message.includes('Failed to decrypt message'))) {
    logger.debug(`[RECOVERY] Ignorando error de sesión no crítico (unhandled): ${reason.message}`);
    return;
  }

  logger.error('Unhandled Rejection:', reason);
  logger.error(`[RECOVERY] Stack trace: ${reason && reason.stack}`);
  
  let errorType = 'unknown';
  if (reason && reason.message) {
    if (reason.message.includes('Out of memory')) errorType = 'memory';
    else if (reason.message.includes('ECONNREFUSED')) errorType = 'connection_refused';
    else if (reason.message.includes('EADDRINUSE')) errorType = 'address_in_use';
    else if (reason.message.includes('Session closed')) errorType = 'session_closed';
    else if (reason.message.includes('connection')) errorType = 'baileys_connection';
    else if (reason.message.includes('disconnect')) errorType = 'baileys_disconnect';
    else if (reason.message.includes('timeout')) errorType = 'timeout';
  }
  
  logger.warn(`[RECOVERY] Tipo de error detectado: ${errorType}`);
  
  // Si el error es EADDRINUSE, salir
  if (errorType === 'address_in_use') {
    logger.error('[RECOVERY] Puerto ya en uso. Cerrando aplicación...');
    process.exit(1);
    return;
  }
  
  // Enviar notificación FCM
  if (config.fcmDeviceToken && bot) {
    try {
      const HttpClient = (await import('./http-client.js')).default;
      const httpClient = new HttpClient();
      await httpClient.sendFCMNotification(config.fcmDeviceToken, {
        to: config.fcmDeviceToken,
        notification: {
          title: `Bot ${config.botName}`,
          body: `Bot se colgó por unhandledRejection: ${reason && reason.message} | Tipo: ${errorType}`,
          priority: 'high'
        },
        data: {
          bot_name: config.botName,
          error_type: errorType,
          timestamp: new Date().toISOString()
        }
      });
    } catch (fcmError) {
      logger.error('[RECOVERY] Error enviando notificación FCM:', fcmError.message);
    }
  }
  
  // Intentar reconectar el bot
  try {
    if (bot) {
      logger.warn('[RECOVERY] Intentando reconectar bot...');
      await bot.disconnect();
      await bot.connect();
      logger.info('[RECOVERY] Bot reconectado tras unhandledRejection.');
      
      // Notificación FCM de recuperación
      if (config.fcmDeviceToken) {
        try {
          const HttpClient = (await import('./http-client.js')).default;
          const httpClient = new HttpClient();
          await httpClient.sendFCMNotification(config.fcmDeviceToken, {
            to: config.fcmDeviceToken,
            notification: {
              title: `Bot ${config.botName}`,
              body: `Bot fue reiniciado tras unhandledRejection. | Tipo: ${errorType}`,
              priority: 'high'
            },
            data: {
              bot_name: config.botName,
              error_type: errorType,
              timestamp: new Date().toISOString()
            }
          });
        } catch (fcmError) {
          logger.error('[RECOVERY] Error enviando notificación FCM de recuperación:', fcmError.message);
        }
      }
    }
  } catch (e) {
    logger.error('[RECOVERY] Error al reiniciar bot tras unhandledRejection:', e);
  }
});

// Iniciar la aplicación
startServer();
