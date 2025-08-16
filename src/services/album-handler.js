const { logger } = require('../logger');
const { logMessage } = require('../logger');
const constants = require('../config/constants');

class AlbumHandler {
  constructor() {
    this.albumTracker = new Map(); // Trackear álbumes en progreso
    this.albumMessages = new Map(); // Almacenar mensajes de álbumes
  }

  // Función para generar ID único de álbum
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

  // Función para verificar si un mensaje pertenece a un álbum
  isAlbumMessage(msg) {
    // Verificar si es una imagen
    if (!msg.message || !msg.message.imageMessage) {
      return false;
    }
    
    const imageMessage = msg.message.imageMessage;
    
    // Log detallado para debugging
    logger.debug(`[ALBUM_CHECK] Verificando mensaje ${msg.key.id} para álbum`);
    logger.debug(`[ALBUM_CHECK] contextInfo: ${JSON.stringify(imageMessage.contextInfo)}`);
    logger.debug(`[ALBUM_CHECK] productId: ${imageMessage.contextInfo?.productId}`);
    logger.debug(`[ALBUM_CHECK] businessOwnerJid: ${imageMessage.contextInfo?.businessOwnerJid}`);
    logger.debug(`[ALBUM_CHECK] isForwarded: ${imageMessage.contextInfo?.isForwarded}`);
    
    // Verificar si tiene contextInfo
    if (!imageMessage.contextInfo) {
      logger.debug(`[ALBUM_CHECK] No tiene contextInfo, no es álbum`);
      return false;
    }
    
    const contextInfo = imageMessage.contextInfo;
    
    // Un mensaje es parte de un álbum si:
    // 1. Tiene contextInfo
    // 2. No es reenviado (o es undefined/null)
    // 3. Tiene productId (indicador de álbum)
    // 4. O tiene businessOwnerJid (indicador de álbum de negocio)
    // 5. O tiene isForwarded = false explícitamente
    
    const isNotForwarded = contextInfo.isForwarded === false || contextInfo.isForwarded === undefined || contextInfo.isForwarded === null;
    const hasAlbumIndicator = contextInfo.productId || contextInfo.businessOwnerJid;
    
    const isAlbum = isNotForwarded && hasAlbumIndicator;
    
    logger.debug(`[ALBUM_CHECK] isNotForwarded: ${isNotForwarded}, hasAlbumIndicator: ${hasAlbumIndicator}, isAlbum: ${isAlbum}`);
    
    return isAlbum;
  }

  // Función para procesar álbum completo
  async processAlbum(albumId, processedMessageIds, onMessageCallback) {
    try {
      const albumData = this.albumMessages.get(albumId);
      if (!albumData) {
        logger.warn(`[ALBUM] No se encontraron datos para álbum: ${albumId}`);
        return;
      }

      const { messages, caption, from, timestamp } = albumData;
      logger.info(`[ALBUM] Procesando álbum con ${messages.length} imágenes de ${from}`);

      // Agregar todos los IDs de mensajes a la lista de procesados
      for (const msg of messages) {
        processedMessageIds.add(msg.key.id);
      }

      // Limpiar IDs antiguos
      if (processedMessageIds.size > constants.PROCESSED_MESSAGES_MAX_SIZE) {
        const idsArray = Array.from(processedMessageIds);
        processedMessageIds.clear();
        idsArray.slice(-constants.PROCESSED_MESSAGES_KEEP_SIZE).forEach(id => processedMessageIds.add(id));
      }

      // Crear datos del álbum para el webhook
      const albumMessageData = {
        phoneNumber: from.replace('@c.us', '').replace('@s.whatsapp.net', ''),
        type: constants.MESSAGE_TYPE_ALBUM,
        from: from,
        id: `album_${albumId}`,
        timestamp: timestamp,
        body: JSON.stringify({
          images: messages.map((msg, index) => ({
            url: `https://wa.me/${msg.key.id}`, // URL de WhatsApp para la imagen
            caption: index === 0 ? caption : '', // Solo caption en la primera imagen
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
      if (onMessageCallback) {
        await onMessageCallback(albumMessageData);
      }

      // Limpiar datos del álbum
      this.albumMessages.delete(albumId);
      this.albumTracker.delete(albumId);
      
      logger.info(`[ALBUM] Álbum procesado completamente: ${albumId} - ${messages.length} imágenes enviadas en un solo webhook`);
    } catch (error) {
      logger.error(`[ALBUM] Error procesando álbum ${albumId}:`, error.message);
      // Limpiar datos en caso de error
      this.albumMessages.delete(albumId);
      this.albumTracker.delete(albumId);
    }
  }

  // Función para agregar mensaje a álbum
  async addMessageToAlbum(msg, processedMessageIds, onMessageCallback) {
    const albumId = this.generateAlbumId(msg);
    logger.debug(`[ALBUM] Mensaje de imagen pertenece a álbum: ${albumId}`);
    
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
    
    logger.debug(`[ALBUM] Álbum ${albumId}: ${albumData.messages.length} imágenes recibidas`);
    
    // Si ya tenemos suficientes mensajes, procesar el álbum inmediatamente
    if (albumData.messages.length >= constants.ALBUM_MAX_IMAGES) {
      logger.info(`[ALBUM] Máximo de imágenes alcanzado, procesando álbum: ${albumId}`);
      // Cancelar timeout si existe
      if (this.albumTracker.has(albumId)) {
        clearTimeout(this.albumTracker.get(albumId));
        this.albumTracker.delete(albumId);
      }
      await this.processAlbum(albumId, processedMessageIds, onMessageCallback);
    } else {
      // Programar procesamiento del álbum después de un timeout
      if (!this.albumTracker.has(albumId)) {
        const timeoutId = setTimeout(() => {
          logger.info(`[ALBUM] Timeout alcanzado, procesando álbum: ${albumId}`);
          this.processAlbum(albumId, processedMessageIds, onMessageCallback);
        }, constants.ALBUM_WAIT_TIMEOUT);
        this.albumTracker.set(albumId, timeoutId);
      }
    }
  }

  // Función para limpiar álbumes expirados
  cleanupExpiredAlbums() {
    try {
      const now = Date.now();
      let cleanedCount = 0;
      
      for (const [albumId, timeout] of this.albumTracker.entries()) {
        // Si han pasado más de 30 segundos, limpiar el álbum
        if (now - timeout > 30000) {
          logger.debug(`[ALBUM_CLEANUP] Limpiando álbum expirado: ${albumId}`);
          this.albumTracker.delete(albumId);
          this.albumMessages.delete(albumId);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`[ALBUM_CLEANUP] Limpiados ${cleanedCount} álbumes expirados`);
      }
    } catch (error) {
      logger.error('[ALBUM_CLEANUP] Error limpiando álbumes expirados:', error.message);
    }
  }
}

module.exports = AlbumHandler;
