const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const { logger, logRecovery } = require('./logger');
const HealthChecker = require('./health-check');
const Validators = require('./validators');
const RateLimiter = require('./rate-limiter');
require('dotenv').config();

// Validación de variables de entorno
const requiredEnvVars = ['BOT_NAME', 'TOKENACCESS', 'PORT'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  logger.error(`Variables de entorno faltantes: ${missingVars.join(', ')}`);
  process.exit(1);
}

const BOT_NAME = process.env.BOT_NAME;
const TOKENACCESS = process.env.TOKENACCESS;
const PORT = process.env.PORT || 4002;
const ONDOWN = process.env.ONDOWN;
const ONMESSAGE = process.env.ONMESSAGE;
const FCM_DEVICE_TOKEN = process.env.FCM_DEVICE_TOKEN;
const HEALTH_CHECK_INTERVAL_SECONDS = parseInt(process.env.HEALTH_CHECK_INTERVAL_SECONDS) || 30;

// Crear directorios necesarios
const dirs = ['logs', 'sessions', 'backups'];
dirs.forEach(dir => {
  fs.ensureDirSync(dir);
});

// Estado del bot
let botStatus = {
  isReady: false,
  isConnecting: false,
  lastHealthCheck: null,
  restartAttempts: 0,
  maxRestartAttempts: 3
};

// Variables para recovery
let restartCount = 0;
let botProcess = null;

// Inicializar health checker
const healthChecker = new HealthChecker({
  port: PORT,
  token: TOKENACCESS
});

// Inicializar sistemas de seguridad
const rateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minuto fijo
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 200, // 200 requests por minuto
  blockDuration: parseInt(process.env.RATE_LIMIT_BLOCK_DURATION_MS) || 60 * 60 * 1000 // 1 hora de bloqueo
});

// Middleware de autenticación
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token || token !== TOKENACCESS) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  next();
};

