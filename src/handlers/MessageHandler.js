import { logger, logMessage } from '../logger.js';
import MediaProcessor from './MediaProcessor.js';
import {
  _MESSAGE_TYPE_CHAT,
  _MESSAGE_TYPE_IMAGE,
  _MESSAGE_TYPE_VIDEO,
  _MESSAGE_TYPE_AUDIO,
  _MESSAGE_TYPE_DOCUMENT,
  _MESSAGE_TYPE_LOCATION,
  _MESSAGE_TYPE_CONTACT,
  _PROTOCOL_MESSAGE_ALBUM,
  _PROTOCOL_MESSAGE_REVOKE,
  _PROTOCOL_MESSAGE_EPHEMERAL_SETTING
} from '../constants.js';

class MessageHandler {
  constructor(albumHandler, httpClient, onMessageUrl, logOnMessageRequest) {
    this.albumHandler = albumHandler;
    this.httpClient = httpClient;
    this.onMessageUrl = onMessageUrl;
    this.logOnMessageRequest = logOnMessageRequest;
  }

  /**
   * Verifica si un mensaje es reenviado
   */
  isMessageForwarded(messageObj) {
    return messageObj && messageObj.contextInfo && messageObj.contextInfo.isForwarded;
  }

  /**
   * Maneja un mensaje entrante
   */
  async handleIncomingMessage(msg) {
    try {
      // Verificar si el mensaje ya fue procesado
      if (this.albumHandler.isProcessed(msg.key.id)) {
        logger.debug(`[MESSAGE_HANDLER] Mensaje ya procesado, ignorando: ${msg.key.id}`);
        return;
      }
      
      // Marcar como procesado
      this.albumHandler.markAsProcessed(msg.key.id);

      // Datos temporales del mensaje
      const messageData = {
        phoneNumber: msg.key.remoteJid.replace('@c.us', '').replace('@s.whatsapp.net', ''),
        type: _MESSAGE_TYPE_CHAT,
        from: (msg.key.participant || msg.key.remoteJid).replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@lid', ''),
        id: msg.key.id,
        timestamp: msg.messageTimestamp,
        body: '',
        hasMedia: false,
        data: {},
        isForwarded: false
      };

      // Verificar si es parte de un álbum
      if (this.albumHandler.isAlbumMessage(msg)) {
        const albumId = this.albumHandler.generateAlbumId(msg);
        this.albumHandler.addToAlbum(msg, albumId);
        return; // No procesar individualmente
      }

      // Procesar según el tipo de mensaje
      await this.processMessageByType(msg, messageData);

    } catch (error) {
      logger.error('[MESSAGE_HANDLER] Error procesando mensaje entrante:', error.message);
    }
  }

  /**
   * Procesa el mensaje según su tipo
   */
  async processMessageByType(msg, messageData) {
    // Extraer texto del mensaje
    if (msg.message.conversation) {
      await this.processTextMessage(msg, messageData, msg.message.conversation);
    } else if (msg.message.extendedTextMessage) {
      await this.processExtendedTextMessage(msg, messageData);
    } else if (msg.message.imageMessage) {
      await this.processImageMessage(msg, messageData);
    } else if (msg.message.videoMessage) {
      await this.processVideoMessage(msg, messageData);
    } else if (msg.message.audioMessage) {
      await this.processAudioMessage(msg, messageData);
    } else if (msg.message.documentMessage) {
      await this.processDocumentMessage(msg, messageData);
    } else if (msg.message.stickerMessage) {
      this.processStickerMessage(messageData);
      return; // No procesar stickers
    } else if (msg.message.locationMessage) {
      await this.processLocationMessage(msg, messageData);
    } else if (msg.message.contactMessage) {
      await this.processContactMessage(msg, messageData);
    } else if (msg.message.contactsArrayMessage) {
      await this.processContactsArrayMessage(msg, messageData);
      return; // Ya procesado individualmente
    } else if (msg.message.protocolMessage) {
      this.processProtocolMessage(msg, messageData);
      return; // No procesar mensajes de protocolo
    } else {
      this.processUnsupportedMessage(msg, messageData);
      return;
    }

    // Log del mensaje recibido
    logMessage.received(messageData);

    // Enviar webhook si está configurado
    await this.sendWebhook(messageData);
  }

  /**
   * Procesa mensaje de texto simple
   */
  async processTextMessage(msg, messageData, text) {
    messageData.body = text;
    messageData.type = _MESSAGE_TYPE_CHAT;
  }

