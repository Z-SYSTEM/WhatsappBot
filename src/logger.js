const winston = require('winston');
const fs = require('fs-extra');

// Crear directorio de logs si no existe
fs.ensureDirSync('logs');

// Configuración del logger principal
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'whatsapp-bot' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          return `${timestamp} ${level}: ${message}`;
        })
      )
    })
  ]
});

// Logger específico para mensajes
const messageLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'whatsapp-messages' },
  transports: [
    new winston.transports.File({ filename: 'logs/messages.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          return `${timestamp} ${level}: ${message}`;
        })
      )
    })
  ]
});

// Logger específico para recovery
const recoveryLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'whatsapp-recovery' },
  transports: [
    new winston.transports.File({ filename: 'logs/recovery.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          return `${timestamp} ${level}: ${message}`;
        })
      )
    })
  ]
});

// Funciones de logging específicas
const logMessage = {
  received: (messageData) => {
    messageLogger.info('Mensaje recibido', {
      type: messageData.type,
      phoneNumber: messageData.phoneNumber,
      hasMedia: messageData.hasMedia,
      timestamp: new Date().toISOString()
    });
  },
  
  sent: (messageData) => {
    messageLogger.info('Mensaje enviado', {
      type: messageData.type,
      phoneNumber: messageData.phoneNumber,
      success: true,
      timestamp: new Date().toISOString()
    });
  },
  
  failed: (messageData, error) => {
    messageLogger.error('Error enviando mensaje', {
      type: messageData.type,
      phoneNumber: messageData.phoneNumber,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  },
  
  ignored: (messageData, reason) => {
    messageLogger.warn('Mensaje ignorado', {
      type: messageData.type,
      phoneNumber: messageData.phoneNumber,
      reason: reason,
      timestamp: new Date().toISOString()
    });
  }
};

const logRecovery = {
  started: (reason) => {
    recoveryLogger.warn('Recovery iniciado', {
      reason: reason,
      timestamp: new Date().toISOString()
    });
  },
  
  success: (details) => {
    recoveryLogger.info('Recovery exitoso', {
      details: details,
      timestamp: new Date().toISOString()
    });
  },
  
  failed: (error, attempt) => {
    recoveryLogger.error('Recovery falló', {
      error: error.message,
      attempt: attempt,
      timestamp: new Date().toISOString()
    });
  },
  
  notification: (type, message) => {
    recoveryLogger.info('Notificación enviada', {
      type: type,
      message: message,
      timestamp: new Date().toISOString()
    });
  }
};

module.exports = {
  logger,
  messageLogger,
  recoveryLogger,
  logMessage,
  logRecovery
};
