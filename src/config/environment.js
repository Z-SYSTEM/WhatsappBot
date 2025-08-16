const { logger } = require('../logger');

// Validación de variables de entorno
const requiredEnvVars = ['BOT_NAME', 'TOKENACCESS', 'PORT'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  logger.error(`Variables de entorno faltantes: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Configuración del entorno
const config = {
  BOT_NAME: process.env.BOT_NAME,
  TOKENACCESS: process.env.TOKENACCESS,
  PORT: process.env.PORT || 4002,
  ONDOWN: process.env.ONDOWN,
  ONMESSAGE: process.env.ONMESSAGE,
  FCM_DEVICE_TOKEN: process.env.FCM_DEVICE_TOKEN,
  HEALTH_CHECK_INTERVAL_SECONDS: parseInt(process.env.HEALTH_CHECK_INTERVAL_SECONDS) || 30,
  
  // Variables para el sistema de reintentos
  MAX_RECONNECT_ATTEMPTS: parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10,
  INITIAL_RECONNECT_DELAY: parseInt(process.env.INITIAL_RECONNECT_DELAY) || 5000,
  MAX_RECONNECT_DELAY: parseInt(process.env.MAX_RECONNECT_DELAY) || 300000,
  RECONNECT_BACKOFF_MULTIPLIER: parseFloat(process.env.RECONNECT_BACKOFF_MULTIPLIER) || 2.0,
  MAX_CONSECUTIVE_FAILURES: parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || 3,
  
  // Rate limiting
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 300,
  RATE_LIMIT_BLOCK_DURATION_MS: parseInt(process.env.RATE_LIMIT_BLOCK_DURATION_MS) || 15 * 60 * 1000
};

module.exports = config;
