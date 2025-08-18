const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const winston = require('winston');
const { logger, logMessage, logRecovery, cleanupOldLogs } = require('./logger');
const { generateQRCode } = require('./qr-handler');
const HealthChecker = require('./health-check');
const Validators = require('./validators');
const RateLimiter = require('./rate-limiter');
require('dotenv').config();

// Constantes para tipos de mensajes de WhatsApp
const _PROTOCOL_MESSAGE_ALBUM = 14;
const _PROTOCOL_MESSAGE_REVOKE = 7;
const _PROTOCOL_MESSAGE_EPHEMERAL_SETTING = 18;

// Constantes para tipos de mensajes
const _MESSAGE_TYPE_CHAT = 'chat';
const _MESSAGE_TYPE_IMAGE = 'image';
const _MESSAGE_TYPE_VIDEO = 'video';
const _MESSAGE_TYPE_AUDIO = 'audio';
const _MESSAGE_TYPE_DOCUMENT = 'document';
// const _MESSAGE_TYPE_STICKER = 'sticker'; // Soporte deshabilitado
const _MESSAGE_TYPE_LOCATION = 'location';
const _MESSAGE_TYPE_CONTACT = 'contact';
const _MESSAGE_TYPE_ALBUM = 'album';
const _MESSAGE_TYPE_CALL = 'call';

// Constantes para timeouts y límites
const _ALBUM_WAIT_TIMEOUT = 10000; // 10 segundos para esperar mensajes de álbum
const _ALBUM_MAX_IMAGES = 30; // Máximo número de imágenes en un álbum
const _PROCESSED_MESSAGES_MAX_SIZE = 1000;
const _PROCESSED_MESSAGES_KEEP_SIZE = 500;

// Set para trackear mensajes ya procesados y evitar duplicados
const processedMessageIds = new Set();

// Sistema para manejar álbumes
const albumTracker = new Map(); // Trackear álbumes en progreso
const albumMessages = new Map(); // Almacenar mensajes de álbumes

// Función para guardar logs de requests POST en onMessage
async function logOnMessageRequest(requestData) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = path.join('logs', 'onmessage-requests');
    
    // Crear directorio si no existe
    await fs.ensureDir(logDir);
    
    // Crear nombre de archivo único con timestamp
    const logFile = path.join(logDir, `request-${timestamp}.json`);
    
    // Guardar el request completo como JSON en un archivo separado
    await fs.writeFile(logFile, JSON.stringify(requestData, null, 2));
    
    logger.debug(`[ONMESSAGE_LOG] Request guardado en archivo: ${logFile}`);
  } catch (error) {
    logger.error('Error guardando log de request onMessage:', error.message);
  }
}