// Función para enviar notificación FCM
async function sendFCMNotification(message) {
  if (!FCM_DEVICE_TOKEN) {
    logger.warn('FCM_DEVICE_TOKEN no configurado, no se enviará notificación push');
    return;
  }

  try {
    const response = await axios.post('https://fcm.googleapis.com/fcm/send', {
      to: FCM_DEVICE_TOKEN,
      notification: {
        title: `Bot ${BOT_NAME}`,
        body: message,
        priority: 'high'
      },
      data: {
        bot_name: BOT_NAME,
        message: message,
        timestamp: new Date().toISOString()
      }
    }, {
      headers: {
        'Authorization': `key=${FCM_DEVICE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    logRecovery.notification('FCM', message);
    logger.info('Notificación FCM enviada exitosamente');
  } catch (error) {
    logger.error('Error enviando notificación FCM:', error.message);
  }
}

// Función para hacer backup de la sesión
async function backupSession() {
  try {
    const sessionPath = path.join('sessions', `${BOT_NAME}`);
    const backupPath = path.join('backups', `${BOT_NAME}_${Date.now()}`);
    
    if (await fs.pathExists(sessionPath)) {
      await fs.copy(sessionPath, backupPath);
      logger.info(`Backup de sesión creado: ${backupPath}`);
    }
  } catch (error) {
    logger.error('Error creando backup de sesión:', error.message);
  }
}

// Función para restaurar sesión desde backup
async function restoreSessionFromBackup() {
  try {
    const backupDir = 'backups';
    const sessionPath = path.join('sessions', `${BOT_NAME}`);
    
    const backupFiles = await fs.readdir(backupDir);
    const botBackups = backupFiles.filter(file => file.startsWith(BOT_NAME));
    
    if (botBackups.length > 0) {
      // Tomar el backup más reciente
      const latestBackup = botBackups.sort().pop();
      const backupPath = path.join(backupDir, latestBackup);
      
      await fs.copy(backupPath, sessionPath);
      logger.info(`Sesión restaurada desde backup: ${latestBackup}`);
      return true;
    }
  } catch (error) {
    logger.error('Error restaurando sesión desde backup:', error.message);
  }
  return false;
}

// Función para verificar si la sesión está corrupta
async function isSessionCorrupted() {
  try {
    const sessionPath = path.join('sessions', `${BOT_NAME}`);
    if (!await fs.pathExists(sessionPath)) {
      return false; // No hay sesión, no está corrupta
    }
    
    const files = await fs.readdir(sessionPath);
    return files.length === 0; // Si no hay archivos, está corrupta
  } catch (error) {
    logger.error('Error verificando sesión:', error.message);
    return true;
  }
}

// Función para iniciar el bot
async function startBot() {
  if (botStatus.isConnecting) {
    logger.warn('Bot ya está intentando conectarse');
    return;
  }

  botStatus.isConnecting = true;
  botStatus.restartAttempts++;

  try {
    // Verificar si la sesión está corrupta
    if (await isSessionCorrupted()) {
      logger.warn('Sesión corrupta detectada, intentando restaurar desde backup');
      const restored = await restoreSessionFromBackup();
      if (!restored) {
        logger.warn('No se pudo restaurar desde backup, se creará nueva sesión');
      }
    }

    // Crear backup antes de iniciar
    await backupSession();

    // Iniciar el proceso del bot
    botProcess = spawn('node', ['src/bot.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    botProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      
      // Solo mostrar logs del bot si no contienen timestamp (para evitar duplicados)
      if (!output.includes('T') || !output.includes('Z')) {
        logger.info(`Bot: ${output}`);
      }
      
      if (output.includes('Bot conectado exitosamente')) {
        botStatus.isReady = true;
        botStatus.isConnecting = false;
        botStatus.restartAttempts = 0;
        logger.info('Bot iniciado exitosamente');
      }
    });

    botProcess.stderr.on('data', (data) => {
      const error = data.toString().trim();
      logger.error(`Bot error: ${error}`);
    });

    botProcess.on('close', (code) => {
      logger.warn(`Bot process exited with code ${code}`);
      botStatus.isReady = false;
      botStatus.isConnecting = false;
      
      if (code !== 0 && botStatus.restartAttempts < botStatus.maxRestartAttempts) {
        logger.info(`Reintentando en 10 segundos... (intento ${botStatus.restartAttempts}/${botStatus.maxRestartAttempts})`);
        setTimeout(startBot, 10000);
      } else if (botStatus.restartAttempts >= botStatus.maxRestartAttempts) {
        logger.error('Máximo número de reintentos alcanzado');
        sendFCMNotification(`Bot ${BOT_NAME} no pudo iniciarse después de ${botStatus.maxRestartAttempts} intentos`);
        
        if (ONDOWN) {
          axios.post(ONDOWN, {
            bot_name: BOT_NAME,
            status: 'down',
            reason: 'max_restart_attempts_reached',
            timestamp: new Date().toISOString()
          }).catch(err => logger.error('Error enviando webhook ONDOWN:', err.message));
        }
      }
    });

  } catch (error) {
    logger.error('Error iniciando bot:', error.message);
    botStatus.isConnecting = false;
  }
}

// Health check
async function healthCheck() {
  botStatus.lastHealthCheck = new Date();
  
  try {
    const healthResult = await healthChecker.performFullHealthCheck();
    
    if (healthResult.status === 'error') {
      logger.warn('Health check detectó problemas críticos, iniciando recovery...');
      logRecovery.started('health_check_critical');
      
      // Intentar reiniciar el bot
      if (!botStatus.isReady) {
        await startBot();
      }
      
      // Enviar notificación si hay problemas críticos
      if (FCM_DEVICE_TOKEN) {
        await sendFCMNotification(`Bot ${BOT_NAME} - Problemas críticos detectados en health check`);
      }
    } else if (healthResult.status === 'warning') {
      logger.warn('Health check detectó advertencias:', healthResult.results);
    } else {
      logger.debug('Bot está funcionando correctamente');
    }
  } catch (error) {
    logger.error('Error en health check:', error.message);
    logRecovery.failed(error, 'health_check');
  }
}

// Configurar cron job para health check
cron.schedule(`*/${HEALTH_CHECK_INTERVAL_SECONDS} * * * * *`, healthCheck);

// Configurar Express
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Middlewares de seguridad
app.use(rateLimiter.middleware());

// Limpiar datos expirados del rate limiter cada 5 minutos
setInterval(() => {
  rateLimiter.cleanup();
}, 5 * 60 * 1000);

// Endpoint de health check
app.get('/api/test', authenticateToken, (req, res) => {
  res.json({
    status: 'ok',
    bot_name: BOT_NAME,
    is_ready: botStatus.isReady,
    is_connecting: botStatus.isConnecting,
    restart_attempts: botStatus.restartAttempts,
    last_health_check: botStatus.lastHealthCheck,
    timestamp: new Date().toISOString()
  });
});

// Endpoint para enviar mensajes
app.post('/api/send', authenticateToken, async (req, res) => {
  try {
    // Verificación más robusta del estado del bot
    if (!botStatus.isReady) {
      logger.warn('WhatsApp client not ready or session closed');
      return res.status(503).json({ 
        res: false, 
        error: 'WhatsApp client not connected or session closed' 
      });
    }

    // Validar y sanitizar payload completo
    const validation = Validators.validateSendMessagePayload(req.body);
    if (!validation.valid) {
      logger.warn('Validation failed:', validation.errors);
      return res.status(400).json({ 
        res: false, 
        error: 'Validation failed',
        details: validation.errors 
      });
    }

    const { phoneNumber, message, imageUrl, imageUrls, pdfUrl, contact, vcard } = validation.payload;

    // Declarar chatId fuera del try para que esté disponible en el catch
    let chatId;
    
    let triedRecovery = false;
    let lastError = null;
    
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        chatId = phoneNumber.substring(1) + "@c.us";
        logger.info(`Looking up WhatsApp ID for ${chatId}`);

        // Control de destinatarios no válidos
        if (chatId === 'status@c.us' || chatId === 'status@broadcast') {
          logger.warn('Intento de enviar mensaje a destinatario no válido:', chatId);
          return res.status(400).json({ error: 'Destinatario no permitido.' });
        }

        // Preparar datos para enviar al bot
        const sendData = {
          phone: chatId,
          message: message || '',
          type: 'text'
        };

        // Determinar tipo de contenido y preparar datos
        if (pdfUrl) {
          sendData.type = 'document';
          sendData.media = {
            url: pdfUrl,
            mimetype: 'application/pdf',
            filename: 'document.pdf'
          };
          logger.info(`Sending PDF to ${chatId}`);
        } else if (imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0) {
          // Para múltiples imágenes, enviar una por una
          logger.info(`Sending ${imageUrls.length} images to ${chatId}`);
          
          let successCount = 0;
          for (let i = 0; i < imageUrls.length; i++) {
            try {
              const imageData = {
                phone: chatId,
                message: (i === 0 && message) ? message : '', // Solo caption en la primera imagen
                type: 'image',
                media: {
                  url: imageUrls[i],
                  mimetype: 'image/jpeg'
                }
              };
              
              const internalPort = PORT + 1;
              const response = await axios.post(`http://localhost:${internalPort}/internal/send`, imageData);
              
              if (!response.data.success) {
                throw new Error(`Error sending image ${i + 1}: ${response.data.error}`);
              }
              
              successCount++;
              logger.info(`Image ${i + 1}/${imageUrls.length} sent to ${chatId}`);
              
              // Pequeña pausa entre imágenes para evitar spam
              if (i < imageUrls.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            } catch (imageError) {
              logger.error(`Error sending image ${i + 1}: ${imageError.message}`);
              // Continuar con las siguientes imágenes en caso de error
              // No lanzar el error para que continúe con las siguientes imágenes
            }
          }
          
          logger.info(`Successfully sent ${successCount}/${imageUrls.length} images to ${chatId}`);
          return res.json({ status: true, imagesSent: successCount, totalImages: imageUrls.length });
          
        } else if (imageUrl) {
          sendData.type = 'image';
          sendData.media = {
            url: imageUrl,
            mimetype: 'image/jpeg'
          };
          logger.info(`Sending single image to ${chatId}`);
        } else if (contact) {
          sendData.type = 'contact';
          sendData.contact = contact;
          logger.info(`Sending contact to ${chatId}: ${contact.name}`);
        } else if (vcard) {
          sendData.type = 'contact';
          sendData.vcard = vcard;
          logger.info(`Sending vCard to ${chatId}`);
        } else if (message) {
          sendData.type = 'text';
          logger.info(`Sending text message to ${chatId}: ${message}`);
        }

        // Enviar mensaje al bot
        const internalPort = PORT + 1;
        const response = await axios.post(`http://localhost:${internalPort}/internal/send`, sendData);
        
        if (response.data.success) {
          logger.info(`Message sent to ${chatId}`);
          return res.json({ status: true });
        } else {
          throw new Error(response.data.error || 'Unknown error');
        }

      } catch (error) {
        lastError = error;
        logger.error(`Error sending message (attempt ${attempt + 1}): ${error.stack || error}`);
        
        // Verificar si es error de sesión cerrada (adaptado para Baileys)
        if (error.message.includes('connection') || error.message.includes('session') || 
            error.message.includes('disconnect') || error.message.includes('timeout')) {
          logger.warn(`Session lost during message send to ${chatId || phoneNumber}, will auto-reconnect`);
          if (!triedRecovery) {
            triedRecovery = true;
            // Intentar reiniciar el bot
            await startBot();
            // Esperar 2 segundos tras recovery para intentar reenvío
            await new Promise(res => setTimeout(res, 2000));
            continue; // Reintentar el envío
          } else {
            return res.status(503).json({ 
              res: false, 
              error: 'WhatsApp session temporarily unavailable, please retry in a few seconds',
              retry: true 
            });
          }
        } else {
          break; // No es error de sesión, no reintentar
        }
      }
    }
    
    // Si llega aquí, falló ambos intentos
    return res.status(500).json({ 
      res: false, 
      error: 'Internal server error', 
      details: lastError && (lastError.stack || lastError.message || lastError) 
    });

  } catch (error) {
    logger.error('Error enviando mensaje:', error.message);
    res.status(500).json({
      res: false,
      error: 'Error interno del servidor',
      details: error.message
    });
  }
});

