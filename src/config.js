import dotenv from 'dotenv';
import { logger } from './logger.js';
import {
  _DEFAULT_MAX_RECONNECT_ATTEMPTS,
  _DEFAULT_INITIAL_RECONNECT_DELAY,
  _DEFAULT_MAX_RECONNECT_DELAY,
  _DEFAULT_RECONNECT_BACKOFF_MULTIPLIER,
  _DEFAULT_MAX_CONSECUTIVE_FAILURES
} from './constants.js';

dotenv.config();

// Validación de variables de entorno requeridas
const requiredEnvVars = ['BOT_NAME', 'TOKENACCESS', 'PORT'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  logger.error(`Variables de entorno faltantes: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Configuración centralizada
const config = {
  // Configuración básica
  botName: process.env.BOT_NAME,
  tokenAccess: process.env.TOKENACCESS,
  port: process.env.PORT || 4002,
  
  // Webhooks
  onMessage: process.env.ONMESSAGE,
  
  // Notificaciones FCM
  fcmDeviceToken: process.env.FCM_DEVICE_TOKEN,
  
  // Health Check
  healthCheckIntervalSeconds: parseInt(process.env.HEALTH_CHECK_INTERVAL_SECONDS) || 30,
  
  // Llamadas
  acceptCall: process.env.ACCEPT_CALL === 'TRUE',
  
  // Reconexión
  maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || _DEFAULT_MAX_RECONNECT_ATTEMPTS,
  initialReconnectDelay: parseInt(process.env.INITIAL_RECONNECT_DELAY) || _DEFAULT_INITIAL_RECONNECT_DELAY,
  maxReconnectDelay: parseInt(process.env.MAX_RECONNECT_DELAY) || _DEFAULT_MAX_RECONNECT_DELAY,
  reconnectBackoffMultiplier: parseFloat(process.env.RECONNECT_BACKOFF_MULTIPLIER) || _DEFAULT_RECONNECT_BACKOFF_MULTIPLIER,
  maxConsecutiveFailures: parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || _DEFAULT_MAX_CONSECUTIVE_FAILURES,
  
  // Directorios
  dirs: {
    logs: 'logs',
    sessions: 'sessions',
    backups: 'backups'
  }
};

export default config;