// Validación de variables de entorno
const requiredEnvVars = ['BOT_NAME', 'TOKENACCESS', 'PORT'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  logger.error(`Variables de entorno faltantes: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Logger personalizado para Baileys que filtra mensajes específicos
const baileysLogger = {
  // Lista de mensajes a ignorar
  ignoredMessages: [
    'Closing open session in favor of incoming prekey bundle',
    'Closing stale open session for new outgoing prekey bundle',
    'Closing session: SessionEntry',
    'SessionEntry',
    'Bot error: Closing open session'
  ],
  
  // Función para verificar si un mensaje debe ser ignorado
  shouldIgnore(message) {
    if (typeof message === 'string') {
      // Verificar mensajes específicos
      if (this.ignoredMessages.some(ignored => message.includes(ignored))) {
        return true;
      }
      // También ignorar cualquier mensaje que contenga SessionEntry
      if (message.includes('SessionEntry')) {
        return true;
      }
      // Ignorar mensajes de cierre de sesión
      if (message.includes('Closing session')) {
        return true;
      }
    }
    return false;
  },
  
  // Métodos del logger que filtran mensajes
  trace: function(message) {
    if (!this.shouldIgnore(message)) {
      // No hacer nada para trace
    }
  },
  
  debug: function(message) {
    if (!this.shouldIgnore(message)) {
      // No hacer nada para debug
    }
  },
  
  info: function(message) {
    if (!this.shouldIgnore(message)) {
      // No hacer nada para info
    }
  },
  
  warn: function(message) {
    if (!this.shouldIgnore(message)) {
      // No hacer nada para warn
    }
  },
  
  error: function(message) {
    if (!this.shouldIgnore(message)) {
      // Solo loggear errores que no estén en la lista de ignorados
      if (typeof message === 'string' && !message.includes('Bot error:')) {
        // No loggear errores de Baileys que no sean críticos
      }
    }
  },
  
  // Método child requerido por Baileys
  child: function(options) {
    return this; // Retornar el mismo logger
  }
};

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

// Crear directorio de sesión si no existe
const sessionDir = 'sessions';
fs.ensureDirSync(sessionDir);

// Variables de WhatsApp optimizadas
let sock = null;
let isConnected = false;

// Variables reutilizables para evitar allocations
let tempBuffer = null;
let tempMessageData = {};
let tempHealthData = {};

// Variables para el sistema de reintentos mejorado
let reconnectAttempts = 0;
let maxReconnectAttempts = parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10;
let initialReconnectDelay = parseInt(process.env.INITIAL_RECONNECT_DELAY) || 5000; // 5 segundos
let maxReconnectDelay = parseInt(process.env.MAX_RECONNECT_DELAY) || 300000; // 5 minutos
let reconnectBackoffMultiplier = parseFloat(process.env.RECONNECT_BACKOFF_MULTIPLIER) || 2.0;
let isReconnecting = false;
let lastConnectionTime = null;
let connectionTimeout = null;
let consecutiveFailures = 0;
let maxConsecutiveFailures = parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || 3;

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

// Inicializar health checker
const healthChecker = new HealthChecker({
  port: PORT,
  token: TOKENACCESS
});

// Inicializar sistemas de seguridad
const rateLimiter = new RateLimiter({
  windowMs: 60 * 1000, // 1 minuto fijo
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 300, // 300 requests por minuto (más permisivo)
  blockDuration: parseInt(process.env.RATE_LIMIT_BLOCK_DURATION_MS) || 15 * 60 * 1000 // 15 minutos de bloqueo (menos severo)
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
    // Reutilizar objeto para evitar allocations
    tempHealthData.to = FCM_DEVICE_TOKEN;
    tempHealthData.notification = {
      title: `Bot ${BOT_NAME}`,
      body: message,
      priority: 'high'
    };
    tempHealthData.data = {
      bot_name: BOT_NAME,
      message: message,
      timestamp: new Date().toISOString()
    };

    const response = await axios.post('https://fcm.googleapis.com/fcm/send', tempHealthData, {
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

// Función para hacer backup de la sesión - Solo cuando sea necesario
async function backupSession(force = false) {
  try {
    const sessionPath = 'sessions';
    const backupDir = 'backups';
    
    // Verificar si existe la sesión
    if (!await fs.pathExists(sessionPath)) {
      logger.debug('No hay sesión para hacer backup');
      return; // No hay sesión para hacer backup
    }
    
    // Si no es forzado, verificar si es necesario hacer backup
    if (!force) {
      const sessionFiles = await fs.readdir(sessionPath);
      if (sessionFiles.length === 0) {
        logger.debug('Sesión vacía, no hacer backup');
        return; // Sesión vacía, no hacer backup
      }
      
      // Verificar si ya existe un backup reciente (menos de 24 horas)
      const existingBackups = await fs.readdir(backupDir);
      const timestampBackups = existingBackups.filter(file => /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(file));
      
      if (timestampBackups.length > 0) {
        const latestBackup = timestampBackups.sort().pop();
        const backupTime = new Date(latestBackup.replace(/-/g, ':').replace(' ', 'T'));
        const oneDayAgo = new Date(Date.now() - (24 * 60 * 60 * 1000));
        
        if (backupTime > oneDayAgo) {
          logger.debug('Backup reciente encontrado (menos de 24 horas), saltando creación de nuevo backup');
          return; // Ya hay un backup reciente
        }
      }
    }
    
    // Crear backup solo si es forzado o si no hay backup reciente
    const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(/:/g, '-');
    const backupPath = path.join(backupDir, timestamp);
    await fs.copy(sessionPath, backupPath);
    logger.info(`Backup de sesión creado: ${backupPath}`);
    
    // Limpiar backups antiguos (mantener solo los 3 más recientes)
    await cleanupOldBackups();
    
  } catch (error) {
    logger.error('Error creando backup de sesión:', error.message);
  }
}

// Función para limpiar backups antiguos
async function cleanupOldBackups() {
  try {
    const backupDir = 'backups';
    const existingBackups = await fs.readdir(backupDir);
    const timestampBackups = existingBackups.filter(file => /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(file));
    
    if (timestampBackups.length > 3) {
      // Ordenar por timestamp (más antiguos primero)
      const sortedBackups = timestampBackups.sort();
      const backupsToDelete = sortedBackups.slice(0, timestampBackups.length - 3);
      
      for (const backup of backupsToDelete) {
        const backupPath = path.join(backupDir, backup);
        await fs.remove(backupPath);
        logger.debug(`Backup antiguo eliminado: ${backup}`);
      }
      
      logger.info(`Limpieza completada: ${backupsToDelete.length} backups antiguos eliminados`);
    }
  } catch (error) {
    logger.error('Error limpiando backups antiguos:', error.message);
  }
}

// Función para restaurar sesión desde backup
async function restoreSessionFromBackup() {
  try {
    const backupDir = 'backups';
    const sessionPath = 'sessions';
    
    const backupFiles = await fs.readdir(backupDir);
    const timestampBackups = backupFiles.filter(file => /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(file));
    
    if (timestampBackups.length > 0) {
      // Tomar el backup más reciente
      const latestBackup = timestampBackups.sort().pop();
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
    const sessionPath = 'sessions';
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

// Función para resetear el estado de reintentos
function resetRetryState() {
  reconnectAttempts = 0;
  consecutiveFailures = 0;
  isReconnecting = false;
  lastConnectionTime = new Date();
  if (connectionTimeout) {
    clearTimeout(connectionTimeout);
    connectionTimeout = null;
  }
}

// Función para calcular el delay exponencial con jitter
function calculateRetryDelay(attempt) {
  const baseDelay = initialReconnectDelay * Math.pow(reconnectBackoffMultiplier, attempt);
  const maxDelay = Math.min(baseDelay, maxReconnectDelay);
  
  // Agregar jitter para evitar thundering herd
  const jitter = Math.random() * 0.1 * maxDelay; // 10% de jitter
  const finalDelay = maxDelay + jitter;
  
  return Math.floor(finalDelay);
}

// Función para determinar si debe reintentar basado en el tipo de error
function shouldRetry(error, disconnectReason) {
  // Errores que NO deben reintentar
  const nonRetryableErrors = [
    'logged_out',
    'not-authorized',
    'forbidden',
    'unauthorized'
  ];
  
  // Códigos de estado que NO deben reintentar
  const nonRetryableStatusCodes = [
    401, // Unauthorized
    403, // Forbidden
    404  // Not Found
  ];
  
  // Verificar si es un logout del usuario
  if (disconnectReason === DisconnectReason.loggedOut) {
    return false;
  }
  
  // Verificar códigos de estado
  if (error && error.output && nonRetryableStatusCodes.includes(error.output.statusCode)) {
    return false;
  }
  
  // Verificar mensajes de error
  const errorMessage = error?.message?.toLowerCase() || '';
  if (nonRetryableErrors.some(err => errorMessage.includes(err))) {
    return false;
  }
  
  // Verificar límite de intentos consecutivos
  if (consecutiveFailures >= maxConsecutiveFailures) {
    logger.warn(`[RETRY] Máximo de fallos consecutivos alcanzado (${maxConsecutiveFailures})`);
    return false;
  }
  
  return true;
}

// Función para manejar reintentos con límites mejorados
async function handleRetry(reason = 'unknown', error = null) {
  if (isReconnecting) {
    logger.debug('[RETRY] Ya hay un proceso de reconexión en curso, ignorando...');
    return;
  }

  isReconnecting = true;
  reconnectAttempts++;
  consecutiveFailures++;

  logger.warn(`[RETRY] Iniciando reintento ${reconnectAttempts}/${maxReconnectAttempts}`);
  logger.warn(`[RETRY] Razón: ${reason}`);
  logger.warn(`[RETRY] Fallos consecutivos: ${consecutiveFailures}/${maxConsecutiveFailures}`);
  logger.warn(`[RETRY] Timestamp: ${new Date().toISOString()}`);

  // Verificar límites
  if (reconnectAttempts > maxReconnectAttempts) {
    logger.error(`[RETRY] Máximo número de reintentos alcanzado (${maxReconnectAttempts})`);
    logger.error(`[RETRY] Fallos consecutivos: ${consecutiveFailures}`);
    
    // Enviar notificación FCM si está configurado
    if (FCM_DEVICE_TOKEN) {
      try {
        await axios.post('https://fcm.googleapis.com/fcm/send', {
          to: FCM_DEVICE_TOKEN,
          notification: {
            title: `Bot ${BOT_NAME} - Error Crítico`,
            body: `Máximo de reintentos alcanzado después de ${reconnectAttempts} intentos`,
            priority: 'high'
          },
          data: {
            bot_name: BOT_NAME,
            status: 'max_retries_reached',
            reason: reason,
            attempts: reconnectAttempts.toString(),
            consecutive_failures: consecutiveFailures.toString(),
            timestamp: new Date().toISOString()
          }
        }, {
          headers: {
            'Authorization': 'key=YOUR_FCM_SERVER_KEY',
            'Content-Type': 'application/json'
          }
        });
        logger.info('[RETRY] Notificación FCM enviada');
      } catch (fcmError) {
        logger.error('[RETRY] Error enviando notificación FCM:', fcmError.message);
      }
    }
    
    process.exit(1);
  }

  // Verificar si debe reintentar basado en el tipo de error
  if (!shouldRetry(error, reason)) {
    logger.error(`[RETRY] Error no reintentable: ${reason}`);
    process.exit(1);
  }

  const delay = calculateRetryDelay(reconnectAttempts - 1);
  logger.info(`[RETRY] Esperando ${delay}ms antes del siguiente intento...`);
  logger.info(`[RETRY] Delay calculado: base=${initialReconnectDelay * Math.pow(reconnectBackoffMultiplier, reconnectAttempts - 1)}, final=${delay}ms`);

  connectionTimeout = setTimeout(async () => {
    try {
      await connectToWhatsApp();
    } catch (connectError) {
      logger.error(`[RETRY] Error en intento ${reconnectAttempts}:`, connectError.message);
      isReconnecting = false;
      await handleRetry('connection_failed', connectError);
    }
  }, delay);
}

// Función para conectar WhatsApp
async function connectToWhatsApp() {
  try {
    logger.info('[CONNECT] Iniciando conexión con WhatsApp...');
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    sock = makeWASocket({
      auth: state,
      logger: baileysLogger
    });

    // Manejar eventos de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        logger.info('QR Code generado, escanea con WhatsApp');
        await generateQRCode(qr);
      }
      
      if (connection === 'close') {
        const disconnectReason = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : null;
        const shouldReconnect = disconnectReason !== DisconnectReason.loggedOut;
        
        logger.warn('[CONNECT] Conexión cerrada');
        logger.warn(`[CONNECT] Razón de desconexión: ${lastDisconnect?.error?.message || 'unknown'}`);
        logger.warn(`[CONNECT] Código de estado: ${disconnectReason || 'N/A'}`);
        logger.warn(`[CONNECT] Debería reconectar: ${shouldReconnect}`);
        logger.warn(`[CONNECT] Timestamp: ${new Date().toISOString()}`);
        
        // Deshabilitar health check cuando se cierra la conexión
        disableHealthCheck();
        
        if (shouldReconnect) {
          await handleRetry('connection_closed', lastDisconnect?.error);
        } else {
          logger.error('[CONNECT] Conexión cerrada por logout del usuario - No se reconectará');
          if (ONDOWN) {
            try {
              await axios.post(ONDOWN, {
                bot_name: BOT_NAME,
                status: 'logged_out',
                reason: 'user_logged_out',
                timestamp: new Date().toISOString()
              });
            } catch (error) {
              logger.error('[CONNECT] Error enviando webhook ONDOWN:', error.message);
            }
          }
          process.exit(1);
        }
      } else if (connection === 'open') {
        isConnected = true;
        botStatus.isReady = true;
        resetRetryState(); // Resetear contadores de reintentos
        logger.info('[CONNECT] Bot conectado exitosamente');
        console.log(`${new Date().toISOString()} info: Bot conectado exitosamente`);
        
        // Habilitar health check cuando la sesión esté abierta
        enableHealthCheck();
        
        // Hacer backup de la sesión establecida (solo si no hay uno reciente)
        setTimeout(() => {
          backupSession(false);
        }, 5000); // Esperar 5 segundos para asegurar que la sesión esté completamente establecida
      }
    });

    // Manejar credenciales
    sock.ev.on('creds.update', saveCreds);

    // Manejar mensajes entrantes
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      
      // Log detallado de todos los mensajes recibidos
      logger.debug(`[MESSAGE] Mensaje recibido de ${msg.key.remoteJid}, fromMe: ${msg.key.fromMe}, tipo: ${Object.keys(msg.message || {}).join(', ')}`);
      
      // Filtrar mensajes: solo procesar mensajes de chat individual, no de grupos ni status
      if (!msg.key.fromMe && msg.message && 
          !msg.key.remoteJid.includes('@g.us') && 
          !msg.key.remoteJid.includes('@broadcast')) {
        await handleIncomingMessage(msg);
      } else if (msg.key.fromMe) {
        // Solo loggear mensajes propios que no sean protocolMessage (mensajes internos de WhatsApp)
        const messageTypes = Object.keys(msg.message || {});
        if (!messageTypes.includes('protocolMessage')) {
          logger.debug(`[IGNORED] Mensaje propio ignorado: ${msg.key.remoteJid} - ${messageTypes.join(', ')}`);
        }
      } else if (msg.key.remoteJid.includes('@g.us')) {
        logger.debug(`[IGNORED] Mensaje de grupo ignorado: ${msg.key.remoteJid} - ${Object.keys(msg.message || {}).join(', ')}`);
      } else if (msg.key.remoteJid.includes('@broadcast')) {
        logger.debug(`[IGNORED] Mensaje de status ignorado: ${msg.key.remoteJid} - ${Object.keys(msg.message || {}).join(', ')}`);
      } else if (!msg.message) {
        logger.debug(`[IGNORED] Mensaje sin contenido ignorado: ${msg.key.remoteJid}`);
      } else {
        logger.warn(`[IGNORED] Mensaje de tipo desconocido ignorado: ${msg.key.remoteJid} - ${Object.keys(msg.message).join(', ')}`);
      }
    });

    // Manejar llamadas
    sock.ev.on('call', async (json) => {
      await handleCall(json);
    });

  } catch (error) {
    logger.error('[CONNECT] Error conectando a WhatsApp:', error.message);
    logger.error(`[CONNECT] Stack trace: ${error.stack}`);
    logger.error(`[CONNECT] Timestamp: ${new Date().toISOString()}`);
    throw error;
  }
}

// Función para verificar si un mensaje es reenviado
function isMessageForwarded(messageObj) {
  return messageObj && messageObj.contextInfo && messageObj.contextInfo.isForwarded;
}

// Función para generar ID único de álbum
function generateAlbumId(msg) {
  const remoteJid = msg.key.remoteJid;
  const timestamp = msg.messageTimestamp;
  
  // Si tiene contextInfo con productId, usar eso para agrupar mejor
  if (msg.message?.imageMessage?.contextInfo?.productId) {
    const productId = msg.message.imageMessage.contextInfo.productId;
    return `${remoteJid}_${productId}`;
  }
  
  // Si no tiene productId, usar timestamp con una ventana de tiempo más amplia
  // Agrupar mensajes que lleguen en un rango de 30 segundos
  const timeWindow = Math.floor(timestamp / 30);
  return `${remoteJid}_${timeWindow}`;
}

// Función para verificar si un mensaje pertenece a un álbum
function isAlbumMessage(msg) {
  // Verificar si es una imagen
  if (!msg.message || !msg.message.imageMessage) {
    return false;
  }
  
  const imageMessage = msg.message.imageMessage;
  
  // Log detallado para debugging
  logger.debug(`[ALBUM_CHECK] Verificando mensaje ${msg.key.id} para álbum`);
  logger.debug(`[ALBUM_CHECK] contextInfo: ${JSON.stringify(imageMessage.contextInfo)}`);
  logger.debug(`[ALBUM_CHECK] productId: ${imageMessage.contextInfo?.productId}`);
  logger.debug(`[ALBUM_CHECK] businessOwnerJid: ${imageMessage.contextInfo?.businessOwnerJid}`);
  logger.debug(`[ALBUM_CHECK] isForwarded: ${imageMessage.contextInfo?.isForwarded}`);
  
  // Verificar si tiene contextInfo
  if (!imageMessage.contextInfo) {
    logger.debug(`[ALBUM_CHECK] No tiene contextInfo, no es álbum`);
    return false;
  }
  
  const contextInfo = imageMessage.contextInfo;
  
  // Un mensaje es parte de un álbum si:
  // 1. Tiene contextInfo
  // 2. No es reenviado (o es undefined/null)
  // 3. Tiene productId (indicador de álbum)
  // 4. O tiene businessOwnerJid (indicador de álbum de negocio)
  // 5. O tiene isForwarded = false explícitamente
  
  const isNotForwarded = contextInfo.isForwarded === false || contextInfo.isForwarded === undefined || contextInfo.isForwarded === null;
  const hasAlbumIndicator = contextInfo.productId || contextInfo.businessOwnerJid;
  
  const isAlbum = isNotForwarded && hasAlbumIndicator;
  
  logger.debug(`[ALBUM_CHECK] isNotForwarded: ${isNotForwarded}, hasAlbumIndicator: ${hasAlbumIndicator}, isAlbum: ${isAlbum}`);
  
  return isAlbum;
}

// Función para procesar álbum completo
async function processAlbum(albumId) {
  try {
    const albumData = albumMessages.get(albumId);
    if (!albumData) {
      logger.warn(`[ALBUM] No se encontraron datos para álbum: ${albumId}`);
      return;
    }

    const { messages, caption, from, timestamp } = albumData;
    logger.info(`[ALBUM] Procesando álbum con ${messages.length} imágenes de ${from}`);

    // Agregar todos los IDs de mensajes a la lista de procesados
    for (const msg of messages) {
      processedMessageIds.add(msg.key.id);
    }

    // Limpiar IDs antiguos
    if (processedMessageIds.size > _PROCESSED_MESSAGES_MAX_SIZE) {
      const idsArray = Array.from(processedMessageIds);
      processedMessageIds.clear();
      idsArray.slice(-_PROCESSED_MESSAGES_KEEP_SIZE).forEach(id => processedMessageIds.add(id));
    }

    // Crear datos del álbum para el webhook
    const albumMessageData = {
      phoneNumber: from.replace('@c.us', '').replace('@s.whatsapp.net', ''),
      type: _MESSAGE_TYPE_ALBUM,
      from: from,
      id: `album_${albumId}`,
      timestamp: timestamp,
      body: JSON.stringify({
        images: messages.map((msg, index) => ({
          url: `https://wa.me/${msg.key.id}`, // URL de WhatsApp para la imagen
          caption: index === 0 ? caption : '', // Solo caption en la primera imagen
          mimetype: msg.message.imageMessage.mimetype || 'image/jpeg',
          filename: msg.message.imageMessage.fileName || `image_${index + 1}.jpg`
        })),
        totalImages: messages.length,
        caption: caption || ''
      }),
      hasMedia: true,
      data: {
        albumId: albumId,
        totalImages: messages.length,
        images: messages.map((msg, index) => ({
          url: `https://wa.me/${msg.key.id}`,
          caption: index === 0 ? caption : '',
          mimetype: msg.message.imageMessage.mimetype || 'image/jpeg',
          filename: msg.message.imageMessage.fileName || `image_${index + 1}.jpg`
        }))
      },
      isForwarded: false
    };

    // Log del álbum recibido
    logMessage.received(albumMessageData);

    // Enviar webhook si está configurado
    if (ONMESSAGE) {
      try {
        logger.debug(`[WEBHOOK] Enviando webhook de álbum a ${ONMESSAGE} - ${messages.length} imágenes de ${albumMessageData.phoneNumber}`);
        
        // Configuración de axios para el webhook
        const axiosConfig = {
          timeout: 10000, // 10 segundos de timeout
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'WhatsApp-Bot/1.0'
          }
        };
        
        // Enviar webhook del álbum
        await logOnMessageRequest(albumMessageData);
        await axios.post(ONMESSAGE, albumMessageData, axiosConfig);
        
        logger.debug(`[WEBHOOK] Webhook de álbum enviado exitosamente para ${albumMessageData.phoneNumber}`);
      } catch (error) {
        logger.error('Error enviando webhook de álbum ONMESSAGE:', error.message);
        logger.error('Error completo:', error);
        logger.error('URL del webhook:', ONMESSAGE);
        logger.error('Datos enviados:', JSON.stringify(albumMessageData, null, 2));
      }
    }

    // Limpiar datos del álbum
    albumMessages.delete(albumId);
    albumTracker.delete(albumId);
    
    logger.info(`[ALBUM] Álbum procesado completamente: ${albumId} - ${messages.length} imágenes enviadas en un solo webhook`);
  } catch (error) {
    logger.error(`[ALBUM] Error procesando álbum ${albumId}:`, error.message);
    // Limpiar datos en caso de error
    albumMessages.delete(albumId);
    albumTracker.delete(albumId);
  }
}



