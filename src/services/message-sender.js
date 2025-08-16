const axios = require('axios');
const { logger } = require('../logger');
const { logMessage } = require('../logger');
const { downloadFromUrl } = require('../utils/helpers');
const constants = require('../config/constants');
const config = require('../config/environment');

class MessageSender {
  constructor(sock) {
    this.sock = sock;
    this.isConnected = false;
  }

  setConnectionStatus(status) {
    this.isConnected = status;
  }

  // Función para enviar mensajes
  async sendMessage({ phone, message, type = 'text', media }) {
    try {
      if (!this.isConnected) {
        logger.warn(`[RECOVERY] Bot no conectado, mensaje rechazado: ${phone} - ${type}`);
        return { success: false, error: 'Bot no conectado' };
      }

      const jid = phone.includes('@c.us') ? phone : `${phone}@c.us`;

      let sentMessage;

      switch (type) {
        case 'text':
          sentMessage = await this.sock.sendMessage(jid, { text: message });
          break;
        
        case constants.MESSAGE_TYPE_IMAGE:
          if (media && media.url) {
            // Descargar imagen desde URL
            const buffer = await downloadFromUrl(media.url, media.mimetype);
            sentMessage = await this.sock.sendMessage(jid, {
              image: buffer,
              caption: message,
              mimetype: media.mimetype || 'image/jpeg'
            });
            
            // Crear JSON con caption y link para el body
            const imageBody = JSON.stringify({
              caption: message || '',
              imageUrl: media.url
            });
            
            // Enviar webhook con el nuevo formato
            if (config.ONMESSAGE) {
              const webhookData = {
                phoneNumber: jid.replace('@c.us', '').replace('@s.whatsapp.net', ''),
                type: constants.MESSAGE_TYPE_IMAGE,
                from: jid,
                id: sentMessage.key?.id || `img_${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000),
                body: imageBody,
                hasMedia: true,
                data: {},
                isForwarded: false
              };
              
              await axios.post(config.ONMESSAGE, webhookData, {
                timeout: 10000,
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': 'WhatsApp-Bot/1.0'
                }
              });
              logger.info(`[WEBHOOK] Imagen enviada con nuevo formato: ${webhookData.phoneNumber}`);
            }
            
          } else if (media && media.data) {
            // Usar datos base64 existentes
            const buffer = Buffer.from(media.data, 'base64');
            sentMessage = await this.sock.sendMessage(jid, {
              image: buffer,
              caption: message,
              mimetype: media.mimetype || 'image/jpeg'
            });
            
            // Crear JSON con caption para el body (sin URL ya que es base64)
            const imageBody = JSON.stringify({
              caption: message || '',
              imageData: 'base64_data'
            });
            
            // Enviar webhook con el nuevo formato
            if (config.ONMESSAGE) {
              const webhookData = {
                phoneNumber: jid.replace('@c.us', '').replace('@s.whatsapp.net', ''),
                type: constants.MESSAGE_TYPE_IMAGE,
                from: jid,
                id: sentMessage.key?.id || `img_${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000),
                body: imageBody,
                hasMedia: true,
                data: {},
                isForwarded: false
              };
              
              await axios.post(config.ONMESSAGE, webhookData, {
                timeout: 10000,
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': 'WhatsApp-Bot/1.0'
                }
              });
              logger.info(`[WEBHOOK] Imagen base64 enviada con nuevo formato: ${webhookData.phoneNumber}`);
            }
            
          } else {
            throw new Error('URL o datos de imagen requeridos');
          }
          break;
        
        case constants.MESSAGE_TYPE_VIDEO:
          if (media && media.url) {
            // Descargar video desde URL
            const buffer = await downloadFromUrl(media.url, media.mimetype);
            sentMessage = await this.sock.sendMessage(jid, {
              video: buffer,
              caption: message,
              mimetype: media.mimetype || 'video/mp4'
            });
          } else if (media && media.data) {
            // Usar datos base64 existentes
            const buffer = Buffer.from(media.data, 'base64');
            sentMessage = await this.sock.sendMessage(jid, {
              video: buffer,
              caption: message,
              mimetype: media.mimetype || 'video/mp4'
            });
          } else {
            throw new Error('URL o datos de video requeridos');
          }
          break;
        
        case constants.MESSAGE_TYPE_AUDIO:
          if (media && media.url) {
            // Descargar audio desde URL
            const buffer = await downloadFromUrl(media.url, media.mimetype);
            sentMessage = await this.sock.sendMessage(jid, {
              audio: buffer,
              mimetype: media.mimetype || 'audio/ogg',
              ptt: false
            });
          } else if (media && media.data) {
            // Usar datos base64 existentes
            const buffer = Buffer.from(media.data, 'base64');
            sentMessage = await this.sock.sendMessage(jid, {
              audio: buffer,
              mimetype: media.mimetype || 'audio/ogg',
              ptt: false
            });
          } else {
            throw new Error('URL o datos de audio requeridos');
          }
          break;
        
        case constants.MESSAGE_TYPE_DOCUMENT:
          if (media && media.url) {
            // Descargar documento desde URL
            const buffer = await downloadFromUrl(media.url, media.mimetype);
            sentMessage = await this.sock.sendMessage(jid, {
              document: buffer,
              mimetype: media.mimetype || 'application/octet-stream',
              fileName: media.filename || 'document'
            });
          } else if (media && media.data) {
            // Usar datos base64 existentes
            const buffer = Buffer.from(media.data, 'base64');
            sentMessage = await this.sock.sendMessage(jid, {
              document: buffer,
              mimetype: media.mimetype || 'application/octet-stream',
              fileName: media.filename || 'document'
            });
          } else {
            throw new Error('URL o datos de documento requeridos');
          }
          break;
        
        case constants.MESSAGE_TYPE_LOCATION:
          if (media && media.latitude && media.longitude) {
            sentMessage = await this.sock.sendMessage(jid, {
              location: {
                degreesLatitude: media.latitude,
                degreesLongitude: media.longitude,
                name: media.description || ''
              }
            });
          } else {
            throw new Error('Coordenadas de ubicación requeridas');
          }
          break;
        
        case constants.MESSAGE_TYPE_CONTACT:
          if (media && media.contact) {
            // Enviar contacto usando objeto contact
            sentMessage = await this.sock.sendMessage(jid, {
              contacts: {
                displayName: media.contact.name,
                contacts: [{
                  name: media.contact.name,
                  number: media.contact.number
                }]
              }
            });
          } else if (media && media.vcard) {
            // Enviar contacto usando vCard
            sentMessage = await this.sock.sendMessage(jid, {
              contacts: {
                displayName: 'Contact',
                contacts: [{
                  vcard: media.vcard
                }]
              }
            });
          } else {
            throw new Error('Datos de contacto requeridos');
          }
          break;
        
        default:
          throw new Error(`Tipo de mensaje no soportado: ${type}`);
      }

      // Log simple como solicitado en todo.txt
      console.log(`enviando mensaje a ${phone}: ${message}`);
      
      logger.info(`[SEND] Mensaje enviado exitosamente a ${phone}: ${type}`);
      logger.debug(`[SEND] Message ID: ${sentMessage.key.id}`);
      logger.debug(`[SEND] Timestamp: ${new Date().toISOString()}`);
      logMessage.sent({ phoneNumber: phone, type: type });
      return { success: true, messageId: sentMessage.key.id };

    } catch (error) {
      logger.error(`[SEND] Error enviando mensaje a ${phone}: ${error.message}`);
      logger.error(`[SEND] Tipo de mensaje: ${type}`);
      logger.error(`[SEND] Timestamp: ${new Date().toISOString()}`);
      logger.error(`[SEND] Stack trace: ${error.stack}`);
      logMessage.failed({ phoneNumber: phone, type: type }, error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = MessageSender;
