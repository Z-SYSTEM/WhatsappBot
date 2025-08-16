const axios = require('axios');
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { logger } = require('../logger');
const config = require('../config/environment');

class RecoveryManager {
  constructor() {
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.MAX_RECONNECT_ATTEMPTS;
    this.initialReconnectDelay = config.INITIAL_RECONNECT_DELAY;
    this.maxReconnectDelay = config.MAX_RECONNECT_DELAY;
    this.reconnectBackoffMultiplier = config.RECONNECT_BACKOFF_MULTIPLIER;
    this.isReconnecting = false;
    this.lastConnectionTime = null;
    this.connectionTimeout = null;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = config.MAX_CONSECUTIVE_FAILURES;
    this.restartCount = 0;
  }

  // Función para resetear el estado de reintentos
  resetRetryState() {
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;
    this.isReconnecting = false;
    this.lastConnectionTime = new Date();
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  // Función para calcular el delay exponencial con jitter
  calculateRetryDelay(attempt) {
    const baseDelay = this.initialReconnectDelay * Math.pow(this.reconnectBackoffMultiplier, attempt);
    const maxDelay = Math.min(baseDelay, this.maxReconnectDelay);
    
    // Agregar jitter para evitar thundering herd
    const jitter = Math.random() * 0.1 * maxDelay; // 10% de jitter
    const finalDelay = maxDelay + jitter;
    
    return Math.floor(finalDelay);
  }

  // Función para determinar si debe reintentar basado en el tipo de error
  shouldRetry(error, disconnectReason) {
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
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      logger.warn(`[RETRY] Máximo de fallos consecutivos alcanzado (${this.maxConsecutiveFailures})`);
      return false;
    }
    
    return true;
  }

  // Función para enviar notificación FCM
  async sendFCMNotification(message) {
    if (!config.FCM_DEVICE_TOKEN) {
      logger.warn('FCM_DEVICE_TOKEN no configurado, no se enviará notificación push');
      return;
    }

    try {
      const notificationData = {
        to: config.FCM_DEVICE_TOKEN,
        notification: {
          title: `Bot ${config.BOT_NAME}`,
          body: message,
          priority: 'high'
        },
        data: {
          bot_name: config.BOT_NAME,
          message: message,
          timestamp: new Date().toISOString()
        }
      };

      await axios.post('https://fcm.googleapis.com/fcm/send', notificationData, {
        headers: {
          'Authorization': `key=${config.FCM_DEVICE_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      logger.info('Notificación FCM enviada exitosamente');
    } catch (error) {
      logger.error('Error enviando notificación FCM:', error.message);
    }
  }

  // Función para manejar reintentos con límites mejorados
  async handleRetry(reason = 'unknown', error = null, connectFunction) {
    if (this.isReconnecting) {
      logger.debug('[RETRY] Ya hay un proceso de reconexión en curso, ignorando...');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    this.consecutiveFailures++;

    logger.warn(`[RETRY] Iniciando reintento ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
    logger.warn(`[RETRY] Razón: ${reason}`);
    logger.warn(`[RETRY] Fallos consecutivos: ${this.consecutiveFailures}/${this.maxConsecutiveFailures}`);
    logger.warn(`[RETRY] Timestamp: ${new Date().toISOString()}`);

    // Verificar límites
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      logger.error(`[RETRY] Máximo número de reintentos alcanzado (${this.maxReconnectAttempts})`);
      logger.error(`[RETRY] Fallos consecutivos: ${this.consecutiveFailures}`);
      
      // Enviar notificación FCM si está configurado
      await this.sendFCMNotification(`Máximo de reintentos alcanzado después de ${this.reconnectAttempts} intentos`);
      
      process.exit(1);
    }

    // Verificar si debe reintentar basado en el tipo de error
    if (!this.shouldRetry(error, reason)) {
      logger.error(`[RETRY] Error no reintentable: ${reason}`);
      process.exit(1);
    }

    const delay = this.calculateRetryDelay(this.reconnectAttempts - 1);
    logger.info(`[RETRY] Esperando ${delay}ms antes del siguiente intento...`);
    logger.info(`[RETRY] Delay calculado: base=${this.initialReconnectDelay * Math.pow(this.reconnectBackoffMultiplier, this.reconnectAttempts - 1)}, final=${delay}ms`);

    this.connectionTimeout = setTimeout(async () => {
      try {
        await connectFunction();
      } catch (connectError) {
        logger.error(`[RETRY] Error en intento ${this.reconnectAttempts}:`, connectError.message);
        this.isReconnecting = false;
        await this.handleRetry('connection_failed', connectError, connectFunction);
      }
    }, delay);
  }

  // Función para manejar errores no capturados
  async handleUncaughtException(err, connectFunction) {
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
    this.restartCount++;
    logger.warn(`[RECOVERY] Intentando reinicio #${this.restartCount} para instancia: ${config.BOT_NAME} por uncaughtException. Motivo: ${err && err.message}`);
    
    // Notificación push de cuelgue
    await this.sendFCMNotification(`Bot ${config.BOT_NAME} se colgó por uncaughtException: ${err && err.message} | Tipo: ${errorType}`);
    
    // Intentar recuperación ante cualquier error
    try {
      await connectFunction();
      logger.info('[RECOVERY] Bot reiniciado tras uncaughtException.');
      
      // Notificación push de recuperación
      await this.sendFCMNotification(`Bot ${config.BOT_NAME} fue reiniciado tras uncaughtException. | Tipo: ${errorType}`);
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
  }

  // Función para manejar promesas rechazadas no manejadas
  async handleUnhandledRejection(reason, connectFunction) {
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
    this.restartCount++;
    logger.warn(`[RECOVERY] Intentando reinicio #${this.restartCount} para instancia: ${config.BOT_NAME} por unhandledRejection. Motivo: ${reason && reason.message}`);
    
    // Notificación push de cuelgue
    await this.sendFCMNotification(`Bot ${config.BOT_NAME} se colgó por unhandledRejection: ${reason && reason.message} | Tipo: ${errorType}`);
    
    // Intentar recuperación
    try {
      await connectFunction();
      logger.info('[RECOVERY] Bot reiniciado tras unhandledRejection.');
      
      // Notificación push de recuperación
      await this.sendFCMNotification(`Bot ${config.BOT_NAME} fue reiniciado tras unhandledRejection. | Tipo: ${errorType}`);
    } catch (e) {
      logger.error('[RECOVERY] Error al reiniciar bot tras unhandledRejection:', e);
    }
  }
}

module.exports = RecoveryManager;
