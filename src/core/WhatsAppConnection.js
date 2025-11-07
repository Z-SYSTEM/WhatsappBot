import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { logger, logRecovery } from '../logger.js';
// import { generateQRCode } from '../qr-handler.js';
import { _WHATSAPP_VERSION } from '../constants.js';

class WhatsAppConnection {
  constructor(config, sessionManager, messageHandler, callHandler, io = null) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.messageHandler = messageHandler;
    this.callHandler = callHandler;
    this.io = io;
    this.onConnected = null;
    this.onDisconnected = null;
    this.isManualLogout = false; // Flag for manual logout
    
    // Estado de conexión
    this.sock = null;
    this.isConnected = false;
    this.isReconnecting = false;
    this.currentQR = null;
    
    // Sistema de reintentos
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;
    this.lastConnectionTime = null;
    this.connectionTimeout = null;
    
    // Logger personalizado para Baileys
    this.baileysLogger = this.createBaileysLogger();
  }

  /**
   * Crea logger personalizado para Baileys que filtra mensajes
   */
  createBaileysLogger() {
    const ignoredMessages = [
      'Closing open session in favor of incoming prekey bundle',
      'Closing stale open session for new outgoing prekey bundle',
      'Closing session: SessionEntry',
      'SessionEntry',
      'Bot error: Closing open session',
      'Bad MAC',
      'Failed to decrypt message',
      'No matching sessions found for message',
      'Invalid PreKey ID',
      'No session record',
      'No session found to decrypt message'
    ];
    
    const getMessageText = (data) => {
      let text = '';
      if (typeof data === 'string') {
        text = data;
      } else if (data instanceof Error) {
        text = data.message;
      } else if (typeof data === 'object' && data !== null) {
        // Handle pino-like log objects from Baileys
        if (data.err instanceof Error) {
          text = data.err.message;
        } else if (data.msg) {
          text = data.msg;
        }
      }
      return text;
    };

    const shouldIgnore = (data) => {
      const messageText = getMessageText(data);
      if (!messageText) return false;
      
      return ignoredMessages.some(ignored => messageText.includes(ignored));
    };
    
    return {
      trace: () => {},
      debug: () => {},
      info: () => {}, // Silencing info logs from Baileys for a cleaner console
      warn: (data) => {
        if (!shouldIgnore(data)) {
          const message = getMessageText(data) || 'Unknown Baileys Warning';
          logger.warn(`[BAILEYS] ${message}`, { baileysLog: data });
        }
      },
      error: (data) => {
        if (!shouldIgnore(data)) {
          const message = getMessageText(data) || 'Unknown Baileys Error';
          logger.error(`[BAILEYS] ${message}`, { baileysLog: data });
        }
      },
      child: function() { return this; }
    };
  }

  /**
   * Conecta a WhatsApp
   */
  async connect() {
    try {
      logger.info('[WA_CONNECTION] Iniciando conexión con WhatsApp...');
      
      const { state, saveCreds } = await useMultiFileAuthState(this.config.dirs.sessions);
      
      logger.info(`[WA_CONNECTION] Usando Baileys v6.7.20 (versión estable)`);
      
      this.sock = makeWASocket({
        auth: state,
        logger: this.baileysLogger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        version: _WHATSAPP_VERSION,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 250,
        markOnlineOnConnect: true,
        getMessage: async (key) => {
          return { conversation: '' };
        }
      });

      // Configurar eventos
      this.setupEvents(saveCreds);
      
    } catch (error) {
      logger.error('[WA_CONNECTION] Error conectando a WhatsApp:', error.message);
      logger.error(`[WA_CONNECTION] Stack trace: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Configura los event handlers
   */
  setupEvents(saveCreds) {
    // Manejar eventos de conexión
    this.sock.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(update);
    });

    // Manejar credenciales
    this.sock.ev.on('creds.update', saveCreds);

    // Manejar mensajes entrantes
    this.sock.ev.on('messages.upsert', async (m) => {
      await this.handleMessagesUpsert(m);
    });

    // Manejar llamadas
    this.sock.ev.on('call', async (json) => {
      await this.callHandler.handleCall(json);
    });
  }

  /**
   * Maneja actualizaciones de conexión
   */
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;
    
    if (this.io) {
      if (qr) {
        this.currentQR = qr;
        this.io.emit('qr_update', qr);
      }
      if (connection === 'open') {
        this.currentQR = null;
        this.io.emit('status_update', { isReady: true, isConnecting: false, message: 'Bot conectado exitosamente' });
        this.io.emit('qr_update', null);
      } else if (connection === 'close') {
        this.io.emit('status_update', { isReady: false, isConnecting: false, message: 'Bot desconectado' });
      } else if (connection === 'connecting') {
        this.io.emit('status_update', { isReady: false, isConnecting: true, message: 'Conectando...' });
      }
    }
    
    if (qr) {
      logger.info('[WA_CONNECTION] QR Code generado. Ver la interfaz web para escanear.');
    }
    
    if (connection === 'close') {
      await this.handleConnectionClose(lastDisconnect);
    } else if (connection === 'open') {
      await this.handleConnectionOpen();
    } else if (connection === 'connecting') {
      logger.info('[WA_CONNECTION] Conectando...');
    }
  }

  /**
   * Maneja cierre de conexión
   */
  async handleConnectionClose(lastDisconnect) {
    if (this.isManualLogout) {
      logger.info('[WA_CONNECTION] Desconexión intencional por logout. No se reintentará automáticamente.');
      this.isManualLogout = false; // Reset flag after handling
      return;
    }

    const disconnectReason = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : null;

    // Special handling for QR code timeout or failed link
    if (disconnectReason === DisconnectReason.timedOut && this.currentQR) {
      logger.warn('[WA_CONNECTION] QR code scan timed out or failed. Cleaning session to generate a new QR.');
      this.currentQR = null;
      if (this.io) {
        this.io.emit('qr_update', null);
        this.io.emit('status_update', { isReady: false, isConnecting: true, message: 'QR expirado. Generando uno nuevo...' });
      }
      
      await this.sessionManager.cleanupSession();
      
      this.resetRetryState();
      setTimeout(() => {
        logger.info('[WA_CONNECTION] Reconnecting to get a new QR code...');
        this.connect().catch(err => {
          logger.error('[WA_CONNECTION] Error trying to reconnect after QR timeout:', err.message);
        });
      }, 1000);
      return; // Stop further processing
    }

    const shouldReconnect = disconnectReason !== DisconnectReason.loggedOut;
    
    logger.warn('[WA_CONNECTION] Conexión cerrada');
    logger.warn(`[WA_CONNECTION] Razón de desconexión: ${lastDisconnect?.error?.message || 'unknown'}`);
    logger.warn(`[WA_CONNECTION] Código de estado: ${disconnectReason || 'N/A'}`);
    logger.warn(`[WA_CONNECTION] Debería reconectar: ${shouldReconnect}`);
    
    // Log detallado del error completo
    if (lastDisconnect?.error) {
      logger.warn(`[WA_CONNECTION] Error completo: ${JSON.stringify(lastDisconnect.error, null, 2)}`);
    }
    
    // Detectar posible rate limiting o bloqueo de IP
    if (disconnectReason === 405) {
      logger.error('[WA_CONNECTION] ⚠️  ERROR 405 - Posibles causas:');
      logger.error('[WA_CONNECTION] 1. IP bloqueada temporalmente por WhatsApp (rate limiting)');
      logger.error('[WA_CONNECTION] 2. Demasiados intentos de conexión fallidos');
      logger.error('[WA_CONNECTION] 3. Cambiar de IP (VPN, reiniciar router, usar datos móviles)');
      logger.error('[WA_CONNECTION] 4. Esperar 6-24 horas antes de reintentar');
    }
    
    this.isConnected = false;
    if (this.onDisconnected) {
      this.onDisconnected();
    }
    
    if (shouldReconnect) {
      await this.handleRetry('connection_closed', lastDisconnect?.error);
    } else {
      logger.error('[WA_CONNECTION] Conexión cerrada por logout del usuario. Limpiando sesión para generar nuevo QR.');
      
      // Limpiar la sesión (sin restaurar) para forzar un nuevo QR
      await this.sessionManager.cleanupCorrupted({ restoreAfter: false });
      
      // Resetear el estado de reintentos
      this.resetRetryState();
      
      // Intentar reconectar para obtener un nuevo QR
      // Un pequeño delay para asegurar que todo se ha limpiado
      setTimeout(() => {
        logger.info('[WA_CONNECTION] Intentando reconectar para obtener nuevo QR...');
        this.connect().catch(err => {
          logger.error('[WA_CONNECTION] Error al intentar reconectar tras logout:', err.message);
        });
      }, 1000);
    }
  }

  /**
   * Maneja apertura de conexión exitosa
   */
  async handleConnectionOpen() {
    this.isConnected = true;
    this.isManualLogout = false; // Reset flag on successful connection
    this.resetRetryState();
    logger.info('[WA_CONNECTION] Bot conectado exitosamente');
    
    if (this.onConnected) {
      this.onConnected(this.sock);
    }
    
    // Hacer backup de la sesión establecida
    setTimeout(() => {
      this.sessionManager.backup(false);
    }, 5000);
  }

  /**
   * Maneja mensajes entrantes
   */
  async handleMessagesUpsert(m) {
    const msg = m.messages[0];
    
    // Log crudo para depuración
    if (msg) {
        logger.debug(`[WA_CONNECTION] Raw message content: ${JSON.stringify(msg, null, 2)}`);
    } else {
        logger.debug(`[WA_CONNECTION] Received empty messages.upsert event: ${JSON.stringify(m, null, 2)}`);
        return;
    }
    
    logger.debug(`[WA_CONNECTION] Mensaje recibido de ${msg.key.remoteJid}, fromMe: ${msg.key.fromMe}, tipo: ${Object.keys(msg.message || {}).join(', ')}`);
    
    // Filtrar mensajes: procesar mensajes de chat individual y grupos, pero no status
    if (!msg.key.fromMe && msg.message && !msg.key.remoteJid.includes('@broadcast')) {
      await this.messageHandler.handleIncomingMessage(msg);
    } else if (msg.key.fromMe) {
      const messageTypes = Object.keys(msg.message || {});
      if (!messageTypes.includes('protocolMessage')) {
        logger.debug(`[WA_CONNECTION] Mensaje propio ignorado: ${msg.key.remoteJid} - ${messageTypes.join(', ')}`);
      }
    } else if (msg.key.remoteJid.includes('@broadcast')) {
      logger.debug(`[WA_CONNECTION] Mensaje de status ignorado: ${msg.key.remoteJid}`);
    } else if (!msg.message) {
      logger.debug(`[WA_CONNECTION] Mensaje sin contenido ignorado: ${msg.key.remoteJid}`);
    } else {
      logger.warn(`[WA_CONNECTION] Mensaje de tipo desconocido ignorado: ${msg.key.remoteJid}`);
    }
  }

  /**
   * Resetea el estado de reintentos
   */
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

  /**
   * Calcula el delay exponencial con jitter
   */
  calculateRetryDelay(attempt) {
    const baseDelay = this.config.initialReconnectDelay * Math.pow(this.config.reconnectBackoffMultiplier, attempt);
    const maxDelay = Math.min(baseDelay, this.config.maxReconnectDelay);
    
    // Agregar jitter para evitar thundering herd
    const jitter = Math.random() * 0.1 * maxDelay;
    const finalDelay = maxDelay + jitter;
    
    return Math.floor(finalDelay);
  }

  /**
   * Determina si debe reintentar basado en el tipo de error
   */
  shouldRetry(error, disconnectReason) {
    const nonRetryableErrors = [
      'logged_out',
      'not-authorized',
      'forbidden',
      'unauthorized'
    ];
    
    const nonRetryableStatusCodes = [401, 403, 404, 405];
    
    if (disconnectReason === DisconnectReason.loggedOut) {
      return false;
    }
    
    if (error && error.output && nonRetryableStatusCodes.includes(error.output.statusCode)) {
      return false;
    }
    
    const errorMessage = error?.message?.toLowerCase() || '';
    if (nonRetryableErrors.some(err => errorMessage.includes(err))) {
      return false;
    }
    
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      logger.warn(`[WA_CONNECTION] Máximo de fallos consecutivos alcanzado (${this.config.maxConsecutiveFailures})`);
      return false;
    }
    
    return true;
  }

  /**
   * Envía notificación FCM si está configurado
   */
  async sendFCMNotification(message) {
    if (!this.config.fcmDeviceToken) {
      return;
    }

    try {
      const httpClient = (await import('../http-client.js')).default;
      const client = new httpClient();
      
      const notificationData = {
        to: this.config.fcmDeviceToken,
        notification: {
          title: `Bot ${this.config.botName}`,
          body: message,
          priority: 'high'
        },
        data: {
          bot_name: this.config.botName,
          message: message,
          timestamp: new Date().toISOString()
        }
      };

      await client.sendFCMNotification(this.config.fcmDeviceToken, notificationData);
      logRecovery.notification('FCM', message);
    } catch (error) {
      logger.error('[WA_CONNECTION] Error enviando notificación FCM:', error.message);
    }
  }

  /**
   * Maneja reintentos de conexión
   */
  async handleRetry(reason = 'unknown', error = null) {
    if (this.isReconnecting) {
      logger.debug('[WA_CONNECTION] Ya hay un proceso de reconexión en curso, ignorando...');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    this.consecutiveFailures++;

    logger.warn(`[WA_CONNECTION] Iniciando reintento ${this.reconnectAttempts}/${this.config.maxReconnectAttempts}`);
    logger.warn(`[WA_CONNECTION] Razón: ${reason}`);
    logger.warn(`[WA_CONNECTION] Fallos consecutivos: ${this.consecutiveFailures}/${this.config.maxConsecutiveFailures}`);

    // Verificar límites
    if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
      logger.error(`[WA_CONNECTION] Máximo número de reintentos alcanzado (${this.config.maxReconnectAttempts})`);
      
      // Enviar notificación FCM
      await this.sendFCMNotification(
        `Bot ${this.config.botName} - Máximo de reintentos alcanzado después de ${this.reconnectAttempts} intentos`
      );
      
      // Limpiar sesión y reintentar
      logger.warn('[WA_CONNECTION] Limpiando sesión y reintentando...');
      await this.sessionManager.cleanupCorrupted();
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      
      setTimeout(async () => {
        try {
          await this.connect();
        } catch (connectError) {
          logger.error(`[WA_CONNECTION] Error en reintento:`, connectError.message);
          this.isReconnecting = false;
          await this.handleRetry('connection_failed', connectError);
        }
      }, 5000);
      return;
    }

    // Verificar si debe reintentar
    if (!this.shouldRetry(error, reason)) {
      logger.error(`[WA_CONNECTION] Error no reintentable: ${reason}`);
      
      // Limpiar sesión y reintentar
      logger.warn('[WA_CONNECTION] Limpiando sesión y reintentando...');
      await this.sessionManager.cleanupCorrupted();
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      
      setTimeout(async () => {
        try {
          await this.connect();
        } catch (connectError) {
          logger.error(`[WA_CONNECTION] Error en reintento:`, connectError.message);
          this.isReconnecting = false;
          await this.handleRetry('connection_failed', connectError);
        }
      }, 5000);
      return;
    }

    const delay = this.calculateRetryDelay(this.reconnectAttempts - 1);
    logger.info(`[WA_CONNECTION] Esperando ${delay}ms antes del siguiente intento...`);

    this.connectionTimeout = setTimeout(async () => {
      try {
        await this.connect();
      } catch (connectError) {
        logger.error(`[WA_CONNECTION] Error en intento ${this.reconnectAttempts}:`, connectError.message);
        this.isReconnecting = false;
        await this.handleRetry('connection_failed', connectError);
      }
    }, delay);
  }

  /**
   * Obtiene el socket actual
   */
  getSocket() {
    return this.sock;
  }

  /**
   * Verifica si está conectado
   */
  isReady() {
    return this.isConnected;
  }

  /**
   * Cierra la conexión
   */
  async disconnect({ isLogout = false } = {}) {
    this.isManualLogout = isLogout;
    if (this.sock) {
      this.sock.end();
      this.isConnected = false;
      logger.info('[WA_CONNECTION] Conexión cerrada');
    }
  }
}

export default WhatsAppConnection;