  /**
   * Procesa mensaje de texto extendido
   */
  async processExtendedTextMessage(msg, messageData) {
    messageData.body = msg.message.extendedTextMessage.text;
    messageData.type = _MESSAGE_TYPE_CHAT;
    messageData.isForwarded = this.isMessageForwarded(msg.message.extendedTextMessage);
  }

  /**
   * Procesa mensaje de imagen
   */
  async processImageMessage(msg, messageData) {
    messageData.type = _MESSAGE_TYPE_IMAGE;
    messageData.hasMedia = true;
    messageData.body = msg.message.imageMessage.caption || '';
    messageData.data = MediaProcessor.extractMediaInfo(msg.message.imageMessage, 'image.jpg');
    messageData.isForwarded = this.isMessageForwarded(msg.message.imageMessage);
    
    try {
      logger.debug(`[MESSAGE_HANDLER] Descargando imagen para ${messageData.phoneNumber}`);
      const base64Data = await MediaProcessor.downloadMediaAsBase64(msg, messageData.phoneNumber);
      messageData.data.data = base64Data;
      logger.debug(`[MESSAGE_HANDLER] Imagen descargada exitosamente`);
    } catch (error) {
      logger.error(`[MESSAGE_HANDLER] Error descargando imagen: ${error.message}`);
    }
  }

  /**
   * Procesa mensaje de video
   */
  async processVideoMessage(msg, messageData) {
    messageData.type = _MESSAGE_TYPE_VIDEO;
    messageData.hasMedia = true;
    messageData.body = msg.message.videoMessage.caption || '';
    messageData.data = MediaProcessor.extractMediaInfo(msg.message.videoMessage, 'video.mp4');
    messageData.isForwarded = this.isMessageForwarded(msg.message.videoMessage);
    
    try {
      const base64Data = await MediaProcessor.downloadMediaAsBase64(msg, messageData.phoneNumber);
      messageData.data.data = base64Data;
    } catch (error) {
      logger.debug(`[MESSAGE_HANDLER] No se pudo descargar video: ${error.message}`);
    }
  }

  /**
   * Procesa mensaje de audio
   */
  async processAudioMessage(msg, messageData) {
    messageData.type = _MESSAGE_TYPE_AUDIO;
    messageData.hasMedia = true;
    messageData.data = MediaProcessor.extractMediaInfo(msg.message.audioMessage, 'audio.ogg');
    messageData.isForwarded = this.isMessageForwarded(msg.message.audioMessage);
    
    try {
      const base64Data = await MediaProcessor.downloadMediaAsBase64(msg, messageData.phoneNumber);
      messageData.data.data = base64Data;
    } catch (error) {
      logger.debug(`[MESSAGE_HANDLER] No se pudo descargar audio: ${error.message}`);
    }
  }

  /**
   * Procesa mensaje de documento
   */
  async processDocumentMessage(msg, messageData) {
    messageData.type = _MESSAGE_TYPE_DOCUMENT;
    messageData.hasMedia = true;
    messageData.body = msg.message.documentMessage.title || '';
    messageData.data = MediaProcessor.extractMediaInfo(msg.message.documentMessage, 'document');
    messageData.isForwarded = this.isMessageForwarded(msg.message.documentMessage);
    
    try {
      const base64Data = await MediaProcessor.downloadMediaAsBase64(msg, messageData.phoneNumber);
      messageData.data.data = base64Data;
    } catch (error) {
      logger.debug(`[MESSAGE_HANDLER] No se pudo descargar documento: ${error.message}`);
    }
  }

  /**
   * Procesa mensaje de sticker (ignorado)
   */
  processStickerMessage(messageData) {
    logger.debug(`[MESSAGE_HANDLER] Sticker ignorado de ${messageData.phoneNumber} - soporte deshabilitado`);
  }

  /**
   * Procesa mensaje de ubicación
   */
  async processLocationMessage(msg, messageData) {
    messageData.type = _MESSAGE_TYPE_LOCATION;
    messageData.data = {
      latitude: msg.message.locationMessage.degreesLatitude,
      longitude: msg.message.locationMessage.degreesLongitude,
      description: msg.message.locationMessage.name || ''
    };
    messageData.isForwarded = this.isMessageForwarded(msg.message.locationMessage);
  }

  /**
   * Procesa mensaje de contacto único
   */
  async processContactMessage(msg, messageData) {
    messageData.type = _MESSAGE_TYPE_CONTACT;
    messageData.data = {
      vcard: msg.message.contactMessage.vcard
    };
    messageData.isForwarded = this.isMessageForwarded(msg.message.contactMessage);
  }

