import { logger, logMessage } from '../logger.js';
import {
  _ALBUM_WAIT_TIMEOUT,
  _ALBUM_MAX_IMAGES,
  _PROCESSED_MESSAGES_MAX_SIZE,
  _PROCESSED_MESSAGES_KEEP_SIZE,
  _MESSAGE_TYPE_ALBUM
} from '../constants.js';

class AlbumHandler {
  constructor(httpClient, onMessageUrl, logOnMessageRequest) {
    this.httpClient = httpClient;
    this.onMessageUrl = onMessageUrl;
    this.logOnMessageRequest = logOnMessageRequest;
    
    // Sistema para manejar álbumes
    this.albumTracker = new Map(); // Trackear álbumes en progreso
    this.albumMessages = new Map(); // Almacenar mensajes de álbumes
    this.processedMessageIds = new Set(); // Set para trackear mensajes ya procesados
  }

  /**
   * Genera ID único de álbum
   */
  generateAlbumId(msg) {
    const remoteJid = msg.key.remoteJid;
    const timestamp = msg.messageTimestamp;
    
    // Si tiene contextInfo con productId, usar eso para agrupar mejor
    if (msg.message?.imageMessage?.contextInfo?.productId) {
      const productId = msg.message.imageMessage.contextInfo.productId;
      return `${remoteJid}_${productId}`;
    }
    
    // Si no tiene productId, usar timestamp con una ventana de tiempo más amplia
    // Agrupar mensajes que lleguen en un rango de 30 segundos
    const timeWindow = Math.floor(timestamp / 30);
    return `${remoteJid}_${timeWindow}`;
  }

  /**
   * Verifica si un mensaje pertenece a un álbum
   */
  isAlbumMessage(msg) {
    // Verificar si es una imagen
    if (!msg.message || !msg.message.imageMessage) {
      return false;
    }
    
    const imageMessage = msg.message.imageMessage;
    
    // Log detallado para debugging
    logger.debug(`[ALBUM_HANDLER] Verificando mensaje ${msg.key.id} para álbum`);
    logger.debug(`[ALBUM_HANDLER] contextInfo: ${JSON.stringify(imageMessage.contextInfo)}`);
    
    // Verificar si tiene contextInfo
    if (!imageMessage.contextInfo) {
      logger.debug(`[ALBUM_HANDLER] No tiene contextInfo, no es álbum`);
      return false;
    }
    
    const contextInfo = imageMessage.contextInfo;
    
    // Un mensaje es parte de un álbum si:
    // 1. Tiene contextInfo
    // 2. No es reenviado (o es undefined/null)
    // 3. Tiene productId (indicador de álbum) o businessOwnerJid
    
    const isNotForwarded = contextInfo.isForwarded === false || contextInfo.isForwarded === undefined || contextInfo.isForwarded === null;
    const hasAlbumIndicator = contextInfo.productId || contextInfo.businessOwnerJid;
    
    const isAlbum = isNotForwarded && hasAlbumIndicator;
    
    logger.debug(`[ALBUM_HANDLER] isNotForwarded: ${isNotForwarded}, hasAlbumIndicator: ${hasAlbumIndicator}, isAlbum: ${isAlbum}`);
    
    return isAlbum;
  }

  /**
   * Agrega un mensaje a un álbum
   */
  addToAlbum(msg, albumId) {
    logger.debug(`[ALBUM_HANDLER] Mensaje de imagen pertenece a álbum: ${albumId}`);
    
    // Agregar mensaje al álbum
    if (!this.albumMessages.has(albumId)) {
      this.albumMessages.set(albumId, {
        messages: [],
        caption: msg.message.imageMessage.caption || '',
        from: msg.key.remoteJid,
        timestamp: msg.messageTimestamp
      });
    }
    
    const albumData = this.albumMessages.get(albumId);
    albumData.messages.push(msg);
    
    logger.debug(`[ALBUM_HANDLER] Álbum ${albumId}: ${albumData.messages.length} imágenes recibidas`);
    
    // Si ya tenemos suficientes mensajes, procesar el álbum inmediatamente
    if (albumData.messages.length >= _ALBUM_MAX_IMAGES) {
      logger.info(`[ALBUM_HANDLER] Máximo de imágenes alcanzado, procesando álbum: ${albumId}`);
      // Cancelar timeout si existe
      if (this.albumTracker.has(albumId)) {
        clearTimeout(this.albumTracker.get(albumId));
        this.albumTracker.delete(albumId);
      }
      this.processAlbum(albumId);
    } else {
      // Programar procesamiento del álbum después de un timeout
      if (!this.albumTracker.has(albumId)) {
        const timeoutId = setTimeout(() => {
          logger.info(`[ALBUM_HANDLER] Timeout alcanzado, procesando álbum: ${albumId}`);
          this.processAlbum(albumId);
        }, _ALBUM_WAIT_TIMEOUT);
        this.albumTracker.set(albumId, timeoutId);
      }
    }
  }

