import { logger } from '../logger.js';
import HttpClient from '../http-client.js';
import SessionManager from './SessionManager.js';
import WhatsAppConnection from './WhatsAppConnection.js';
import AlbumHandler from '../handlers/AlbumHandler.js';
import MessageHandler from '../handlers/MessageHandler.js';
import MessageSender from '../handlers/MessageSender.js';
import CallHandler from '../handlers/CallHandler.js';

/** Retención de logs ONMESSAGE (solo se mantienen archivos más recientes que esto) */
const ONMESSAGE_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
/** No ejecutar limpieza en cada request (evita muchos readdir/stat seguidos) */
const ONMESSAGE_PRUNE_MIN_INTERVAL_MS = 60 * 1000;

let lastOnMessagePruneAt = 0;

/**
 * Elimina JSON en logs/onmessage-requests/ con mtime anterior a 24h.
 */
async function pruneOnMessageRequestLogs(logDir, fs, path) {
  const now = Date.now();
  if (now - lastOnMessagePruneAt < ONMESSAGE_PRUNE_MIN_INTERVAL_MS) {
    return;
  }
  lastOnMessagePruneAt = now;

  const cutoff = now - ONMESSAGE_LOG_RETENTION_MS;
  let removed = 0;

  try {
    const entries = await fs.readdir(logDir);
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const fullPath = path.join(logDir, name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          await fs.unlink(fullPath);
          removed++;
        }
      } catch {
        // archivo borrado por otro proceso o sin acceso
      }
    }
    if (removed > 0) {
      logger.debug(`[ONMESSAGE_LOG] Limpieza: eliminados ${removed} archivo(s) con más de 24h`);
    }
  } catch (err) {
    logger.warn(`[ONMESSAGE_LOG] Error al limpiar logs antiguos: ${err.message}`);
  }
}

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

    await pruneOnMessageRequestLogs(logDir, fs.default, path.default);
  } catch (error) {
    logger.error('[ONMESSAGE_LOG] Error guardando log de request:', error.message);
  }
}