// Función para manejar mensajes entrantes
async function handleIncomingMessage(msg) {
  try {
    // Verificar si el mensaje ya fue procesado
    if (processedMessageIds.has(msg.key.id)) {
      logger.debug(`[DUPLICATE] Mensaje ya procesado, ignorando: ${msg.key.id}`);
      return;
    }
    
    // Agregar el ID a la lista de procesados
    processedMessageIds.add(msg.key.id);
    
    // Limpiar IDs antiguos
    if (processedMessageIds.size > _PROCESSED_MESSAGES_MAX_SIZE) {
      const idsArray = Array.from(processedMessageIds);
      processedMessageIds.clear();
      idsArray.slice(-_PROCESSED_MESSAGES_KEEP_SIZE).forEach(id => processedMessageIds.add(id));
    }

    // Reutilizar objeto para evitar allocations
    tempMessageData.phoneNumber = msg.key.remoteJid.replace('@c.us', '').replace('@s.whatsapp.net', '');
    tempMessageData.type = _MESSAGE_TYPE_CHAT;
    tempMessageData.from = msg.key.remoteJid;
    tempMessageData.id = msg.key.id;
    tempMessageData.timestamp = msg.messageTimestamp;
    tempMessageData.body = '';
    tempMessageData.hasMedia = false;
    tempMessageData.data = {};
    tempMessageData.isForwarded = false;

    // Verificar si es parte de un álbum
    if (isAlbumMessage(msg)) {
      const albumId = generateAlbumId(msg);
      logger.debug(`[ALBUM] Mensaje de imagen pertenece a álbum: ${albumId}`);
      
      // Agregar mensaje al álbum
      if (!albumMessages.has(albumId)) {
        albumMessages.set(albumId, {
          messages: [],
          caption: msg.message.imageMessage.caption || '',
          from: msg.key.remoteJid,
          timestamp: msg.messageTimestamp
        });
      }
      
      const albumData = albumMessages.get(albumId);
      albumData.messages.push(msg);
      
      logger.debug(`[ALBUM] Álbum ${albumId}: ${albumData.messages.length} imágenes recibidas`);
      
      // Si ya tenemos suficientes mensajes, procesar el álbum inmediatamente
      if (albumData.messages.length >= _ALBUM_MAX_IMAGES) {
        logger.info(`[ALBUM] Máximo de imágenes alcanzado, procesando álbum: ${albumId}`);
        // Cancelar timeout si existe
        if (albumTracker.has(albumId)) {
          clearTimeout(albumTracker.get(albumId));
          albumTracker.delete(albumId);
        }
        await processAlbum(albumId);
      } else {
        // Programar procesamiento del álbum después de un timeout
        if (!albumTracker.has(albumId)) {
          const timeoutId = setTimeout(() => {
            logger.info(`[ALBUM] Timeout alcanzado, procesando álbum: ${albumId}`);
            processAlbum(albumId);
          }, _ALBUM_WAIT_TIMEOUT);
          albumTracker.set(albumId, timeoutId);
        }
      }
      
      return; // No procesar individualmente, esperar a procesar el álbum completo
    }

    // Extraer texto del mensaje
    if (msg.message.conversation) {
      tempMessageData.body = msg.message.conversation;
      tempMessageData.type = _MESSAGE_TYPE_CHAT;
    } else if (msg.message.extendedTextMessage) {
      tempMessageData.body = msg.message.extendedTextMessage.text;
      tempMessageData.type = _MESSAGE_TYPE_CHAT;
      tempMessageData.isForwarded = isMessageForwarded(msg.message.extendedTextMessage);
    } else if (msg.message.imageMessage) {
      tempMessageData.type = _MESSAGE_TYPE_IMAGE;
      tempMessageData.hasMedia = true;
      tempMessageData.body = msg.message.imageMessage.caption || '';
      tempMessageData.data = {
        mimetype: msg.message.imageMessage.mimetype,
        filename: msg.message.imageMessage.fileName || 'image.jpg'
      };
      
      tempMessageData.isForwarded = isMessageForwarded(msg.message.imageMessage);
      
      // Descargar imagen
      logger.debug(`[DOWNLOAD] Preparando descarga de imagen para ${tempMessageData.phoneNumber}`);
      logger.debug(`[DOWNLOAD] Mensaje completo: ${JSON.stringify(msg, null, 2)}`);
      
      try {
        logger.debug(`[DOWNLOAD] Iniciando descarga de imagen para ${tempMessageData.phoneNumber}`);
        logger.debug(`[DOWNLOAD] downloadMediaMessage disponible: ${typeof downloadMediaMessage}`);
        
        const result = await downloadMediaMessage(msg);
        logger.debug(`[DOWNLOAD] Resultado obtenido, tipo: ${typeof result}, constructor: ${result.constructor.name}`);
        
        // Verificar si el resultado es un buffer, stream o un objeto
        let buffer;
        if (Buffer.isBuffer(result)) {
          buffer = result;
          logger.debug(`[DOWNLOAD] Resultado es un Buffer, tamaño: ${buffer.length} bytes`);
        } else if (result && typeof result === 'object') {
          // Si es un objeto, verificar si es un stream
          if (result.readable || result.pipe || result.on) {
            logger.debug(`[DOWNLOAD] Resultado es un Stream, convirtiendo a buffer...`);
            // Es un stream, convertirlo a buffer
            const chunks = [];
            for await (const chunk of result) {
              chunks.push(chunk);
            }
            buffer = Buffer.concat(chunks);
            logger.debug(`[DOWNLOAD] Stream convertido a buffer, tamaño: ${buffer.length} bytes`);
          } else {
            // Si es un objeto, buscar la propiedad que contiene los datos
            logger.debug(`[DOWNLOAD] Resultado es un objeto, propiedades: ${Object.keys(result)}`);
            
            if (result.data) {
              buffer = Buffer.from(result.data);
              logger.debug(`[DOWNLOAD] Datos extraídos de result.data, tamaño: ${buffer.length} bytes`);
            } else if (result.buffer) {
              buffer = Buffer.from(result.buffer);
              logger.debug(`[DOWNLOAD] Datos extraídos de result.buffer, tamaño: ${buffer.length} bytes`);
            } else if (result.content) {
              buffer = Buffer.from(result.content);
              logger.debug(`[DOWNLOAD] Datos extraídos de result.content, tamaño: ${buffer.length} bytes`);
            } else {
              // Intentar convertir todo el objeto a buffer
              buffer = Buffer.from(JSON.stringify(result));
              logger.debug(`[DOWNLOAD] Convertido objeto completo a buffer, tamaño: ${buffer.length} bytes`);
            }
          }
        } else {
          throw new Error(`Tipo de resultado inesperado: ${typeof result}`);
        }
        
        tempMessageData.data.data = buffer.toString('base64');
        logger.debug(`[DOWNLOAD] Imagen descargada exitosamente para ${tempMessageData.phoneNumber}, tamaño: ${buffer.length} bytes, base64: ${tempMessageData.data.data.length} caracteres`);
        
        // Verificar que los datos se guardaron correctamente
        if (tempMessageData.data.data) {
          logger.debug(`[DOWNLOAD] Datos base64 guardados correctamente en tempMessageData.data.data`);
        } else {
          logger.warn(`[DOWNLOAD] ERROR: Los datos base64 no se guardaron correctamente`);
        }
      } catch (error) {
        logger.error(`[DOWNLOAD] Error descargando imagen de ${tempMessageData.phoneNumber}: ${error.message}`);
        logger.error(`[DOWNLOAD] Stack trace: ${error.stack}`);
        logger.error(`[DOWNLOAD] Tipo de error: ${error.constructor.name}`);
        logger.error(`[DOWNLOAD] Error completo: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
        // No es un error crítico, continuar sin los datos de la imagen
      }
    } else if (msg.message.videoMessage) {
      tempMessageData.type = _MESSAGE_TYPE_VIDEO;
      tempMessageData.hasMedia = true;
      tempMessageData.body = msg.message.videoMessage.caption || '';
      tempMessageData.data = {
        mimetype: msg.message.videoMessage.mimetype,
        filename: msg.message.videoMessage.fileName || 'video.mp4'
      };
      
      tempMessageData.isForwarded = isMessageForwarded(msg.message.videoMessage);
      
      try {
        const result = await downloadMediaMessage(msg);
        let buffer;
        
        if (Buffer.isBuffer(result)) {
          buffer = result;
        } else if (result && typeof result === 'object') {
          // Verificar si es un stream
          if (result.readable || result.pipe || result.on) {
            // Es un stream, convertirlo a buffer
            const chunks = [];
            for await (const chunk of result) {
              chunks.push(chunk);
            }
            buffer = Buffer.concat(chunks);
          } else {
            if (result.data) {
              buffer = Buffer.from(result.data);
            } else if (result.buffer) {
              buffer = Buffer.from(result.buffer);
            } else if (result.content) {
              buffer = Buffer.from(result.content);
            } else {
              buffer = Buffer.from(JSON.stringify(result));
            }
          }
        } else {
          throw new Error(`Tipo de resultado inesperado: ${typeof result}`);
        }
        
        tempMessageData.data.data = buffer.toString('base64');
      } catch (error) {
        logger.debug(`No se pudo descargar video de ${tempMessageData.phoneNumber}: ${error.message}`);
        // No es un error crítico, continuar sin los datos del video
      }
    } else if (msg.message.audioMessage) {
      tempMessageData.type = _MESSAGE_TYPE_AUDIO;
      tempMessageData.hasMedia = true;
      tempMessageData.data = {
        mimetype: msg.message.audioMessage.mimetype,
        filename: msg.message.audioMessage.fileName || 'audio.ogg'
      };
      
      tempMessageData.isForwarded = isMessageForwarded(msg.message.audioMessage);
      
      try {
        const result = await downloadMediaMessage(msg);
        let buffer;
        
        if (Buffer.isBuffer(result)) {
          buffer = result;
        } else if (result && typeof result === 'object') {
          // Verificar si es un stream
          if (result.readable || result.pipe || result.on) {
            // Es un stream, convertirlo a buffer
            const chunks = [];
            for await (const chunk of result) {
              chunks.push(chunk);
            }
            buffer = Buffer.concat(chunks);
          } else {
            if (result.data) {
              buffer = Buffer.from(result.data);
            } else if (result.buffer) {
              buffer = Buffer.from(result.buffer);
            } else if (result.content) {
              buffer = Buffer.from(result.content);
            } else {
              buffer = Buffer.from(JSON.stringify(result));
            }
          }
        } else {
          throw new Error(`Tipo de resultado inesperado: ${typeof result}`);
        }
        
        tempMessageData.data.data = buffer.toString('base64');
      } catch (error) {
        logger.debug(`No se pudo descargar audio de ${tempMessageData.phoneNumber}: ${error.message}`);
        // No es un error crítico, continuar sin los datos del audio
      }
    } else if (msg.message.documentMessage) {
      tempMessageData.type = _MESSAGE_TYPE_DOCUMENT;
      tempMessageData.hasMedia = true;
      tempMessageData.body = msg.message.documentMessage.title || '';
      tempMessageData.data = {
        mimetype: msg.message.documentMessage.mimetype,
        filename: msg.message.documentMessage.fileName || 'document'
      };
      
      tempMessageData.isForwarded = isMessageForwarded(msg.message.documentMessage);
      
      try {
        const result = await downloadMediaMessage(msg);
        let buffer;
        
        if (Buffer.isBuffer(result)) {
          buffer = result;
        } else if (result && typeof result === 'object') {
          // Verificar si es un stream
          if (result.readable || result.pipe || result.on) {
            // Es un stream, convertirlo a buffer
            const chunks = [];
            for await (const chunk of result) {
              chunks.push(chunk);
            }
            buffer = Buffer.concat(chunks);
          } else {
            if (result.data) {
              buffer = Buffer.from(result.data);
            } else if (result.buffer) {
              buffer = Buffer.from(result.buffer);
            } else if (result.content) {
              buffer = Buffer.from(result.content);
            } else {
              buffer = Buffer.from(JSON.stringify(result));
            }
          }
        } else {
          throw new Error(`Tipo de resultado inesperado: ${typeof result}`);
        }
        
        tempMessageData.data.data = buffer.toString('base64');
      } catch (error) {
        logger.debug(`No se pudo descargar documento de ${tempMessageData.phoneNumber}: ${error.message}`);
        // No es un error crítico, continuar sin los datos del documento
      }
                 } else if (msg.message.stickerMessage) {
                   // Stickers no soportados - ignorar
                   logger.debug(`[IGNORED] Sticker ignorado de ${tempMessageData.phoneNumber} - soporte deshabilitado`);
                   return; // No procesar stickers
    } else if (msg.message.locationMessage) {
      tempMessageData.type = _MESSAGE_TYPE_LOCATION;
      tempMessageData.data = {
        latitude: msg.message.locationMessage.degreesLatitude,
        longitude: msg.message.locationMessage.degreesLongitude,
        description: msg.message.locationMessage.name || ''
      };
      
      tempMessageData.isForwarded = isMessageForwarded(msg.message.locationMessage);
    } else if (msg.message.contactMessage) {
      tempMessageData.type = _MESSAGE_TYPE_CONTACT;
      tempMessageData.data = {
        vcard: msg.message.contactMessage.vcard
      };
      
      tempMessageData.isForwarded = isMessageForwarded(msg.message.contactMessage);
    } else if (msg.message.protocolMessage) {
      // Manejar mensajes de protocolo (álbumes, reacciones, etc.)
      if (msg.message.protocolMessage.type === _PROTOCOL_MESSAGE_ALBUM) {
        // Los álbumes se manejan de forma especial, no procesar aquí
        logger.debug(`[PROTOCOL] Mensaje de protocolo de álbum recibido de ${tempMessageData.phoneNumber}`);
        return; // No procesar, esperar a que lleguen las imágenes individuales
      } else if (msg.message.protocolMessage.type === _PROTOCOL_MESSAGE_REVOKE) {
        logger.debug(`[PROTOCOL] Mensaje revocado de ${tempMessageData.phoneNumber}`);
        return; // No procesar mensajes revocados
      } else if (msg.message.protocolMessage.type === _PROTOCOL_MESSAGE_EPHEMERAL_SETTING) {
        logger.debug(`[PROTOCOL] Configuración de mensaje efímero de ${tempMessageData.phoneNumber}`);
        return; // No procesar configuraciones
      } else {
        // Otros tipos de protocolMessage no soportados
        logger.debug(`[IGNORED] ProtocolMessage tipo ${msg.message.protocolMessage.type} ignorado de ${tempMessageData.phoneNumber}`);
        return;
      }
    } else {
      // Mensaje de tipo no soportado
      const unsupportedTypes = Object.keys(msg.message).filter(key => 
        !['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 
          'audioMessage', 'documentMessage', 'stickerMessage', 'locationMessage', 
          'contactMessage', 'protocolMessage'].includes(key)
      );
      
      logger.warn(`[UNSUPPORTED] Mensaje de tipo no soportado recibido de ${tempMessageData.phoneNumber}`);
      logger.warn(`[UNSUPPORTED] Tipos detectados: ${unsupportedTypes.join(', ')}`);
      logger.warn(`[UNSUPPORTED] Todos los tipos en el mensaje: ${Object.keys(msg.message).join(', ')}`);
      
      // Log detallado del mensaje no soportado
      logMessage.ignored({
        ...tempMessageData,
        unsupportedTypes: unsupportedTypes,
        allTypes: Object.keys(msg.message)
      }, 'tipo_no_soportado');
      
      return; // No procesar mensajes no soportados
    }

    // Log del mensaje recibido
    logMessage.received(tempMessageData);

    // Enviar webhook si está configurado
    if (ONMESSAGE) {
      try {
        // Log de debug para ver qué se está enviando
        logger.debug(`[WEBHOOK] Enviando webhook a ${ONMESSAGE} - Tipo: ${tempMessageData.type} - De: ${tempMessageData.phoneNumber}`);
        
        // Verificar el estado de los datos antes de crear webhookData
        logger.debug(`[WEBHOOK] Estado de tempMessageData antes de crear webhookData:`);
        logger.debug(`[WEBHOOK] - hasMedia: ${tempMessageData.hasMedia}`);
        logger.debug(`[WEBHOOK] - data: ${JSON.stringify(tempMessageData.data)}`);
        logger.debug(`[WEBHOOK] - data.data existe: ${!!tempMessageData.data.data}`);
        if (tempMessageData.data.data) {
          logger.debug(`[WEBHOOK] - data.data longitud: ${tempMessageData.data.data.length} caracteres`);
        }
        
                 // Crear una copia limpia de los datos para evitar problemas de serialización
         const webhookData = {
           phoneNumber: tempMessageData.phoneNumber,
           type: tempMessageData.type,
           from: tempMessageData.from,
           id: tempMessageData.id,
           timestamp: tempMessageData.timestamp,
           body: tempMessageData.body || '',
           hasMedia: tempMessageData.hasMedia || false,
           data: tempMessageData.data || {},
           
           isForwarded: tempMessageData.isForwarded || false
         };
         
         
        
        // Log para verificar que los datos de media se incluyen correctamente
        if (tempMessageData.hasMedia && tempMessageData.data && tempMessageData.data.data) {
          logger.debug(`[WEBHOOK] Datos de media incluidos para ${tempMessageData.phoneNumber}, tipo: ${tempMessageData.type}, tamaño base64: ${tempMessageData.data.data.length} caracteres`);
          

        } else if (tempMessageData.hasMedia) {
          logger.warn(`[WEBHOOK] Media marcado como true pero no hay datos para ${tempMessageData.phoneNumber}, tipo: ${tempMessageData.type}`);
          

        }
        
        // Verificar que los datos se pueden serializar correctamente
        try {
          JSON.stringify(webhookData);
        } catch (serializeError) {
          logger.error('Error serializando datos del webhook:', serializeError.message);
          logger.error('Datos problemáticos:', webhookData);
          return;
        }
        
        // Configuración de axios para el webhook
        const axiosConfig = {
          timeout: 10000, // 10 segundos de timeout
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'WhatsApp-Bot/1.0'
          }
        };
        
        // Enviar webhook para todos los tipos de mensaje
        await logOnMessageRequest(webhookData);
        

        
        await axios.post(ONMESSAGE, webhookData, axiosConfig);
        
        logger.debug(`[WEBHOOK] Webhook enviado exitosamente para ${tempMessageData.phoneNumber}`);
      } catch (error) {
        logger.error('Error enviando webhook ONMESSAGE:', error.message);
        logger.error('Error completo:', error);
        logger.error('URL del webhook:', ONMESSAGE);
        logger.error('Datos enviados:', JSON.stringify(tempMessageData, null, 2));
      }
    }

  } catch (error) {
    logger.error('Error procesando mensaje entrante:', error.message);
  }
}

// Función para manejar llamadas
async function handleCall(json) {
  try {
    // Verificar que json sea un array y tenga elementos
    if (!Array.isArray(json) || json.length === 0) {
      return;
    }

    const callData = json[0];
    
    // Debug: mostrar información básica de la llamada
    logger.debug(`[CALL_DEBUG] Status: ${callData.status}, ID: ${callData.id}, from: ${callData.from}`);
    
    // Reutilizar objeto para evitar allocations
    tempMessageData.phoneNumber = callData.from.replace('@c.us', '').replace('@s.whatsapp.net', '');
    tempMessageData.type = _MESSAGE_TYPE_CALL;
    tempMessageData.from = callData.from;
    tempMessageData.id = `call_${Date.now()}`;
    tempMessageData.timestamp = Math.floor(Date.now() / 1000);
    tempMessageData.body = 'Llamada entrante rechazada automáticamente';
    tempMessageData.hasMedia = false;
    tempMessageData.data = {
      status: callData.status || 'offer',
      duration: callData.duration || 0,
      callId: callData.id,
      callType: callData.isVideo ? 'video' : 'voice',
      fromMe: false, // Las llamadas entrantes nunca son fromMe
      timestamp: callData.date ? Math.floor(callData.date.getTime() / 1000) : Math.floor(Date.now() / 1000),
      isVideo: callData.isVideo || false,
      isGroup: callData.isGroup || false
    };

    // Solo procesar llamadas de tipo 'offer' (inicio de llamada)
    if (tempMessageData.data.status === 'offer') {
      logger.info(`[CALL] Llamada entrante de ${tempMessageData.phoneNumber}, rechazando automáticamente`);
      
      try {
        // Debug: verificar estado del socket
        logger.debug(`[CALL_DEBUG] Socket disponible: ${!!sock}, rejectCall: ${sock && typeof sock.rejectCall === 'function'}`);
        
        // Rechazar la llamada usando la función correcta de Baileys
        if (sock && typeof sock.rejectCall === 'function') {
          await sock.rejectCall(callData.id, callData.from);
          logger.info(`[CALL] Llamada rechazada exitosamente de ${tempMessageData.phoneNumber}`);
        } else {
          logger.warn('[CALL] Función rejectCall no disponible');
          // Intentar método alternativo
          if (sock && typeof sock.query === 'function') {
            const stanza = {
              tag: 'call',
              attrs: {
                from: sock.authState?.creds?.me?.id,
                to: callData.from,
              },
              content: [{
                tag: 'reject',
                attrs: {
                  'call-id': callData.id,
                  'call-creator': callData.from,
                  count: '0',
                },
                content: undefined,
              }],
            };
            await sock.query(stanza);
            logger.info(`[CALL] Llamada rechazada usando método alternativo de ${tempMessageData.phoneNumber}`);
          }
        }
      } catch (rejectError) {
        logger.error('[CALL] Error rechazando llamada:', rejectError.message);
      }

      // Enviar webhook solo para llamadas rechazadas
      if (ONMESSAGE) {
        try {
          await logOnMessageRequest(tempMessageData);
          
          const axiosConfig = {
            timeout: 10000,
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'WhatsApp-Bot/1.0'
            }
          };
          
          await axios.post(ONMESSAGE, tempMessageData, axiosConfig);
          logger.info(`[CALL] Webhook enviado: llamada rechazada de ${tempMessageData.phoneNumber}`);
        } catch (error) {
          logger.error('[CALL] Error enviando webhook:', error.message);
        }
      }
    }
    // Ignorar otros tipos de llamada (ringing, terminate, etc.) para reducir logs

  } catch (error) {
    logger.error('[CALL] Error procesando llamada:', error.message);
  }
}



// Función para descargar archivo desde URL
async function downloadFromUrl(url, mimetype = 'image/jpeg') {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'WhatsApp-Bot/1.0'
      }
    });
    
    // Reutilizar buffer global para evitar allocations
    tempBuffer = Buffer.from(response.data);
    return tempBuffer;
  } catch (error) {
    logger.error(`Error descargando archivo desde URL ${url}:`, error.message);
    throw new Error(`No se pudo descargar el archivo desde la URL: ${error.message}`);
  }
}

// Función para enviar mensajes
async function sendMessage({ phone, message, type = 'text', media }) {
  try {
    if (!isConnected) {
      logger.warn(`[RECOVERY] Bot no conectado, mensaje rechazado: ${phone} - ${type}`);
      return { success: false, error: 'Bot no conectado' };
    }

    const jid = phone.includes('@c.us') ? phone : `${phone}@c.us`;

    let sentMessage;

    switch (type) {
      case 'text':
        sentMessage = await sock.sendMessage(jid, { text: message });
        break;
      
      case _MESSAGE_TYPE_IMAGE:
        if (media && media.url) {
          // Descargar imagen desde URL
          const buffer = await downloadFromUrl(media.url, media.mimetype);
          sentMessage = await sock.sendMessage(jid, {
            image: buffer,
            caption: message,
            mimetype: media.mimetype || 'image/jpeg'
          });
          
          // Crear JSON con caption y link para el body
          const imageBody = JSON.stringify({
            caption: message || '',
            imageUrl: media.url
          });
          
          // Enviar webhook con el nuevo formato
          if (ONMESSAGE) {
            const webhookData = {
              phoneNumber: jid.replace('@c.us', '').replace('@s.whatsapp.net', ''),
              type: _MESSAGE_TYPE_IMAGE,
              from: jid,
              id: sentMessage.key?.id || `img_${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000),
              body: imageBody,
              hasMedia: true,
              data: {},
              isForwarded: false
            };
            
            await axios.post(ONMESSAGE, webhookData, axiosConfig);
            logger.info(`[WEBHOOK] Imagen enviada con nuevo formato: ${webhookData.phoneNumber}`);
          }
          
        } else if (media && media.data) {
          // Usar datos base64 existentes
          const buffer = Buffer.from(media.data, 'base64');
          sentMessage = await sock.sendMessage(jid, {
            image: buffer,
            caption: message,
            mimetype: media.mimetype || 'image/jpeg'
          });
          
          // Crear JSON con caption para el body (sin URL ya que es base64)
          const imageBody = JSON.stringify({
            caption: message || '',
            imageData: 'base64_data'
          });
          
          // Enviar webhook con el nuevo formato
          if (ONMESSAGE) {
            const webhookData = {
              phoneNumber: jid.replace('@c.us', '').replace('@s.whatsapp.net', ''),
              type: _MESSAGE_TYPE_IMAGE,
              from: jid,
              id: sentMessage.key?.id || `img_${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000),
              body: imageBody,
              hasMedia: true,
              data: {},
              isForwarded: false
            };
            
            await axios.post(ONMESSAGE, webhookData, axiosConfig);
            logger.info(`[WEBHOOK] Imagen base64 enviada con nuevo formato: ${webhookData.phoneNumber}`);
          }
          
        } else {
          throw new Error('URL o datos de imagen requeridos');
        }
        break;
      
      case _MESSAGE_TYPE_VIDEO:
        if (media && media.url) {
          // Descargar video desde URL
          const buffer = await downloadFromUrl(media.url, media.mimetype);
          sentMessage = await sock.sendMessage(jid, {
            video: buffer,
            caption: message,
            mimetype: media.mimetype || 'video/mp4'
          });
        } else if (media && media.data) {
          // Usar datos base64 existentes
          const buffer = Buffer.from(media.data, 'base64');
          sentMessage = await sock.sendMessage(jid, {
            video: buffer,
            caption: message,
            mimetype: media.mimetype || 'video/mp4'
          });
        } else {
          throw new Error('URL o datos de video requeridos');
        }
        break;
      
      case _MESSAGE_TYPE_AUDIO:
        if (media && media.url) {
          // Descargar audio desde URL
          const buffer = await downloadFromUrl(media.url, media.mimetype);
          sentMessage = await sock.sendMessage(jid, {
            audio: buffer,
            mimetype: media.mimetype || 'audio/ogg',
            ptt: false
          });
        } else if (media && media.data) {
          // Usar datos base64 existentes
          const buffer = Buffer.from(media.data, 'base64');
          sentMessage = await sock.sendMessage(jid, {
            audio: buffer,
            mimetype: media.mimetype || 'audio/ogg',
            ptt: false
          });
        } else {
          throw new Error('URL o datos de audio requeridos');
        }
        break;
      
      case _MESSAGE_TYPE_DOCUMENT:
        if (media && media.url) {
          // Descargar documento desde URL
          const buffer = await downloadFromUrl(media.url, media.mimetype);
          sentMessage = await sock.sendMessage(jid, {
            document: buffer,
            mimetype: media.mimetype || 'application/octet-stream',
            fileName: media.filename || 'document'
          });
        } else if (media && media.data) {
          // Usar datos base64 existentes
          const buffer = Buffer.from(media.data, 'base64');
          sentMessage = await sock.sendMessage(jid, {
            document: buffer,
            mimetype: media.mimetype || 'application/octet-stream',
            fileName: media.filename || 'document'
          });
        } else {
          throw new Error('URL o datos de documento requeridos');
        }
        break;
      
      case _MESSAGE_TYPE_LOCATION:
        if (media && media.latitude && media.longitude) {
          sentMessage = await sock.sendMessage(jid, {
            location: {
              degreesLatitude: media.latitude,
              degreesLongitude: media.longitude,
              name: media.description || ''
            }
          });
        } else {
          throw new Error('Coordenadas de ubicación requeridas');
        }
        break;
      
      case _MESSAGE_TYPE_CONTACT:
        if (media && media.contact) {
          // Enviar contacto usando objeto contact
          sentMessage = await sock.sendMessage(jid, {
            contacts: {
              displayName: media.contact.name,
              contacts: [{
                name: media.contact.name,
                number: media.contact.number
              }]
            }
          });
        } else if (media && media.vcard) {
          // Enviar contacto usando vCard
          sentMessage = await sock.sendMessage(jid, {
            contacts: {
              displayName: 'Contact',
              contacts: [{
                vcard: media.vcard
              }]
            }
          });
        } else {
          throw new Error('Datos de contacto requeridos');
        }
        break;
      

      
      default:
        throw new Error(`Tipo de mensaje no soportado: ${type}`);
    }

    // Log simple como solicitado en todo.txt
    console.log(`enviando mensaje a ${phone}: ${message}`);
    
    logger.info(`[SEND] Mensaje enviado exitosamente a ${phone}: ${type}`);
    logger.debug(`[SEND] Message ID: ${sentMessage.key.id}`);
    logger.debug(`[SEND] Timestamp: ${new Date().toISOString()}`);
    logMessage.sent({ phoneNumber: phone, type: type });
    return { success: true, messageId: sentMessage.key.id };

  } catch (error) {
    logger.error(`[SEND] Error enviando mensaje a ${phone}: ${error.message}`);
    logger.error(`[SEND] Tipo de mensaje: ${type}`);
    logger.error(`[SEND] Timestamp: ${new Date().toISOString()}`);
    logger.error(`[SEND] Stack trace: ${error.stack}`);
    logMessage.failed({ phoneNumber: phone, type: type }, error);
    return { success: false, error: error.message };
  }
}

// Health check
async function healthCheck() {
  // Solo ejecutar si el health check está habilitado
  if (!healthCheckEnabled) {
    return;
  }
  
  botStatus.lastHealthCheck = new Date();
  
  try {
    const healthResult = await healthChecker.performFullHealthCheck();
    
    if (healthResult.status === 'error') {
      logger.warn('Health check detectó problemas críticos, iniciando recovery...');
      logRecovery.started('health_check_critical');
      
      // Intentar reiniciar el bot
      if (!botStatus.isReady) {
        await connectToWhatsApp();
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
    
    // Limpiar logs antiguos una vez al día (a las 2 AM)
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() < 5) {
      await cleanupOldLogs();
    }
    
  } catch (error) {
    logger.error('Error en health check:', error.message);
    logRecovery.failed(error, 'health_check');
  }
}

// Configurar cron job para health check - Reducido a cada 5 minutos para reducir ruido
cron.schedule(`0 */5 * * * *`, healthCheck);

// Función para limpiar álbumes expirados
function cleanupExpiredAlbums() {
  try {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [albumId, timeout] of albumTracker.entries()) {
      // Si han pasado más de 30 segundos, limpiar el álbum
      if (now - timeout > 30000) {
        logger.debug(`[ALBUM_CLEANUP] Limpiando álbum expirado: ${albumId}`);
        albumTracker.delete(albumId);
        albumMessages.delete(albumId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.info(`[ALBUM_CLEANUP] Limpiados ${cleanedCount} álbumes expirados`);
    }
  } catch (error) {
    logger.error('[ALBUM_CLEANUP] Error limpiando álbumes expirados:', error.message);
  }
}

// Configurar limpieza de álbumes cada 2 minutos
cron.schedule(`0 */2 * * * *`, cleanupExpiredAlbums);

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
  // Log adicional para requests externos (solo una vez por minuto por IP)
  let clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  
  // Extraer solo la IPv4 si viene con prefijo ::ffff:
  if (clientIP && clientIP.startsWith('::ffff:')) {
    clientIP = clientIP.substring(7);
  }
  
  const isLocalhost = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === 'localhost';
  
  if (!isLocalhost) {
    const now = Date.now();
    const lastLogKey = `health_check_${clientIP}`;
    
    if (!global.lastHealthCheckLog || !global.lastHealthCheckLog[lastLogKey] || 
        (now - global.lastHealthCheckLog[lastLogKey]) > 60000) { // 1 minuto
      
      if (!global.lastHealthCheckLog) global.lastHealthCheckLog = {};
      global.lastHealthCheckLog[lastLogKey] = now;
      
      logger.info(`[HEALTH_CHECK] External health check from ${clientIP} - User-Agent: ${req.headers['user-agent'] || 'Unknown'}`);
    }
  }
  
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

// Endpoint para ver estadísticas del rate limiter
app.get('/api/rate-limit-stats', authenticateToken, (req, res) => {
  const stats = rateLimiter.getStats();
  res.json({
    rate_limit_stats: stats,
    timestamp: new Date().toISOString()
  });
});

// Endpoint para ver información de health checks
app.get('/api/health-info', authenticateToken, (req, res) => {
  const healthStats = healthChecker.getStats();
  res.json({
    health_checker: healthStats,
    bot_status: botStatus,
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

        // Preparar datos para enviar
        const sendData = {
          phone: chatId,
          message: message || '',
          type: 'text'
        };

        // Determinar tipo de contenido y preparar datos
        if (pdfUrl) {
          sendData.type = _MESSAGE_TYPE_DOCUMENT;
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
                type: _MESSAGE_TYPE_IMAGE,
                media: {
                  url: imageUrls[i],
                  mimetype: 'image/jpeg'
                }
              };
              
              const result = await sendMessage(imageData);
              
              if (!result.success) {
                throw new Error(`Error sending image ${i + 1}: ${result.error}`);
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
            }
          }
          
          logger.info(`Successfully sent ${successCount}/${imageUrls.length} images to ${chatId}`);
          return res.json({ status: true, imagesSent: successCount, totalImages: imageUrls.length });
          
        } else if (imageUrl) {
          sendData.type = _MESSAGE_TYPE_IMAGE;
          sendData.media = {
            url: imageUrl,
            mimetype: 'image/jpeg'
          };
          logger.info(`Sending single image to ${chatId}`);
        } else if (contact) {
          sendData.type = _MESSAGE_TYPE_CONTACT;
          sendData.media = {
            contact: contact
          };
          logger.info(`Sending contact to ${chatId}: ${contact.name}`);
        } else if (vcard) {
          sendData.type = _MESSAGE_TYPE_CONTACT;
          sendData.media = {
            vcard: vcard
          };
          logger.info(`Sending vCard to ${chatId}`);

        } else if (message) {
          sendData.type = 'text';
          logger.info(`Sending text message to ${chatId}: ${message}`);
        }

        // Enviar mensaje directamente
        const result = await sendMessage(sendData);
        
        if (result.success) {
          logger.info(`Message sent to ${chatId}`);
          return res.json({ status: true });
        } else {
          throw new Error(result.error || 'Unknown error');
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
            // Intentar reconectar
            await connectToWhatsApp();
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
    
    try {
      // Obtener información del contacto usando las funciones correctas de Baileys
      logger.debug(`Attempting to get contact info for: ${wid}`);
      
      // Intentar obtener el contacto del store
      let contactData = null;
      
      // Primero intentar obtener del store de contactos de Baileys
      if (sock.store && sock.store.contacts) {
        contactData = sock.store.contacts[wid];
        if (contactData) {
          logger.debug(`Contact found in sock.store.contacts`);
        }
      }
      
      // Si no está en store.contacts, intentar en sock.contacts (versiones anteriores)
      if (!contactData && sock.contacts && sock.contacts[wid]) {
        contactData = sock.contacts[wid];
        logger.debug(`Contact found in sock.contacts`);
      }
      
      // Si aún no hay datos, intentar con contactsUpsert para forzar la obtención
      if (!contactData) {
        try {
          if (typeof sock.contactsUpsert === 'function') {
            const contacts = await sock.contactsUpsert([{ id: wid }]);
            if (contacts && contacts.length > 0) {
              contactData = contacts[0];
              logger.debug(`Contact found via contactsUpsert`);
            }
          }
        } catch (upsertError) {
          logger.debug(`contactsUpsert failed: ${upsertError.message}`);
        }
      }
      
      // Si aún no hay datos, intentar obtener información básica del contacto
      if (!contactData) {
        try {
          // Intentar obtener información del contacto usando getContact
          if (typeof sock.getContact === 'function') {
            contactData = await sock.getContact(wid);
            if (contactData) {
              logger.debug(`Contact found via getContact`);
            }
          }
        } catch (getContactError) {
          logger.debug(`getContact failed: ${getContactError.message}`);
        }
      }
      
      // Intentar obtener información adicional del contacto si ya tenemos datos básicos
      if (contactData && contactData.id) {
        try {
          // Intentar obtener el estado del contacto
          if (typeof sock.fetchStatus === 'function') {
            const status = await sock.fetchStatus(wid);
            if (status && status.status) {
              contactData.status = status.status;
              logger.debug(`Status fetched: ${status.status}`);
            }
          }
        } catch (statusError) {
          logger.debug(`fetchStatus failed: ${statusError.message}`);
        }
      }
      
      // Si aún no hay datos, crear uno básico pero intentar obtener pushName
      if (!contactData) {
        contactData = {
          id: wid,
          name: 'Unknown',
          pushName: null,
          verifiedName: null,
          status: null
        };
        logger.debug(`Contact not in store, using default data`);
      }
      
      // Log detallado de la información del contacto encontrada
      logger.debug(`Contact data found:`, {
        id: contactData?.id,
        name: contactData?.name,
        pushName: contactData?.pushName,
        verifiedName: contactData?.verifiedName,
        status: contactData?.status,
        notify: contactData?.notify,
        verified: contactData?.verified
      });
      
      // Intentar obtener foto de perfil
      let profilePicUrl = null;
      try {
        profilePicUrl = await sock.profilePictureUrl(wid, 'image');
        logger.debug(`Profile picture URL obtained: ${profilePicUrl}`);
      } catch (e) {
        // Es normal que algunos contactos no tengan foto
        logger.debug(`No profile picture available for ${wid}: ${e.message}`);
        profilePicUrl = null;
      }
      
      // Verificar si el contacto existe y tiene información válida
      if (!contactData) {
        logger.warn(`Contact not found: ${wid}`);
        return res.status(404).json({ success: false, error: 'Contacto no encontrado' });
      }
      
      // Determinar el nombre del contacto con mejor lógica
      let contactName = 'Unknown';
      
      // Priorizar el nombre guardado en contactos
      if (contactData?.name && contactData.name !== 'Unknown') {
        contactName = contactData.name;
        logger.debug(`Using saved contact name: ${contactName}`);
      }
      // Si no hay nombre guardado, usar pushName (nombre que el usuario estableció en WhatsApp)
      else if (contactData?.pushName && contactData.pushName.trim() !== '') {
        contactName = contactData.pushName;
        logger.debug(`Using pushName: ${contactName}`);
      }
      // Si no hay pushName, usar verifiedName (para cuentas de negocio)
      else if (contactData?.verifiedName && contactData.verifiedName.trim() !== '') {
        contactName = contactData.verifiedName;
        logger.debug(`Using verifiedName: ${contactName}`);
      }
      // Si no hay ningún nombre, usar el número de teléfono
      else {
        contactName = wid.replace('@c.us', '');
        logger.debug(`Using phone number as name: ${contactName}`);
      }
      
      logger.debug(`Final resolved contact name: ${contactName}`);
      
      const contactInfo = {
        id: wid,
        name: contactName,
        number: wid.replace('@c.us', ''),
        isBusiness: contactData?.verifiedName ? true : false,
        profilePicUrl,
        status: contactData?.status || '',
        verified: contactData?.verifiedName ? true : false,
        verifiedName: contactData?.verifiedName || null
      };
      
      logger.info(`Contact info retrieved for ${wid}: ${contactInfo.name}`);
      res.json({
        res: true,
        contact: contactInfo
      });
      
    } catch (err) {
      logger.error(`Error fetching contact info for ${wid}: ${err.message}`);
      logger.error(`Error stack:`, err.stack);
      
      // Manejar errores específicos de Baileys
      if (err.message.includes('not-authorized')) {
        return res.status(403).json({ success: false, error: 'No autorizado para acceder a este contacto' });
      }
      
      if (err.message.includes('not-found')) {
        return res.status(404).json({ success: false, error: 'Contacto no encontrado' });
      }
      
      if (err.message.includes('contactsUpsert is not a function')) {
        logger.error('contactsUpsert function not available in this Baileys version');
        return res.status(500).json({ success: false, error: 'Función de contacto no disponible en esta versión de Baileys' });
      }
      
      res.status(500).json({ success: false, error: 'Error interno al obtener información del contacto' });
    }
    
  } catch (error) {
    logger.error('Error en endpoint de contacto:', error.message);
    res.status(500).json({ 
      res: false, 
      error: 'Error interno del servidor',
      details: error.message 
    });
  }
});

// Función para verificar si ya existe otra instancia corriendo
async function checkExistingInstance() {
  try {
    // Intentar hacer bind a un puerto temporal para verificar si hay otra instancia
    const net = require('net');
    
    return new Promise((resolve) => {
      const tempServer = net.createServer();
      
      tempServer.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Puerto ${PORT} ya está en uso por otra instancia`);
          logger.warn('Cerrando esta instancia para evitar conflictos');
          process.exit(0);
        } else {
          logger.error('Error verificando puerto:', err.message);
          resolve(); // Continuar en caso de error
        }
      });
      
      tempServer.once('listening', () => {
        tempServer.close();
        logger.info('Puerto disponible, continuando con el inicio');
        resolve();
      });
      
      tempServer.listen(PORT);
    });
  } catch (error) {
    logger.error('Error en verificación de instancia única:', error.message);
    // En caso de error, continuar
  }
}

