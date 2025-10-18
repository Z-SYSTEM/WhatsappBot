import { logger } from '../logger.js';
import HttpClient from '../http-client.js';
import SessionManager from './SessionManager.js';
import WhatsAppConnection from './WhatsAppConnection.js';
import AlbumHandler from '../handlers/AlbumHandler.js';
import MessageHandler from '../handlers/MessageHandler.js';
import MessageSender from '../handlers/MessageSender.js';
import CallHandler from '../handlers/CallHandler.js';

/**
 * Función para guardar logs de requests POST en onMessage
 */
async function logOnMessageRequest(requestData) {
  try {
    const fs = await import('fs-extra');
    const path = await import('path');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = path.default.join('logs', 'onmessage-requests');
    
    await fs.default.ensureDir(logDir);
    
    const logFile = path.default.join(logDir, `request-${timestamp}.json`);
    
    await fs.default.writeFile(logFile, JSON.stringify(requestData, null, 2));
    
    logger.debug(`[ONMESSAGE_LOG] Request guardado en archivo: ${logFile}`);
  } catch (error) {
    logger.error('[ONMESSAGE_LOG] Error guardando log de request:', error.message);
  }
}

class WhatsAppBot {
  constructor(config) {
    this.config = config;
    
    // Estado del bot
    this.botStatus = {
      isReady: false,
      isConnecting: false,
      lastHealthCheck: null,
      restartAttempts: 0,
      maxRestartAttempts: 3
    };
    
    // Inicializar componentes
    this.httpClient = new HttpClient();
    this.sessionManager = new SessionManager(config.dirs.sessions, config.dirs.backups);
    
    // Inicializar handlers (se configurarán después de crear la conexión)
    this.albumHandler = null;
    this.messageHandler = null;
    this.messageSender = null;
    this.callHandler = null;
    this.connection = null;
  }

  /**
   * Inicializa el bot
   */
  async initialize() {
    try {
      logger.info('[WHATSAPP_BOT] Inicializando bot...');
      
      // Crear handlers
      this.albumHandler = new AlbumHandler(
        this.httpClient,
        this.config.onMessage,
        logOnMessageRequest
      );
      
      this.messageHandler = new MessageHandler(
        this.albumHandler,
        this.httpClient,
        this.config.onMessage,
        logOnMessageRequest
      );
      
      // MessageSender y CallHandler se inicializarán después de conectar
      // porque necesitan el socket
      
      // Crear conexión
      this.connection = new WhatsAppConnection(
        this.config,
        this.sessionManager,
        this.messageHandler,
        null // callHandler se asignará después
      );
      
      // Crear CallHandler con el socket (que se actualizará después de conectar)
      this.callHandler = new CallHandler(
        null, // socket
        this.config.acceptCall,
        this.httpClient,
        this.config.onMessage,
        logOnMessageRequest
      );
      
      // Asignar callHandler a la conexión
      this.connection.callHandler = this.callHandler;
      
      logger.info('[WHATSAPP_BOT] Bot inicializado correctamente');
      
    } catch (error) {
      logger.error('[WHATSAPP_BOT] Error inicializando bot:', error.message);
      throw error;
    }
  }

  /**
   * Conecta el bot a WhatsApp
   */
  async connect() {
    try {
      this.botStatus.isConnecting = true;
      
      await this.connection.connect();
      
      // Obtener socket y actualizar handlers
      const sock = this.connection.getSocket();
      
      // Crear MessageSender con el socket
      this.messageSender = new MessageSender(
        sock,
        this.httpClient,
        this.config.onMessage
      );
      
      // Actualizar CallHandler con el socket
      this.callHandler.updateSocket(sock);
      
      this.botStatus.isReady = true;
      this.botStatus.isConnecting = false;
      
      logger.info('[WHATSAPP_BOT] Bot conectado y listo');
      
    } catch (error) {
      this.botStatus.isConnecting = false;
      logger.error('[WHATSAPP_BOT] Error conectando bot:', error.message);
      throw error;
    }
  }

  /**
   * Desconecta el bot
   */
  async disconnect() {
    try {
      await this.connection.disconnect();
      this.botStatus.isReady = false;
      logger.info('[WHATSAPP_BOT] Bot desconectado');
    } catch (error) {
      logger.error('[WHATSAPP_BOT] Error desconectando bot:', error.message);
    }
  }

  /**
   * Envía un mensaje
   */
  async sendMessage(data) {
    if (!this.isReady()) {
      throw new Error('Bot no está conectado');
    }
    
    return await this.messageSender.sendMessage(data);
  }

  /**
   * Verifica si el bot está listo
   */
  isReady() {
    return this.botStatus.isReady && this.connection.isReady();
  }

  /**
   * Obtiene el estado del bot
   */
  getStatus() {
    return {
      ...this.botStatus,
      isReady: this.isReady(),
      isConnecting: this.botStatus.isConnecting
    };
  }

