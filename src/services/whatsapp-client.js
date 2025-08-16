const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const { logger } = require('../logger');
const { generateQRCode } = require('../qr-handler');
const config = require('../config/environment');

class WhatsAppClient {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.sessionDir = 'sessions';
    
    // Logger personalizado para Baileys que filtra mensajes específicos
    this.baileysLogger = {
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
  }

  // Función para conectar WhatsApp
  async connectToWhatsApp(onConnectionUpdate, onMessageReceived, onCallReceived) {
    try {
      logger.info('[CONNECT] Iniciando conexión con WhatsApp...');
      
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      
      this.sock = makeWASocket({
        auth: state,
        logger: this.baileysLogger
      });

      // Manejar eventos de conexión
      this.sock.ev.on('connection.update', async (update) => {
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
          
          this.isConnected = false;
          
          if (onConnectionUpdate) {
            await onConnectionUpdate('close', shouldReconnect, lastDisconnect?.error);
          }
        } else if (connection === 'open') {
          this.isConnected = true;
          logger.info('[CONNECT] Bot conectado exitosamente');
          console.log(`${new Date().toISOString()} info: Bot conectado exitosamente`);
          
          if (onConnectionUpdate) {
            await onConnectionUpdate('open');
          }
        }
      });

      // Manejar credenciales
      this.sock.ev.on('creds.update', saveCreds);

      // Manejar mensajes entrantes
      this.sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        
        // Log detallado de todos los mensajes recibidos
        logger.debug(`[MESSAGE] Mensaje recibido de ${msg.key.remoteJid}, fromMe: ${msg.key.fromMe}, tipo: ${Object.keys(msg.message || {}).join(', ')}`);
        
        // Filtrar mensajes: solo procesar mensajes de chat individual, no de grupos ni status
        if (!msg.key.fromMe && msg.message && 
            !msg.key.remoteJid.includes('@g.us') && 
            !msg.key.remoteJid.includes('@broadcast')) {
          if (onMessageReceived) {
            await onMessageReceived(msg);
          }
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
      this.sock.ev.on('call', async (json) => {
        if (onCallReceived) {
          await onCallReceived(json);
        }
      });

    } catch (error) {
      logger.error('[CONNECT] Error conectando a WhatsApp:', error.message);
      logger.error(`[CONNECT] Stack trace: ${error.stack}`);
      logger.error(`[CONNECT] Timestamp: ${new Date().toISOString()}`);
      throw error;
    }
  }

  // Función para enviar webhook ONDOWN
  async sendOnDownWebhook(reason) {
    if (config.ONDOWN) {
      try {
        await axios.post(config.ONDOWN, {
          bot_name: config.BOT_NAME,
          status: 'logged_out',
          reason: reason,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('[CONNECT] Error enviando webhook ONDOWN:', error.message);
      }
    }
  }

  // Función para obtener el socket
  getSocket() {
    return this.sock;
  }

  // Función para verificar si está conectado
  isConnected() {
    return this.isConnected;
  }

  // Función para cerrar la conexión
  close() {
    if (this.sock) {
      this.sock.end();
      this.isConnected = false;
    }
  }
}

module.exports = WhatsAppClient;
