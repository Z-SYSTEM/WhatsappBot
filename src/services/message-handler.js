const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { logger } = require('../logger');
const { logMessage } = require('../logger');
const constants = require('../config/constants');
const { isMessageForwarded } = require('../utils/helpers');

class MessageHandler {
  constructor() {
    this.processedMessageIds = new Set();
    this.tempMessageData = {};
  }

  // Función para guardar logs de requests POST en onMessage
  async logOnMessageRequest(requestData) {
    try {
      const path = require('path');
      const fs = require('fs-extra');
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logDir = path.join('logs', 'onmessage-requests');
      
      // Crear directorio si no existe
      await fs.ensureDir(logDir);
      
      // Crear nombre de archivo único con timestamp
      const logFile = path.join(logDir, `request-${timestamp}.json`);
      
      // Guardar el request completo como JSON en un archivo separado
      await fs.writeFile(logFile, JSON.stringify(requestData, null, 2));
      
      logger.debug(`[ONMESSAGE_LOG] Request guardado en archivo: ${logFile}`);
    } catch (error) {
      logger.error('Error guardando log de request onMessage:', error.message);
    }
  }

  // Función para manejar llamadas
  async handleCall(json, onMessageCallback) {
    try {
      // Reutilizar objeto para evitar allocations
      this.tempMessageData.phoneNumber = json[0].id.replace('@c.us', '').replace('@s.whatsapp.net', '');
      this.tempMessageData.type = constants.MESSAGE_TYPE_CALL;
      this.tempMessageData.from = json[0].id;
      this.tempMessageData.id = `call_${Date.now()}`;
      this.tempMessageData.timestamp = Math.floor(Date.now() / 1000);
      this.tempMessageData.body = 'Llamada entrante';
      this.tempMessageData.hasMedia = false;
      this.tempMessageData.data = {
        status: json[0].status,
        duration: json[0].duration || 0
      };

      if (onMessageCallback) {
        try {
          // Guardar log del request
          await this.logOnMessageRequest(this.tempMessageData);
          
          await onMessageCallback(this.tempMessageData);
          logger.info(`Llamada enviada a webhook: ${this.tempMessageData.data.status} de ${this.tempMessageData.phoneNumber}`);
        } catch (error) {
          logger.error('Error enviando webhook de llamada:', error.message);
        }
      }

    } catch (error) {
      logger.error('Error procesando llamada:', error.message);
    }
  }

