import { logger, logMessage } from '../logger.js';
import {
  _MESSAGE_TYPE_IMAGE,
  _MESSAGE_TYPE_VIDEO,
  _MESSAGE_TYPE_AUDIO,
  _MESSAGE_TYPE_DOCUMENT,
  _MESSAGE_TYPE_LOCATION,
  _MESSAGE_TYPE_CONTACT
} from '../constants.js';

class MessageSender {
  constructor(sock, httpClient, onMessageUrl) {
    this.sock = sock;
    this.httpClient = httpClient;
    this.onMessageUrl = onMessageUrl;
  }

  /**
   * Wrapper for sock.sendMessage with timeout and retry for 'No session record'
   */
  async _sendMessageWithRetry(jid, content, timeout = 8000) {
    const doSend = () => this.sock.sendMessage(jid, content);
    
    try {
      return await Promise.race([
        doSend(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`SendMessage timeout after ${timeout / 1000} seconds`)), timeout)
        )
      ]);
    } catch (error) {
      if (error.message && (error.message.includes('No session record') || error.message.includes('Invalid PreKey ID'))) {
        logger.warn(`[MESSAGE_SENDER] Session error for ${jid}: "${error.message}". Retrying once after 1s...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        return await Promise.race([
          doSend(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`SendMessage timeout after ${timeout / 1000} seconds on retry`)), timeout)
          )
        ]);
      }
      throw error;
    }
  }

  /**
   * Actualiza el socket de WhatsApp
   */
  updateSocket(sock) {
    this.sock = sock;
  }

  /**
   * Descarga archivo desde URL
   */
  async downloadFromUrl(url, mimetype = 'image/jpeg') {
    const result = await this.httpClient.downloadFile(url, mimetype);
    
    if (result.status === 'ok') {
      return result.data;
    } else {
      throw new Error(result.error);
    }
  }

  /**
   * Normaliza el JID (ID de WhatsApp)
   */
  normalizeJid(phone) {
    // Detectar si es un grupo (@g.us) o contacto individual (@c.us)
    if (phone.includes('@g.us') || phone.includes('@c.us')) {
      return phone;
    }
    
    // Es un número sin formato, solo quitar el + si es el primer carácter
    let cleanPhone = phone;
    if (cleanPhone.startsWith('+')) {
      cleanPhone = cleanPhone.substring(1);
    }
    return `${cleanPhone}@c.us`;
  }

  /**
   * Envía un mensaje de texto
   */
  async sendTextMessage(jid, message) {
    return await this._sendMessageWithRetry(jid, { text: message });
  }

  /**
   * Envía un mensaje de imagen
   */
  async sendImageMessage(jid, message, media) {
    let buffer;
    
    if (media && media.url) {
      buffer = await this.downloadFromUrl(media.url, media.mimetype);
    } else if (media && media.data) {
      buffer = Buffer.from(media.data, 'base64');
    } else {
      throw new Error('URL o datos de imagen requeridos');
    }
    
    const sentMessage = await this._sendMessageWithRetry(jid, {
      image: buffer,
      caption: message,
      mimetype: media.mimetype || 'image/jpeg'
    });
    
    // Enviar webhook con el nuevo formato
    if (this.onMessageUrl) {
      await this.sendImageWebhook(jid, sentMessage, message, media);
    }
    
    return sentMessage;
  }

  /**
   * Envía webhook para imagen enviada
   */
  async sendImageWebhook(jid, sentMessage, message, media) {
    const imageBody = JSON.stringify({
      caption: message || '',
      imageUrl: media.url || 'base64_data'
    });
    
    const webhookData = {
      phoneNumber: jid.replace('@c.us', '').replace('@s.whatsapp.net', ''),
      type: _MESSAGE_TYPE_IMAGE,
      from: jid,
      id: sentMessage.key?.id || `img_${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000),
      body: imageBody,
      hasMedia: true,
      data: {},
      isForwarded: false
    };
    
    const result = await this.httpClient.sendWebhook(this.onMessageUrl, webhookData);
    if (result.status === 'ok') {
      logger.info(`[MESSAGE_SENDER] Webhook de imagen enviado: ${webhookData.phoneNumber}`);
    }
  }

  /**
   * Envía un mensaje de video
   */
  async sendVideoMessage(jid, message, media) {
    let buffer;
    
    if (media && media.url) {
      buffer = await this.downloadFromUrl(media.url, media.mimetype);
    } else if (media && media.data) {
      buffer = Buffer.from(media.data, 'base64');
    } else {
      throw new Error('URL o datos de video requeridos');
    }
    
    return await this._sendMessageWithRetry(jid, {
      video: buffer,
      caption: message,
      mimetype: media.mimetype || 'video/mp4'
    });
  }

  /**
   * Envía un mensaje de audio
   */
  async sendAudioMessage(jid, media) {
    let buffer;
    
    if (media && media.url) {
      buffer = await this.downloadFromUrl(media.url, media.mimetype);
    } else if (media && media.data) {
      buffer = Buffer.from(media.data, 'base64');
    } else {
      throw new Error('URL o datos de audio requeridos');
    }
    
    return await this._sendMessageWithRetry(jid, {
      audio: buffer,
      mimetype: media.mimetype || 'audio/ogg',
      ptt: false
    });
  }

  /**
   * Envía un mensaje de documento
   */
  async sendDocumentMessage(jid, media) {
    let buffer;
    
    if (media && media.url) {
      buffer = await this.downloadFromUrl(media.url, media.mimetype);
    } else if (media && media.data) {
      buffer = Buffer.from(media.data, 'base64');
    } else {
      throw new Error('URL o datos de documento requeridos');
    }
    
    return await this._sendMessageWithRetry(jid, {
      document: buffer,
      mimetype: media.mimetype || 'application/octet-stream',
      fileName: media.filename || 'document'
    });
  }

  /**
   * Envía un mensaje de ubicación
   */
  async sendLocationMessage(jid, media) {
    if (!media || !media.latitude || !media.longitude) {
      throw new Error('Coordenadas de ubicación requeridas');
    }
    
    return await this._sendMessageWithRetry(jid, {
      location: {
        degreesLatitude: media.latitude,
        degreesLongitude: media.longitude,
        name: media.description || ''
      }
    });
  }

  /**
   * Envía un mensaje de contacto
   */
  async sendContactMessage(jid, media) {
    if (media && media.contact) {
      // Enviar contacto usando objeto contact
      return await this._sendMessageWithRetry(jid, {
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
      return await this._sendMessageWithRetry(jid, {
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
  }

  /**
   * Envía un mensaje (método principal)
   */
  async sendMessage({ phone, message, type = 'text', media }) {
    try {
      const jid = this.normalizeJid(phone);
      let sentMessage;

      switch (type) {
        case 'text':
          sentMessage = await this.sendTextMessage(jid, message);
          break;
        
        case _MESSAGE_TYPE_IMAGE:
          sentMessage = await this.sendImageMessage(jid, message, media);
          break;
        
        case _MESSAGE_TYPE_VIDEO:
          sentMessage = await this.sendVideoMessage(jid, message, media);
          break;
        
        case _MESSAGE_TYPE_AUDIO:
          sentMessage = await this.sendAudioMessage(jid, media);
          break;
        
        case _MESSAGE_TYPE_DOCUMENT:
          sentMessage = await this.sendDocumentMessage(jid, media);
          break;
        
        case _MESSAGE_TYPE_LOCATION:
          sentMessage = await this.sendLocationMessage(jid, media);
          break;
        
        case _MESSAGE_TYPE_CONTACT:
          sentMessage = await this.sendContactMessage(jid, media);
          break;
        
        default:
          throw new Error(`Tipo de mensaje no soportado: ${type}`);
      }

      // Log del mensaje enviado con su contenido usando el helper
      logMessage.sent({ phoneNumber: phone, type: type, body: message }); // Usar el helper logMessage.sent
      return { success: true, messageId: sentMessage.key.id };

    } catch (error) {
      logger.error(`[MESSAGE_SENDER] Error enviando ${type} a ${phone}: ${error.message}`);
      if (error.stack) {
        logger.debug(`[MESSAGE_SENDER] Stack trace: ${error.stack}`);
      }
      logMessage.failed({ phoneNumber: phone, type: type }, error);
      return { success: false, error: error.message };
    }
  }
}

export default MessageSender;