  /**
   * Procesa un álbum completo
   */
  async processAlbum(albumId) {
    try {
      const albumData = this.albumMessages.get(albumId);
      if (!albumData) {
        logger.warn(`[ALBUM_HANDLER] No se encontraron datos para álbum: ${albumId}`);
        return;
      }

      const { messages, caption, from, timestamp } = albumData;
      logger.info(`[ALBUM_HANDLER] Procesando álbum con ${messages.length} imágenes de ${from}`);

      // Agregar todos los IDs de mensajes a la lista de procesados
      for (const msg of messages) {
        this.processedMessageIds.add(msg.key.id);
      }

      // Limpiar IDs antiguos
      this.cleanupProcessedIds();

      // Crear datos del álbum para el webhook
      const albumMessageData = {
        phoneNumber: from.replace('@c.us', '').replace('@s.whatsapp.net', ''),
        type: _MESSAGE_TYPE_ALBUM,
        from: from,
        id: `album_${albumId}`,
        timestamp: timestamp,
        body: JSON.stringify({
          images: messages.map((msg, index) => ({
            url: `https://wa.me/${msg.key.id}`,
            caption: index === 0 ? caption : '',
            mimetype: msg.message.imageMessage.mimetype || 'image/jpeg',
            filename: msg.message.imageMessage.fileName || `image_${index + 1}.jpg`
          })),
          totalImages: messages.length,
          caption: caption || ''
        }),
        hasMedia: true,
        data: {
          albumId: albumId,
          totalImages: messages.length,
          images: messages.map((msg, index) => ({
            url: `https://wa.me/${msg.key.id}`,
            caption: index === 0 ? caption : '',
            mimetype: msg.message.imageMessage.mimetype || 'image/jpeg',
            filename: msg.message.imageMessage.fileName || `image_${index + 1}.jpg`
          }))
        },
        isForwarded: false
      };

      // Log del álbum recibido
      logMessage.received(albumMessageData);

      // Enviar webhook si está configurado
      if (this.onMessageUrl) {
        try {
          logger.debug(`[ALBUM_HANDLER] Enviando webhook de álbum a ${this.onMessageUrl} - ${messages.length} imágenes de ${albumMessageData.phoneNumber}`);
          
          await this.httpClient.sendWebhook(this.onMessageUrl, albumMessageData, this.logOnMessageRequest);
          
          logger.debug(`[ALBUM_HANDLER] Webhook de álbum enviado exitosamente para ${albumMessageData.phoneNumber}`);
        } catch (error) {
          logger.error('[ALBUM_HANDLER] Error enviando webhook de álbum:', error.message);
        }
      }

      // Limpiar datos del álbum
      this.albumMessages.delete(albumId);
      this.albumTracker.delete(albumId);
      
      logger.info(`[ALBUM_HANDLER] Álbum procesado completamente: ${albumId} - ${messages.length} imágenes enviadas en un solo webhook`);
    } catch (error) {
      logger.error(`[ALBUM_HANDLER] Error procesando álbum ${albumId}:`, error.message);
      // Limpiar datos en caso de error
      this.albumMessages.delete(albumId);
      this.albumTracker.delete(albumId);
    }
  }

  /**
   * Verifica si un mensaje ya fue procesado
   */
  isProcessed(messageId) {
    return this.processedMessageIds.has(messageId);
  }

  /**
   * Marca un mensaje como procesado
   */
  markAsProcessed(messageId) {
    this.processedMessageIds.add(messageId);
    this.cleanupProcessedIds();
  }

  /**
   * Limpia IDs procesados antiguos
   */
  cleanupProcessedIds() {
    if (this.processedMessageIds.size > _PROCESSED_MESSAGES_MAX_SIZE) {
      const idsArray = Array.from(this.processedMessageIds);
      this.processedMessageIds.clear();
      idsArray.slice(-_PROCESSED_MESSAGES_KEEP_SIZE).forEach(id => this.processedMessageIds.add(id));
    }
  }

  /**
   * Limpia álbumes expirados
   */
  cleanupExpiredAlbums() {
    try {
      const now = Date.now();
      let cleanedCount = 0;
      
      for (const [albumId, timeout] of this.albumTracker.entries()) {
        // Si han pasado más de 30 segundos, limpiar el álbum
        if (now - timeout > 30000) {
          logger.debug(`[ALBUM_HANDLER] Limpiando álbum expirado: ${albumId}`);
          this.albumTracker.delete(albumId);
          this.albumMessages.delete(albumId);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`[ALBUM_HANDLER] Limpiados ${cleanedCount} álbumes expirados`);
      }
    } catch (error) {
      logger.error('[ALBUM_HANDLER] Error limpiando álbumes expirados:', error.message);
    }
  }
}

export default AlbumHandler;