// Endpoint para obtener información de contactos
app.get('/api/contact', authenticateToken, async (req, res) => {
  try {
    // Verificación del estado del bot
    if (!botStatus.isReady) {
      logger.warn('WhatsApp client not ready for contact lookup');
      return res.status(503).json({ 
        res: false, 
        error: 'WhatsApp client not connected or session closed' 
      });
    }

    // Permitir phoneNumber por query, body o params
    let phoneNumber = undefined;
    if (req.query && req.query.phoneNumber) {
      phoneNumber = req.query.phoneNumber;
    } else if (req.body && req.body.phoneNumber) {
      phoneNumber = req.body.phoneNumber;
    } else if (req.params && req.params.phoneNumber) {
      phoneNumber = req.params.phoneNumber;
    }
    
    // Validar y sanitizar phoneNumber
    const validation = Validators.validateGetContactPayload({ phoneNumber });
    if (!validation.valid) {
      logger.warn('Contact validation failed:', validation.errors);
      return res.status(400).json({ 
        res: false, 
        error: 'Validation failed',
        details: validation.errors 
      });
    }

    const { phoneNumber: cleanPhone } = validation.payload;
    const wid = cleanPhone.endsWith('@c.us') ? cleanPhone : `${cleanPhone}@c.us`;
    
    logger.info(`Looking up contact info for ${wid}`);
    
    // Enviar request al bot para obtener información del contacto
    const internalPort = PORT + 1;
    const response = await axios.post(`http://localhost:${internalPort}/internal/contact`, {
      phoneNumber: wid
    });
    
    if (response.data.success) {
      logger.info(`Contact info retrieved for ${wid}`);
      res.json({
        res: true,
        contact: response.data.contact
      });
    } else {
      logger.warn(`Contact not found: ${wid}`);
      res.status(404).json({ 
        res: false, 
        error: 'Contacto no encontrado o sin información disponible.' 
      });
    }
    
  } catch (error) {
    logger.error(`Error fetching contact info: ${error.message}`);
    
    // Manejar errores específicos
    if (error.response && error.response.status === 503) {
      return res.status(503).json({ 
        res: false, 
        error: 'WhatsApp client temporarily unavailable' 
      });
    }
    
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ 
        res: false, 
        error: 'Contacto no encontrado' 
      });
    }
    
    res.status(500).json({ 
      res: false, 
      error: 'Error interno del servidor',
      details: error.message 
    });
  }
});

