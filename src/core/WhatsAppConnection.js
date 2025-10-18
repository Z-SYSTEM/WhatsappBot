import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { logger, logRecovery } from '../logger.js';
import { generateQRCode } from '../qr-handler.js';
import { _WHATSAPP_VERSION } from '../constants.js';

class WhatsAppConnection {
  constructor(config, sessionManager, messageHandler, callHandler) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.messageHandler = messageHandler;
    this.callHandler = callHandler;
    
    // Estado de conexión
    this.sock = null;
    this.isConnected = false;
    this.isReconnecting = false;
    
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
      'Failed to decrypt message'
    ];
    
    const shouldIgnore = (message) => {
      if (typeof message === 'string') {
        if (ignoredMessages.some(ignored => message.includes(ignored))) {
          return true;
        }
        if (message.includes('SessionEntry') || message.includes('Closing session')) {
          return true;
        }
        if (message.includes('Bad MAC') || message.includes('Failed to decrypt message')) {
          return true;
        }
      }
      return false;
    };
    
    return {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (message) => {
        if (!shouldIgnore(message)) {
          console.log(`[WARN] ${message}`);
        }
      },
      error: (message) => {
        if (!shouldIgnore(message)) {
          if (typeof message === 'string' && !message.includes('Bot error:')) {
            console.log(`[ERROR] ${message}`);
          }
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
    
    if (qr) {
      logger.info('[WA_CONNECTION] QR Code generado, escanea con WhatsApp');
      await generateQRCode(qr);
    }
    
    if (connection === 'close') {
      await this.handleConnectionClose(lastDisconnect);
    } else if (connection === 'open') {
      await this.handleConnectionOpen();
    }
  }

  /**
   * Maneja cierre de conexión
   */
  async handleConnectionClose(lastDisconnect) {
    const disconnectReason = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : null;
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
    
    if (shouldReconnect) {
      await this.handleRetry('connection_closed', lastDisconnect?.error);
    } else {
      logger.error('[WA_CONNECTION] Conexión cerrada por logout del usuario - No se reconectará');
      process.exit(1);
    }
  }

  /**
   * Maneja apertura de conexión exitosa
   */
  async handleConnectionOpen() {
    this.isConnected = true;
    this.resetRetryState();
    logger.info('[WA_CONNECTION] Bot conectado exitosamente');
    
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
  async disconnect() {
    if (this.sock) {
      this.sock.end();
      this.isConnected = false;
      logger.info('[WA_CONNECTION] Conexión cerrada');
    }
  }
}

export default WhatsAppConnection;