  /**
   * Procesa array de contactos
   */
  async processContactsArrayMessage(msg, messageData) {
    const contacts = msg.message.contactsArrayMessage.contacts || [];
    logger.debug(`[MESSAGE_HANDLER] Recibidos ${contacts.length} contactos de ${messageData.phoneNumber}`);
    
    // Procesar cada contacto individualmente
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      const contactMessageData = {
        phoneNumber: messageData.phoneNumber,
        type: _MESSAGE_TYPE_CONTACT,
        from: messageData.from,
        id: `${messageData.id}_contact_${i}`,
        timestamp: messageData.timestamp,
        body: `Contacto ${i + 1} de ${contacts.length}`,
        hasMedia: false,
        data: {
          vcard: contact.vcard,
          displayName: contact.displayName || `Contacto ${i + 1}`,
          contactIndex: i,
          totalContacts: contacts.length
        },
        isForwarded: this.isMessageForwarded(msg.message.contactsArrayMessage)
      };
      
      // Log del contacto individual
      logMessage.received(contactMessageData);
      
      // Enviar webhook para cada contacto
      await this.sendWebhook(contactMessageData);
    }
  }

  /**
   * Procesa mensajes de protocolo
   */
  processProtocolMessage(msg, messageData) {
    if (msg.message.protocolMessage.type === _PROTOCOL_MESSAGE_ALBUM) {
      logger.debug(`[MESSAGE_HANDLER] Mensaje de protocolo de álbum recibido de ${messageData.phoneNumber}`);
    } else if (msg.message.protocolMessage.type === _PROTOCOL_MESSAGE_REVOKE) {
      logger.debug(`[MESSAGE_HANDLER] Mensaje revocado de ${messageData.phoneNumber}`);
    } else if (msg.message.protocolMessage.type === _PROTOCOL_MESSAGE_EPHEMERAL_SETTING) {
      logger.debug(`[MESSAGE_HANDLER] Configuración de mensaje efímero de ${messageData.phoneNumber}`);
    } else {
      logger.debug(`[MESSAGE_HANDLER] ProtocolMessage tipo ${msg.message.protocolMessage.type} ignorado de ${messageData.phoneNumber}`);
    }
  }

  /**
   * Procesa mensajes no soportados
   */
  processUnsupportedMessage(msg, messageData) {
    const unsupportedTypes = Object.keys(msg.message).filter(key => 
      !['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 
        'audioMessage', 'documentMessage', 'stickerMessage', 'locationMessage', 
        'contactMessage', 'contactsArrayMessage', 'protocolMessage'].includes(key)
    );
    
    logger.warn(`[MESSAGE_HANDLER] Mensaje de tipo no soportado recibido de ${messageData.phoneNumber}`);
    logger.warn(`[MESSAGE_HANDLER] Tipos detectados: ${unsupportedTypes.join(', ')}`);
    
    logMessage.ignored({
      ...messageData,
      unsupportedTypes: unsupportedTypes,
      allTypes: Object.keys(msg.message)
    }, 'tipo_no_soportado');
  }

  /**
   * Envía webhook si está configurado
   */
  async sendWebhook(messageData) {
    if (!this.onMessageUrl) {
      return;
    }

    try {
      logger.debug(`[MESSAGE_HANDLER] Enviando webhook a ${this.onMessageUrl} - Tipo: ${messageData.type} - De: ${messageData.phoneNumber}`);
      
      // Crear una copia limpia de los datos
      const webhookData = {
        phoneNumber: messageData.phoneNumber,
        type: messageData.type,
        from: messageData.from,
        id: messageData.id,
        timestamp: messageData.timestamp,
        body: messageData.body || '',
        hasMedia: messageData.hasMedia || false,
        data: messageData.data || {},
        isForwarded: messageData.isForwarded || false
      };
      
      // Verificar que los datos se pueden serializar correctamente
      try {
        JSON.stringify(webhookData);
      } catch (serializeError) {
        logger.error('[MESSAGE_HANDLER] Error serializando datos del webhook:', serializeError.message);
        return;
      }
      
      // Enviar webhook
      await this.httpClient.sendWebhook(this.onMessageUrl, webhookData, this.logOnMessageRequest);
      
      logger.debug(`[MESSAGE_HANDLER] Webhook enviado exitosamente para ${messageData.phoneNumber}`);
    } catch (error) {
      logger.error('[MESSAGE_HANDLER] Error enviando webhook:', error.message);
    }
  }
}

export default MessageHandler;