// Endpoint interno para comunicación con el bot
app.post('/internal/send', async (req, res) => {
  // Este endpoint será usado por el bot.js para recibir mensajes
  // La implementación se hará en bot.js
  res.json({ status: 'received' });
});

// Endpoint para recibir mensajes del bot
app.post('/internal/message', async (req, res) => {
  try {
    if (ONMESSAGE) {
      await axios.post(ONMESSAGE, {
        bot_name: BOT_NAME,
        ...req.body
      });
    }
    res.json({ status: 'ok' });
  } catch (error) {
    logger.error('Error enviando webhook ONMESSAGE:', error.message);
    res.status(500).json({ error: 'Error enviando webhook' });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  logger.info(`Servidor iniciado en puerto ${PORT}`);
  logger.info(`Bot name: ${BOT_NAME}`);
  
  // Iniciar el bot
  startBot();
});

// Manejo de señales para shutdown graceful
process.on('SIGINT', async () => {
  logger.info('Recibida señal SIGINT, cerrando aplicación...');
  await backupSession();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Recibida señal SIGTERM, cerrando aplicación...');
  await backupSession();
  process.exit(0);
});

// Manejo de errores no capturados
process.on('uncaughtException', async (err) => {
  logger.error('Uncaught Exception:', {
    message: err && err.message,
    stack: err && err.stack,
    full: err,
    json: (() => { try { return JSON.stringify(err); } catch (e) { return 'No se pudo serializar el error'; } })()
  });
  logger.error(`[RECOVERY] Stack trace uncaughtException: ${err && err.stack}`);
  
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
  const botName = process.env.BOT_NAME || 'desconocido';
  restartCount++;
  logger.warn(`[RECOVERY] Intentando reinicio #${restartCount} para instancia: ${botName} por uncaughtException. Motivo: ${err && err.message}`);
  
  // Notificación push de cuelgue
  const deviceToken = process.env.FCM_DEVICE_TOKEN;
  if (deviceToken) {
    await sendFCMNotification(
      `Bot ${botName} se colgó por uncaughtException: ${err && err.message} | Tipo: ${errorType}`
    );
  }
  
  // Intentar recuperación ante cualquier error
  try {
    // Intentar cerrar el proceso del bot de forma limpia
    if (botProcess && !botProcess.killed) {
      botProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (e) {
    logger.error('[RECOVERY] Error al cerrar proceso del bot:', e);
  }
  
  try {
    await startBot();
    logger.info('[RECOVERY] Bot reiniciado tras uncaughtException.');
    
    // Notificación push de recuperación
    if (deviceToken) {
      await sendFCMNotification(
        `Bot ${botName} fue reiniciado tras uncaughtException. | Tipo: ${errorType}`
      );
    }
  } catch (e) {
    logger.error('[RECOVERY] Error al reiniciar bot tras uncaughtException:', e);
  }
  
  // Si el error es crítico, reiniciar el proceso para que PM2 lo levante
  if (err && err.message && (
    err.message.includes('Out of memory') ||
    err.message.includes('ECONNREFUSED') ||
    err.message.includes('EADDRINUSE')
  )) {
    logger.error('[RECOVERY] Error crítico detectado, reiniciando proceso...');
    process.exit(1);
  }
});

process.on('unhandledRejection', async (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
  logger.error(`[RECOVERY] Stack trace unhandledRejection: ${reason && reason.stack}`);
  
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
  const botName = process.env.BOT_NAME || 'desconocido';
  restartCount++;
  logger.warn(`[RECOVERY] Intentando reinicio #${restartCount} para instancia: ${botName} por unhandledRejection. Motivo: ${reason && reason.message}`);
  
  // Notificación push de cuelgue
  const deviceToken = process.env.FCM_DEVICE_TOKEN;
  if (deviceToken) {
    await sendFCMNotification(
      `Bot ${botName} se colgó por unhandledRejection: ${reason && reason.message} | Tipo: ${errorType}`
    );
  }
  
  // Intentar recuperación
  try {
    await startBot();
    logger.info('[RECOVERY] Bot reiniciado tras unhandledRejection.');
    
    // Notificación push de recuperación
    if (deviceToken) {
      await sendFCMNotification(
        `Bot ${botName} fue reiniciado tras unhandledRejection. | Tipo: ${errorType}`
      );
    }
  } catch (e) {
    logger.error('[RECOVERY] Error al reiniciar bot tras unhandledRejection:', e);
  }
});