  // Función para procesar media y descargar contenido
  async processMedia(msg, tempMessageData) {
    try {
      logger.debug(`[DOWNLOAD] Iniciando descarga de media para ${tempMessageData.phoneNumber}`);
      logger.debug(`[DOWNLOAD] downloadMediaMessage disponible: ${typeof downloadMediaMessage}`);
      
      const result = await downloadMediaMessage(msg);
      logger.debug(`[DOWNLOAD] Resultado obtenido, tipo: ${typeof result}, constructor: ${result.constructor.name}`);
      
      // Verificar si el resultado es un buffer, stream o un objeto
      let buffer;
      if (Buffer.isBuffer(result)) {
        buffer = result;
        logger.debug(`[DOWNLOAD] Resultado es un Buffer, tamaño: ${buffer.length} bytes`);
      } else if (result && typeof result === 'object') {
        // Si es un objeto, verificar si es un stream
        if (result.readable || result.pipe || result.on) {
          logger.debug(`[DOWNLOAD] Resultado es un Stream, convirtiendo a buffer...`);
          // Es un stream, convertirlo a buffer
          const chunks = [];
          for await (const chunk of result) {
            chunks.push(chunk);
          }
          buffer = Buffer.concat(chunks);
          logger.debug(`[DOWNLOAD] Stream convertido a buffer, tamaño: ${buffer.length} bytes`);
        } else {
          // Si es un objeto, buscar la propiedad que contiene los datos
          logger.debug(`[DOWNLOAD] Resultado es un objeto, propiedades: ${Object.keys(result)}`);
          
          if (result.data) {
            buffer = Buffer.from(result.data);
            logger.debug(`[DOWNLOAD] Datos extraídos de result.data, tamaño: ${buffer.length} bytes`);
          } else if (result.buffer) {
            buffer = Buffer.from(result.buffer);
            logger.debug(`[DOWNLOAD] Datos extraídos de result.buffer, tamaño: ${buffer.length} bytes`);
          } else if (result.content) {
            buffer = Buffer.from(result.content);
            logger.debug(`[DOWNLOAD] Datos extraídos de result.content, tamaño: ${buffer.length} bytes`);
          } else {
            // Intentar convertir todo el objeto a buffer
            buffer = Buffer.from(JSON.stringify(result));
            logger.debug(`[DOWNLOAD] Convertido objeto completo a buffer, tamaño: ${buffer.length} bytes`);
          }
        }
      } else {
        throw new Error(`Tipo de resultado inesperado: ${typeof result}`);
      }
      
      tempMessageData.data.data = buffer.toString('base64');
      logger.debug(`[DOWNLOAD] Media descargada exitosamente para ${tempMessageData.phoneNumber}, tamaño: ${buffer.length} bytes, base64: ${tempMessageData.data.data.length} caracteres`);
      
      // Verificar que los datos se guardaron correctamente
      if (tempMessageData.data.data) {
        logger.debug(`[DOWNLOAD] Datos base64 guardados correctamente en tempMessageData.data.data`);
      } else {
        logger.warn(`[DOWNLOAD] ERROR: Los datos base64 no se guardaron correctamente`);
      }
    } catch (error) {
      logger.error(`[DOWNLOAD] Error descargando media de ${tempMessageData.phoneNumber}: ${error.message}`);
      logger.error(`[DOWNLOAD] Stack trace: ${error.stack}`);
      logger.error(`[DOWNLOAD] Tipo de error: ${error.constructor.name}`);
      logger.error(`[DOWNLOAD] Error completo: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
      // No es un error crítico, continuar sin los datos del media
    }
  }

  // Función para procesar imagen
  async processImageMessage(msg, tempMessageData) {
    tempMessageData.type = constants.MESSAGE_TYPE_IMAGE;
    tempMessageData.hasMedia = true;
    tempMessageData.body = msg.message.imageMessage.caption || '';
    tempMessageData.data = {
      mimetype: msg.message.imageMessage.mimetype,
      filename: msg.message.imageMessage.fileName || 'image.jpg'
    };
    
    tempMessageData.isForwarded = isMessageForwarded(msg.message.imageMessage);
    
    await this.processMedia(msg, tempMessageData);
  }

  // Función para procesar video
  async processVideoMessage(msg, tempMessageData) {
    tempMessageData.type = constants.MESSAGE_TYPE_VIDEO;
    tempMessageData.hasMedia = true;
    tempMessageData.body = msg.message.videoMessage.caption || '';
    tempMessageData.data = {
      mimetype: msg.message.videoMessage.mimetype,
      filename: msg.message.videoMessage.fileName || 'video.mp4'
    };
    
    tempMessageData.isForwarded = isMessageForwarded(msg.message.videoMessage);
    
    await this.processMedia(msg, tempMessageData);
  }

  // Función para procesar audio
  async processAudioMessage(msg, tempMessageData) {
    tempMessageData.type = constants.MESSAGE_TYPE_AUDIO;
    tempMessageData.hasMedia = true;
    tempMessageData.data = {
      mimetype: msg.message.audioMessage.mimetype,
      filename: msg.message.audioMessage.fileName || 'audio.ogg'
    };
    
    tempMessageData.isForwarded = isMessageForwarded(msg.message.audioMessage);
    
    await this.processMedia(msg, tempMessageData);
  }

  // Función para procesar documento
  async processDocumentMessage(msg, tempMessageData) {
    tempMessageData.type = constants.MESSAGE_TYPE_DOCUMENT;
    tempMessageData.hasMedia = true;
    tempMessageData.body = msg.message.documentMessage.title || '';
    tempMessageData.data = {
      mimetype: msg.message.documentMessage.mimetype,
      filename: msg.message.documentMessage.fileName || 'document'
    };
    
    tempMessageData.isForwarded = isMessageForwarded(msg.message.documentMessage);
    
    await this.processMedia(msg, tempMessageData);
  }

  // Función para procesar ubicación
  processLocationMessage(msg, tempMessageData) {
    tempMessageData.type = constants.MESSAGE_TYPE_LOCATION;
    tempMessageData.data = {
      latitude: msg.message.locationMessage.degreesLatitude,
      longitude: msg.message.locationMessage.degreesLongitude,
      description: msg.message.locationMessage.name || ''
    };
    
    tempMessageData.isForwarded = isMessageForwarded(msg.message.locationMessage);
  }

  // Función para procesar contacto
  processContactMessage(msg, tempMessageData) {
    tempMessageData.type = constants.MESSAGE_TYPE_CONTACT;
    tempMessageData.data = {
      vcard: msg.message.contactMessage.vcard
    };
    
    tempMessageData.isForwarded = isMessageForwarded(msg.message.contactMessage);
  }

  // Función para procesar mensaje de protocolo
  processProtocolMessage(msg, tempMessageData) {
    // Manejar mensajes de protocolo (álbumes, reacciones, etc.)
    if (msg.message.protocolMessage.type === constants.PROTOCOL_MESSAGE_ALBUM) {
      // Los álbumes se manejan de forma especial, no procesar aquí
      logger.debug(`[PROTOCOL] Mensaje de protocolo de álbum recibido de ${tempMessageData.phoneNumber}`);
      return false; // No procesar, esperar a que lleguen las imágenes individuales
    } else if (msg.message.protocolMessage.type === constants.PROTOCOL_MESSAGE_REVOKE) {
      logger.debug(`[PROTOCOL] Mensaje revocado de ${tempMessageData.phoneNumber}`);
      return false; // No procesar mensajes revocados
    } else if (msg.message.protocolMessage.type === constants.PROTOCOL_MESSAGE_EPHEMERAL_SETTING) {
      logger.debug(`[PROTOCOL] Configuración de mensaje efímero de ${tempMessageData.phoneNumber}`);
      return false; // No procesar configuraciones
    } else {
      // Otros tipos de protocolMessage no soportados
      logger.debug(`[IGNORED] ProtocolMessage tipo ${msg.message.protocolMessage.type} ignorado de ${tempMessageData.phoneNumber}`);
      return false;
    }
  }

  // Función para procesar mensaje no soportado
  processUnsupportedMessage(msg, tempMessageData) {
    // Mensaje de tipo no soportado
    const unsupportedTypes = Object.keys(msg.message).filter(key => 
      !['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 
        'audioMessage', 'documentMessage', 'stickerMessage', 'locationMessage', 
        'contactMessage', 'protocolMessage'].includes(key)
    );
    
    logger.warn(`[UNSUPPORTED] Mensaje de tipo no soportado recibido de ${tempMessageData.phoneNumber}`);
    logger.warn(`[UNSUPPORTED] Tipos detectados: ${unsupportedTypes.join(', ')}`);
    logger.warn(`[UNSUPPORTED] Todos los tipos en el mensaje: ${Object.keys(msg.message).join(', ')}`);
    
    // Log detallado del mensaje no soportado
    logMessage.ignored({
      ...tempMessageData,
      unsupportedTypes: unsupportedTypes,
      allTypes: Object.keys(msg.message)
    }, 'tipo_no_soportado');
    
    return false; // No procesar mensajes no soportados
  }

  // Función principal para manejar mensajes entrantes
  async handleIncomingMessage(msg, albumHandler, onMessageCallback) {
    try {
      // Verificar si el mensaje ya fue procesado
      if (this.processedMessageIds.has(msg.key.id)) {
        logger.debug(`[DUPLICATE] Mensaje ya procesado, ignorando: ${msg.key.id}`);
        return;
      }
      
      // Agregar el ID a la lista de procesados
      this.processedMessageIds.add(msg.key.id);
      
      // Limpiar IDs antiguos
      if (this.processedMessageIds.size > constants.PROCESSED_MESSAGES_MAX_SIZE) {
        const idsArray = Array.from(this.processedMessageIds);
        this.processedMessageIds.clear();
        idsArray.slice(-constants.PROCESSED_MESSAGES_KEEP_SIZE).forEach(id => this.processedMessageIds.add(id));
      }

      // Reutilizar objeto para evitar allocations
      this.tempMessageData.phoneNumber = msg.key.remoteJid.replace('@c.us', '').replace('@s.whatsapp.net', '');
      this.tempMessageData.type = constants.MESSAGE_TYPE_CHAT;
      this.tempMessageData.from = msg.key.remoteJid;
      this.tempMessageData.id = msg.key.id;
      this.tempMessageData.timestamp = msg.messageTimestamp;
      this.tempMessageData.body = '';
      this.tempMessageData.hasMedia = false;
      this.tempMessageData.data = {};
      this.tempMessageData.isForwarded = false;

      // Verificar si es parte de un álbum
      if (albumHandler && albumHandler.isAlbumMessage(msg)) {
        await albumHandler.addMessageToAlbum(msg, this.processedMessageIds, onMessageCallback);
        return; // No procesar individualmente, esperar a procesar el álbum completo
      }

      // Extraer texto del mensaje
      if (msg.message.conversation) {
        this.tempMessageData.body = msg.message.conversation;
        this.tempMessageData.type = constants.MESSAGE_TYPE_CHAT;
      } else if (msg.message.extendedTextMessage) {
        this.tempMessageData.body = msg.message.extendedTextMessage.text;
        this.tempMessageData.type = constants.MESSAGE_TYPE_CHAT;
        this.tempMessageData.isForwarded = isMessageForwarded(msg.message.extendedTextMessage);
      } else if (msg.message.imageMessage) {
        await this.processImageMessage(msg, this.tempMessageData);
      } else if (msg.message.videoMessage) {
        await this.processVideoMessage(msg, this.tempMessageData);
      } else if (msg.message.audioMessage) {
        await this.processAudioMessage(msg, this.tempMessageData);
      } else if (msg.message.documentMessage) {
        await this.processDocumentMessage(msg, this.tempMessageData);
      } else if (msg.message.stickerMessage) {
        // Stickers no soportados - ignorar
        logger.debug(`[IGNORED] Sticker ignorado de ${this.tempMessageData.phoneNumber} - soporte deshabilitado`);
        return; // No procesar stickers
      } else if (msg.message.locationMessage) {
        this.processLocationMessage(msg, this.tempMessageData);
      } else if (msg.message.contactMessage) {
        this.processContactMessage(msg, this.tempMessageData);
      } else if (msg.message.protocolMessage) {
        if (!this.processProtocolMessage(msg, this.tempMessageData)) {
          return; // No procesar este tipo de mensaje
        }
      } else {
        if (!this.processUnsupportedMessage(msg, this.tempMessageData)) {
          return; // No procesar mensajes no soportados
        }
      }

      // Log del mensaje recibido
      logMessage.received(this.tempMessageData);

      // Enviar webhook si está configurado
      if (onMessageCallback) {
        try {
          // Log de debug para ver qué se está enviando
          logger.debug(`[WEBHOOK] Enviando webhook - Tipo: ${this.tempMessageData.type} - De: ${this.tempMessageData.phoneNumber}`);
          
          // Verificar el estado de los datos antes de crear webhookData
          logger.debug(`[WEBHOOK] Estado de tempMessageData antes de crear webhookData:`);
          logger.debug(`[WEBHOOK] - hasMedia: ${this.tempMessageData.hasMedia}`);
          logger.debug(`[WEBHOOK] - data: ${JSON.stringify(this.tempMessageData.data)}`);
          logger.debug(`[WEBHOOK] - data.data existe: ${!!this.tempMessageData.data.data}`);
          if (this.tempMessageData.data.data) {
            logger.debug(`[WEBHOOK] - data.data longitud: ${this.tempMessageData.data.data.length} caracteres`);
          }
          
          // Crear una copia limpia de los datos para evitar problemas de serialización
          const webhookData = {
            phoneNumber: this.tempMessageData.phoneNumber,
            type: this.tempMessageData.type,
            from: this.tempMessageData.from,
            id: this.tempMessageData.id,
            timestamp: this.tempMessageData.timestamp,
            body: this.tempMessageData.body || '',
            hasMedia: this.tempMessageData.hasMedia || false,
            data: this.tempMessageData.data || {},
            isForwarded: this.tempMessageData.isForwarded || false
          };
          
          // Log para verificar que los datos de media se incluyen correctamente
          if (this.tempMessageData.hasMedia && this.tempMessageData.data && this.tempMessageData.data.data) {
            logger.debug(`[WEBHOOK] Datos de media incluidos para ${this.tempMessageData.phoneNumber}, tipo: ${this.tempMessageData.type}, tamaño base64: ${this.tempMessageData.data.data.length} caracteres`);
          } else if (this.tempMessageData.hasMedia) {
            logger.warn(`[WEBHOOK] Media marcado como true pero no hay datos para ${this.tempMessageData.phoneNumber}, tipo: ${this.tempMessageData.type}`);
          }
          
          // Verificar que los datos se pueden serializar correctamente
          try {
            JSON.stringify(webhookData);
          } catch (serializeError) {
            logger.error('Error serializando datos del webhook:', serializeError.message);
            logger.error('Datos problemáticos:', webhookData);
            return;
          }
          
          // Enviar webhook para todos los tipos de mensaje
          await this.logOnMessageRequest(webhookData);
          await onMessageCallback(webhookData);
          
          logger.debug(`[WEBHOOK] Webhook enviado exitosamente para ${this.tempMessageData.phoneNumber}`);
        } catch (error) {
          logger.error('Error enviando webhook ONMESSAGE:', error.message);
          logger.error('Error completo:', error);
          logger.error('Datos enviados:', JSON.stringify(this.tempMessageData, null, 2));
        }
      }

    } catch (error) {
      logger.error('Error procesando mensaje entrante:', error.message);
    }
  }
}

module.exports = MessageHandler;
