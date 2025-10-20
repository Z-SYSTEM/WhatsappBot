import express from 'express';
import fs from 'fs-extra';
import cron from 'node-cron';
import net from 'net';
import { logger } from './logger.js';
import { cleanupOldLogs } from './logger.js';
import config from './config.js';
import WhatsAppBot from './core/WhatsAppBot.js';
import { authenticateToken } from './middleware/auth.js';
import setupRoutes from './routes/index.js';

// Crear directorios necesarios
const dirs = [config.dirs.logs, config.dirs.sessions, config.dirs.backups];
dirs.forEach(dir => {
  fs.ensureDirSync(dir);
});

// Variable global para el bot
let bot = null;

// Función para verificar si ya existe otra instancia corriendo
async function checkExistingInstance() {
  try {
    return new Promise((resolve) => {
      const tempServer = net.createServer();
      
      tempServer.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Puerto ${config.port} ya está en uso por otra instancia`);
          logger.warn('Cerrando esta instancia para evitar conflictos');
          process.exit(0);
        } else {
          logger.error('Error verificando puerto:', err.message);
          resolve();
        }
      });
      
      tempServer.once('listening', () => {
        tempServer.close(() => {
          logger.info('Puerto disponible, continuando con el inicio');
          resolve();
        });
      });
      
      tempServer.listen(config.port);
    });
  } catch (error) {
    logger.error('Error en verificación de instancia única:', error.message);
  }
}

// Configurar Express
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Inicializar bot
async function initializeBot() {
  try {
    logger.info('[INIT] Inicializando WhatsApp Bot...');
    
    bot = new WhatsAppBot(config);
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

// Iniciar servidor
async function startServer() {
  // Verificar instancia única
  await checkExistingInstance();
  
  // Inicializar y conectar bot ANTES de configurar las rutas
  try {
    await initializeBot();
  } catch (error) {
    logger.error('[STARTUP] Error inicial conectando a WhatsApp:', error.message);
  }
  
  // Configurar rutas DESPUÉS de inicializar el bot
  const authMiddleware = authenticateToken(config.tokenAccess);
  setupRoutes(app, bot, config, authMiddleware);
  
  const server = app.listen(config.port, async () => {
    logger.info(`Servidor iniciado en puerto ${config.port}`);
    logger.info(`Bot name: ${config.botName}`);
    logger.info('[STARTUP] Servidor y bot listos');
  });

  // Manejar errores del servidor
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`[SERVER] Puerto ${config.port} ya está en uso por otra instancia`);
      logger.error('[SERVER] Cerrando esta instancia para evitar conflictos');
      process.exit(1);
    } else {
      logger.error('[SERVER] Error al iniciar servidor:', err.message);
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
