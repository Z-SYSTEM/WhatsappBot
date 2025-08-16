const winston = require('winston');
const fs = require('fs-extra');
require('winston-daily-rotate-file');
const path = require('path'); // Added missing import for path

// Crear directorio de logs si no existe
fs.ensureDirSync('logs');

// Función para obtener la fecha actual en formato YYYY-MM-DD
function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

// Logger unificado optimizado con rotación diaria
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'whatsapp-bot' },
  transports: [
    // Log principal con rotación diaria
    new winston.transports.DailyRotateFile({
      filename: 'logs/whatsapp-bot-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m', // Máximo 20MB por archivo
      maxFiles: '7d', // Mantener logs de 7 días
      zippedArchive: true, // Comprimir archivos antiguos
      level: 'info'
    }),
    
    // Log de errores separado con rotación diaria
    new winston.transports.DailyRotateFile({
      filename: 'logs/errors-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m', // Máximo 10MB por archivo
      maxFiles: '14d', // Mantener errores de 14 días
      zippedArchive: true, // Comprimir archivos antiguos
      level: 'error'
    }),
    
    // Console para desarrollo
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

// Variables reutilizables para evitar allocations
const tempLogData = {};

// Funciones de logging optimizadas que reutilizan objetos
const logMessage = {
  received: (messageData) => {
    tempLogData.type = messageData.type;
    tempLogData.phoneNumber = messageData.phoneNumber;
    tempLogData.hasMedia = messageData.hasMedia;
    tempLogData.timestamp = new Date().toISOString();
    
    // Crear mensaje descriptivo con remitente y contenido
    let logMessage = `Mensaje recibido de ${messageData.phoneNumber}`;
    
    if (messageData.body && messageData.body.trim()) {
      logMessage += `: "${messageData.body}"`;
    } else if (messageData.type !== 'chat') {
      logMessage += ` (${messageData.type})`;
    }
    
    logger.info(logMessage, tempLogData);
  },
  
  sent: (messageData) => {
    tempLogData.type = messageData.type;
    tempLogData.phoneNumber = messageData.phoneNumber;
    tempLogData.success = true;
    tempLogData.timestamp = new Date().toISOString();
    logger.info('Mensaje enviado', tempLogData);
  },
  
  failed: (messageData, error) => {
    tempLogData.type = messageData.type;
    tempLogData.phoneNumber = messageData.phoneNumber;
    tempLogData.error = error.message;
    tempLogData.timestamp = new Date().toISOString();
    logger.error('Error enviando mensaje', tempLogData);
  },
  
  ignored: (messageData, reason) => {
    tempLogData.type = messageData.type;
    tempLogData.phoneNumber = messageData.phoneNumber;
    tempLogData.reason = reason;
    tempLogData.timestamp = new Date().toISOString();
    logger.warn('Mensaje ignorado', tempLogData);
  }
};

const logRecovery = {
  started: (reason) => {
    tempLogData.reason = reason;
    tempLogData.timestamp = new Date().toISOString();
    logger.warn('Recovery iniciado', tempLogData);
  },
  
  success: (details) => {
    tempLogData.details = details;
    tempLogData.timestamp = new Date().toISOString();
    logger.info('Recovery exitoso', tempLogData);
  },
  
  failed: (error, attempt) => {
    tempLogData.error = error.message;
    tempLogData.attempt = attempt;
    tempLogData.timestamp = new Date().toISOString();
    logger.error('Recovery falló', tempLogData);
  },
  
  notification: (type, message) => {
    tempLogData.type = type;
    tempLogData.message = message;
    tempLogData.timestamp = new Date().toISOString();
    logger.info('Notificación enviada', tempLogData);
  }
};

// Función para limpiar logs antiguos (opcional, ya que winston-daily-rotate-file lo hace automáticamente)
async function cleanupOldLogs() {
  try {
    const logDir = 'logs';
    const files = await fs.readdir(logDir);
    
    // Eliminar archivos de log antiguos (más de 30 días)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    for (const file of files) {
      if (file.endsWith('.log') || file.endsWith('.gz')) {
        const filePath = path.join(logDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime < thirtyDaysAgo) {
          await fs.remove(filePath);
          logger.debug(`Log antiguo eliminado: ${file}`);
        }
      }
    }
  } catch (error) {
    logger.error('Error limpiando logs antiguos:', error.message);
  }
}

module.exports = {
  logger,
  logMessage,
  logRecovery,
  cleanupOldLogs
};
