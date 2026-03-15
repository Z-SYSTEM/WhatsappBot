import winston from 'winston';
import fs from 'fs-extra';
import 'winston-daily-rotate-file';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Crear directorio de logs si no existe
fs.ensureDirSync('logs');

// Función para obtener la fecha actual en formato YYYY-MM-DD
function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

// Función para formatear timestamp en formato local
function formatTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Colores para niveles personalizados (evita "colors[Colorizer.allColors[lookup]] is not a function")
winston.addColors({
  error: 'red',
  warn: 'yellow',
  info: 'green',
  message: 'cyan',
  debug: 'blue'
});

// Logger unificado optimizado con rotación diaria
const logger = winston.createLogger({
  level: 'info',
  levels: { error: 0, warn: 1, info: 2, message: 2, debug: 5 },
  format: winston.format.combine(
    winston.format.timestamp({ format: formatTimestamp }),
    winston.format.errors({ stack: true })
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
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: formatTimestamp }),
        winston.format.errors({ stack: true }),
        winston.format.json()
      )
    }),
    
    // Log de errores separado con rotación diaria
    new winston.transports.DailyRotateFile({
      filename: 'logs/errors-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m', // Máximo 10MB por archivo
      maxFiles: '14d', // Mantener errores de 14 días
      zippedArchive: true, // Comprimir archivos antiguos
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp({ format: formatTimestamp }),
        winston.format.errors({ stack: true }),
        winston.format.json()
      )
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
    // Crear mensaje descriptivo con remitente y contenido (→ = recibido)
    let logMessage = `▶ ${messageData.phoneNumber}`;
    
    if (messageData.body && messageData.body.trim()) {
      logMessage += `: "${messageData.body}"`;
    } else if (messageData.type !== 'chat') {
      logMessage += ` (${messageData.type})`;
    }
    
    logger.log('message', logMessage, { direction: 'in' });
  },
  
  sent: (messageData) => {
    let logMsg = `◀ ${messageData.phoneNumber}`;
    if (messageData.body && messageData.body.trim()) {
      logMsg += `: "${messageData.body}"`;
    } else {
      logMsg += ` (${messageData.type})`;
    }
    logger.log('message', logMsg, { direction: 'out' });
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

export {
  logger,
  logMessage,
  logRecovery,
  cleanupOldLogs
};