class WhatsAppBot {
  constructor(config, io = null) {
    this.config = config;
    this.io = io;
    
    // Estado del bot
    this.botStatus = {
      isReady: false,
      isConnecting: false,
      isManuallyStopped: false, // Para prevenir reinicios automáticos del health check
      lastHealthCheck: null,
      lastMessageTimestamp: null,
      lastConnectionTime: null, // Timestamp de la última conexión exitosa
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
        logOnMessageRequest,
        () => { this.botStatus.lastMessageTimestamp = new Date(); } // Callback
      );
      
      // MessageSender y CallHandler se inicializarán después de conectar
      // porque necesitan el socket
      
      // Crear conexión
      this.connection = new WhatsAppConnection(
        this.config,
        this.sessionManager,
        this.messageHandler,
        null, // callHandler se asignará después
        this.io
      );
      
      // Callbacks para manejar el ciclo de vida de la conexión
      this.connection.onConnected = (sock) => this.updateHandlers(sock);
      this.connection.onDisconnected = () => {
        logger.warn('[WHATSAPP_BOT] Conexión perdida.');
        this.botStatus.isReady = false;
        this.botStatus.isConnecting = true; // Asumimos que intentará reconectar
        // Limpiar messageSender para evitar usar socket muerto
        this.messageSender = null;
        logger.debug('[WHATSAPP_BOT] MessageSender limpiado debido a desconexión.');
      };
      
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
   * Actualiza los handlers que dependen del socket
   */
  updateHandlers(sock) {
    logger.info('[WHATSAPP_BOT] Conexión establecida. Actualizando handlers...');
    
    // Limpiar MessageSender anterior si existe
    if (this.messageSender) {
      logger.debug('[WHATSAPP_BOT] Limpiando MessageSender anterior...');
      this.messageSender = null;
    }
    
    // Crear MessageSender con el nuevo socket
    this.messageSender = new MessageSender(
      sock,
      this.httpClient,
      this.config.onMessage
    );
    
    // Actualizar CallHandler con el socket
    this.callHandler.updateSocket(sock);

    this.botStatus.isReady = true;
    this.botStatus.isConnecting = false;
    this.botStatus.lastConnectionTime = new Date();
    
    logger.info('[WHATSAPP_BOT] Handlers actualizados correctamente. Bot listo para enviar mensajes.');
  }

  /**
   * Conecta el bot a WhatsApp
   */
  async connect() {
    try {
      this.botStatus.isManuallyStopped = false; // Resetea la detención manual al intentar conectar
      this.botStatus.isConnecting = true;
      this.botStatus.isReady = false;
      
      await this.connection.connect();
      
      // La actualización de handlers y estado se hará en los callbacks
      
      logger.info('[WHATSAPP_BOT] Proceso de conexión iniciado. Esperando estado "open"...');
      
    } catch (error) {
      this.botStatus.isConnecting = false;
      logger.error('[WHATSAPP_BOT] Error conectando bot:', error.message);
      throw error;
    }
  }

  /**
   * Desconecta el bot
   */
  async disconnect({ isLogout = false } = {}) {
    try {
      if (isLogout) {
        this.botStatus.isManuallyStopped = true;
      }
      await this.connection.disconnect({ isLogout });
      this.botStatus.isReady = false;
      this.botStatus.isConnecting = false;
      logger.info('[WHATSAPP_BOT] Bot desconectado');
    } catch (error) {
      logger.error('[WHATSAPP_BOT] Error desconectando bot:', error.message);
    }
  }

  /**
   * Reconecta el bot
   */
  async reconnect() {
    logger.warn('[WHATSAPP_BOT] Iniciando proceso de reconexión forzada...');
    try {
      await this.disconnect();
      // Pequeña pausa para asegurar que todo se cierre correctamente
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.connect();
      logger.info('[WHATSAPP_BOT] Proceso de reconexión forzada completado.');
    } catch (error) {
      logger.error('[WHATSAPP_BOT] Error durante la reconexión forzada:', error.message);
    }
  }

  /**
   * Cierra la sesión de WhatsApp, limpia los datos y reinicia para un nuevo QR.
   */
  async logout() {
    logger.warn('[WHATSAPP_BOT] Iniciando proceso de logout de WhatsApp...');
    try {
      // 1. Desconectar el socket actual, marcando como logout manual
      await this.disconnect({ isLogout: true });
      
      // 2. Limpiar la sesión sin restaurar desde backup
      await this.sessionManager.cleanupSession();
      
      // 3. Reiniciar el proceso de conexión para generar un nuevo QR
      logger.info('[WHATSAPP_BOT] Reiniciando conexión para obtener nuevo QR...');
      await this.connect();
      
      logger.info('[WHATSAPP_BOT] Proceso de logout completado. Esperando nuevo QR.');
    } catch (error) {
      logger.error('[WHATSAPP_BOT] Error durante el proceso de logout:', error.message);
    }
  }

  /**
   * Realiza un chequeo de salud
   */
  async healthCheck() {
    this.botStatus.lastHealthCheck = new Date();

    if (!this.connection || !this.connection.getSocket()) {
      return;
    }

    // Evitar ejecutar health check inmediatamente después de una reconexión (esperar al menos 10 segundos)
    if (this.botStatus.lastConnectionTime) {
      const secondsSinceConnection = (new Date() - this.botStatus.lastConnectionTime) / 1000;
      if (secondsSinceConnection < 10) {
        return;
      }
    }

    const sock = this.connection.getSocket();
    const isWsOpen = sock.ws?.isOpen ?? false;
    const isBotReady = this.isReady();

    // Caso 1: estado interno "listo" pero WebSocket cerrado (zombie). No usar solo isReady() aquí:
    // hasUsableSocketForSending() ya sería false y no entraríamos a reconectar.
    if (this.botStatus.isReady && !isWsOpen) {
      logger.error('[HEALTH_CHECK] ¡FALLO! El bot se reporta como listo pero el WebSocket está cerrado. Forzando reconexión...');
      await this.reconnect();
      return;
    }

    // Caso 2: El bot no está listo y no se está reconectando. Puede que la reconexión automática fallara.
    if (!isBotReady && !this.botStatus.isConnecting && !this.connection.isReconnecting) {
        if (this.botStatus.isManuallyStopped) {
          return;
        }
        logger.error('[HEALTH_CHECK] El bot no está conectado y no parece estar reconectando. Iniciando conexión...');
        await this.connect().catch(e => logger.error('[HEALTH_CHECK] Error al intentar conectar desde health check:', e.message));
        return;
    }
    
    // Caso 3: Chequeo activo. El bot parece listo, pero puede no estar recibiendo mensajes.
    if (isBotReady) { // isWsOpen is implied by Case 1 not triggering
      try {
        // Usamos un timeout para no quedarnos esperando indefinidamente
        await Promise.race([
          sock.sendPresenceUpdate('available'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout en chequeo de presencia')), 15000)) // 15 segundos de timeout
        ]);
        
        // Si el chequeo de presencia es exitoso, verificamos el tiempo de silencio
        if (this.config.healthCheckMaxSilenceMinutes > 0 && this.botStatus.lastMessageTimestamp) {
          const silenceDurationMinutes = (new Date() - this.botStatus.lastMessageTimestamp) / (1000 * 60);
          if (silenceDurationMinutes > this.config.healthCheckMaxSilenceMinutes) {
            logger.error(`[HEALTH_CHECK] No se han recibido mensajes en ${silenceDurationMinutes.toFixed(1)} minutos. Forzando reconexión por posible estado zombie.`);
            await this.reconnect();
            return; // Salimos después de reconectar
          }
        }

      } catch (e) {
        logger.error(`[HEALTH_CHECK] Chequeo de presencia falló: ${e.message}. Forzando reconexión...`);
        await this.reconnect();
      }
    }
  }

  /**
   * Envía un mensaje con lógica de espera y retry
   */
  async sendMessage(data) {
    const maxWaitTime = this.config.messageRetryWaitMs || 15000;
    const pollInterval = this.config.messageRetryPollIntervalMs || 500;
    const maxAttempts = Math.ceil(maxWaitTime / pollInterval);
    
    // Verificar si hay socket usable (evita null.sendMessage tras conflictos / otras sesiones Web)
    if (this.isReady()) {
      logger.debug('[WHATSAPP_BOT] Bot listo, enviando mensaje inmediatamente.');
      return await this.messageSender.sendMessage(data);
    }
    
    // Si no está listo, esperar con polling
    logger.warn(`[WHATSAPP_BOT] Bot no está listo. Esperando reconexión por hasta ${maxWaitTime}ms...`);
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Esperar el intervalo de polling
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      
      if (this.isReady()) {
        logger.info(`[WHATSAPP_BOT] Bot reconectado después de ${attempt * pollInterval}ms. Enviando mensaje.`);
        return await this.messageSender.sendMessage(data);
      }
      
      logger.debug(`[WHATSAPP_BOT] Intento ${attempt}/${maxAttempts}: Bot aún no está listo...`);
    }
    
    // Si llegamos aquí, se agotó el tiempo de espera
    const errorMsg = `Bot no está conectado después de ${maxWaitTime}ms de espera`;
    logger.error(`[WHATSAPP_BOT] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  /**
   * Comprueba que exista un socket Baileys coherente con la conexión y usable para enviar.
   * Evita enviar con bot "listo" en papel pero socket null o WebSocket cerrado (p. ej. conflict stream / otra Web).
   */
  hasUsableSocketForSending() {
    if (!this.botStatus.isReady || !this.messageSender || !this.connection) {
      return false;
    }
    const sock = this.connection.getSocket();
    if (!sock || !this.messageSender.sock || this.messageSender.sock !== sock) {
      return false;
    }
    if (sock.user == null) {
      return false;
    }
    if (sock.ws != null && sock.ws.isOpen === false) {
      return false;
    }
    return true;
  }

  /**
   * Verifica si el bot está listo
   */
  isReady() {
    return this.hasUsableSocketForSending();
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
   * Obtiene el QR actual si existe
   */
  getQRCode() {
    return this.connection ? this.connection.currentQR : null;
  }

  /**
   * Obtiene información de contacto
   */
  async getContactInfo(phoneNumber) {
    if (!this.isReady()) {
      throw new Error('Bot no está conectado');
    }
    
    const sock = this.connection.getSocket();
    
    // Verificar que el socket existe
    if (!sock) {
      throw new Error('Socket no disponible. El bot puede estar reconectando.');
    }
    
    // Detectar si es un LID (Linked ID) o un número de teléfono
    let wid;
    const isLid = phoneNumber.endsWith('@lid');
    
    if (isLid) {
      // Si es LID, usar directamente sin modificar
      wid = phoneNumber;
    } else if (phoneNumber.endsWith('@c.us')) {
      // Si ya tiene @c.us, usar directamente
      wid = phoneNumber;
    } else {
      // Si es número de teléfono, agregar @c.us
      wid = `${phoneNumber}@c.us`;
    }
    
    logger.info(`[WHATSAPP_BOT] Buscando info de contacto: ${wid} (${isLid ? 'LID' : 'phone'})`);
    
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
        // Para LIDs, usar el ID completo; para números, solo el número
        contactName = isLid ? wid : wid.replace('@c.us', '');
      }
      
      // Extraer número de teléfono si está disponible
      // Para LIDs, el número puede no estar disponible por privacidad
      let phoneNumberValue = null;
      if (isLid) {
        // Intentar obtener el número del contacto si está disponible
        phoneNumberValue = contactData?.phoneNumber || contactData?.id?.replace('@c.us', '') || null;
      } else {
        phoneNumberValue = wid.replace('@c.us', '');
      }
      
      return {
        id: wid,
        name: contactName,
        number: phoneNumberValue,
        isBusiness: contactData?.verifiedName ? true : false,
        profilePicUrl,
        status: contactData?.status || '',
        verified: contactData?.verifiedName ? true : false,
        verifiedName: contactData?.verifiedName || null,
        isLid: isLid
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
    
    // Verificar que el socket existe
    if (!sock) {
      throw new Error('Socket no disponible. El bot puede estar reconectando.');
    }
    
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