// Variable para controlar el health check
let healthCheckEnabled = false;

// Función para habilitar el health check
function enableHealthCheck() {
  if (!healthCheckEnabled) {
    healthCheckEnabled = true;
    logger.info('Health check habilitado');
  }
}

// Función para deshabilitar el health check
function disableHealthCheck() {
  healthCheckEnabled = false;
  logger.info('Health check deshabilitado');
}

// Iniciar servidor
async function startServer() {
  // Verificar si ya existe otra instancia corriendo ANTES de iniciar el servidor
  await checkExistingInstance();
  
  app.listen(PORT, async () => {
    logger.info(`Servidor iniciado en puerto ${PORT}`);
    logger.info(`Bot name: ${BOT_NAME}`);
    
    // Verificar si la sesión está corrupta
    isSessionCorrupted().then(corrupted => {
      if (corrupted) {
        logger.warn('Sesión corrupta detectada, intentando restaurar desde backup');
        restoreSessionFromBackup().then(restored => {
          if (!restored) {
            logger.warn('No se pudo restaurar desde backup, se creará nueva sesión');
          }
          // Conectar a WhatsApp
          connectToWhatsApp().catch(error => {
            logger.error('[CONNECT] Error fatal conectando a WhatsApp:', error.message);
            logger.error(`[CONNECT] Stack trace: ${error.stack}`);
            logger.error(`[CONNECT] Timestamp: ${new Date().toISOString()}`);
            handleRetry('initial_connection_failed', error);
          });
        });
      } else {
        // Conectar a WhatsApp directamente
        connectToWhatsApp().catch(error => {
          logger.error('[CONNECT] Error fatal conectando a WhatsApp:', error.message);
          logger.error(`[CONNECT] Stack trace: ${error.stack}`);
          logger.error(`[CONNECT] Timestamp: ${new Date().toISOString()}`);
          handleRetry('initial_connection_failed', error);
        });
      }
    });
  });
}



// Iniciar la aplicación
startServer();

// Manejo de señales para shutdown graceful
process.on('SIGINT', async () => {
  logger.info('Recibida señal SIGINT, cerrando aplicación...');
  await backupSession(true); // Backup forzado al shutdown
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Recibida señal SIGTERM, cerrando aplicación...');
  await backupSession(true); // Backup forzado al shutdown
  if (sock) {
    sock.end();
  }
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
    // Intentar cerrar la conexión de WhatsApp de forma limpia
    if (sock) {
      sock.end();
    }
  } catch (e) {
    logger.error('[RECOVERY] Error al cerrar conexión de WhatsApp:', e);
  }
  
  try {
    await connectToWhatsApp();
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
    await connectToWhatsApp();
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