  /**
   * Obtiene información de contacto
   */
  async getContactInfo(phoneNumber) {
    if (!this.isReady()) {
      throw new Error('Bot no está conectado');
    }
    
    const sock = this.connection.getSocket();
    const wid = phoneNumber.endsWith('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
    
    logger.info(`[WHATSAPP_BOT] Buscando info de contacto: ${wid}`);
    
    try {
      // Obtener información del contacto
      let contactData = null;
      
      if (sock.store && sock.store.contacts) {
        contactData = sock.store.contacts[wid];
      }
      
      if (!contactData && sock.contacts && sock.contacts[wid]) {
        contactData = sock.contacts[wid];
      }
      
      if (!contactData && typeof sock.getContact === 'function') {
        contactData = await sock.getContact(wid);
      }
      
      // Obtener foto de perfil
      let profilePicUrl = null;
      try {
        profilePicUrl = await sock.profilePictureUrl(wid, 'image');
      } catch (e) {
        logger.debug(`[WHATSAPP_BOT] No hay foto de perfil para ${wid}`);
      }
      
      // Determinar el nombre del contacto
      let contactName = 'Unknown';
      
      if (contactData?.name && contactData.name !== 'Unknown') {
        contactName = contactData.name;
      } else if (contactData?.pushName && contactData.pushName.trim() !== '') {
        contactName = contactData.pushName;
      } else if (contactData?.verifiedName && contactData.verifiedName.trim() !== '') {
        contactName = contactData.verifiedName;
      } else {
        contactName = wid.replace('@c.us', '');
      }
      
      return {
        id: wid,
        name: contactName,
        number: wid.replace('@c.us', ''),
        isBusiness: contactData?.verifiedName ? true : false,
        profilePicUrl,
        status: contactData?.status || '',
        verified: contactData?.verifiedName ? true : false,
        verifiedName: contactData?.verifiedName || null
      };
      
    } catch (error) {
      logger.error(`[WHATSAPP_BOT] Error obteniendo info de contacto ${wid}:`, error.message);
      throw error;
    }
  }

  /**
   * Obtiene información de grupo
   */
  async getGroupInfo(groupId) {
    if (!this.isReady()) {
      throw new Error('Bot no está conectado');
    }
    
    const sock = this.connection.getSocket();
    
    logger.info(`[WHATSAPP_BOT] Buscando info de grupo: ${groupId}`);
    
    try {
      // Obtener metadatos del grupo
      let groupMetadata = null;
      
      if (typeof sock.groupMetadata === 'function') {
        groupMetadata = await sock.groupMetadata(groupId);
      } else {
        throw new Error('groupMetadata function not available');
      }
      
      if (!groupMetadata) {
        throw new Error('Grupo no encontrado');
      }
      
      // Obtener foto de perfil del grupo
      let profilePicUrl = null;
      try {
        profilePicUrl = await sock.profilePictureUrl(groupId, 'image');
      } catch (e) {
        logger.debug(`[WHATSAPP_BOT] No hay foto de perfil para grupo ${groupId}`);
      }
      
      // Procesar participantes
      const participants = [];
      const admins = [];
      
      if (groupMetadata.participants && Array.isArray(groupMetadata.participants)) {
        for (const participant of groupMetadata.participants) {
          const participantInfo = {
            id: participant.id,
            number: participant.id.replace('@c.us', '').replace('@s.whatsapp.net', ''),
            isAdmin: participant.admin === 'admin' || participant.admin === 'superadmin',
            isSuperAdmin: participant.admin === 'superadmin'
          };
          
          participants.push(participantInfo);
          
          if (participantInfo.isAdmin) {
            admins.push(participantInfo);
          }
        }
      }
      
      return {
        id: groupId,
        name: groupMetadata.subject || 'Sin nombre',
        description: groupMetadata.desc || '',
        owner: groupMetadata.owner || null,
        creation: groupMetadata.creation || null,
        participantsCount: participants.length,
        participants: participants,
        admins: admins,
        profilePicUrl: profilePicUrl,
        invite: groupMetadata.invite || null,
        size: groupMetadata.size || participants.length,
        restrict: groupMetadata.restrict || false,
        announce: groupMetadata.announce || false
      };
      
    } catch (error) {
      logger.error(`[WHATSAPP_BOT] Error obteniendo info de grupo ${groupId}:`, error.message);
      throw error;
    }
  }

  /**
   * Hace backup de la sesión
   */
  async backupSession(force = false) {
    await this.sessionManager.backup(force);
  }

  /**
   * Limpia álbumes expirados
   */
  cleanupExpiredAlbums() {
    if (this.albumHandler) {
      this.albumHandler.cleanupExpiredAlbums();
    }
  }
}

export default WhatsAppBot;

