import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { logger } from '../logger.js';

class MediaProcessor {
  /**
   * Convierte el resultado de downloadMediaMessage a Buffer
   * @param {*} result - Resultado de downloadMediaMessage
   * @returns {Buffer} Buffer con los datos del media
   */
  static async convertToBuffer(result) {
    let buffer;
    
    if (Buffer.isBuffer(result)) {
      buffer = result;
      logger.debug(`[MEDIA_PROCESSOR] Resultado es un Buffer, tamaño: ${buffer.length} bytes`);
    } else if (result && typeof result === 'object') {
      // Verificar si es un stream
      if (result.readable || result.pipe || result.on) {
        logger.debug(`[MEDIA_PROCESSOR] Resultado es un Stream, convirtiendo a buffer...`);
        const chunks = [];
        for await (const chunk of result) {
          chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks);
        logger.debug(`[MEDIA_PROCESSOR] Stream convertido a buffer, tamaño: ${buffer.length} bytes`);
      } else {
        // Si es un objeto, buscar la propiedad que contiene los datos
        logger.debug(`[MEDIA_PROCESSOR] Resultado es un objeto, propiedades: ${Object.keys(result)}`);
        
        if (result.data) {
          buffer = Buffer.from(result.data);
          logger.debug(`[MEDIA_PROCESSOR] Datos extraídos de result.data, tamaño: ${buffer.length} bytes`);
        } else if (result.buffer) {
          buffer = Buffer.from(result.buffer);
          logger.debug(`[MEDIA_PROCESSOR] Datos extraídos de result.buffer, tamaño: ${buffer.length} bytes`);
        } else if (result.content) {
          buffer = Buffer.from(result.content);
          logger.debug(`[MEDIA_PROCESSOR] Datos extraídos de result.content, tamaño: ${buffer.length} bytes`);
        } else {
          // Intentar convertir todo el objeto a buffer
          buffer = Buffer.from(JSON.stringify(result));
          logger.debug(`[MEDIA_PROCESSOR] Convertido objeto completo a buffer, tamaño: ${buffer.length} bytes`);
        }
      }
    } else {
      throw new Error(`Tipo de resultado inesperado: ${typeof result}`);
    }
    
    return buffer;
  }

  /**
   * Descarga media de un mensaje y lo convierte a base64
   * @param {Object} msg - Mensaje de WhatsApp
   * @param {string} phoneNumber - Número de teléfono del remitente
   * @returns {Promise<string>} Datos en base64
   */
  static async downloadMediaAsBase64(msg, phoneNumber) {
    try {
      logger.debug(`[MEDIA_PROCESSOR] Iniciando descarga de media para ${phoneNumber}`);
      
      const result = await downloadMediaMessage(msg);
      const buffer = await this.convertToBuffer(result);
      const base64Data = buffer.toString('base64');
      
      logger.debug(`[MEDIA_PROCESSOR] Media descargado exitosamente para ${phoneNumber}, tamaño: ${buffer.length} bytes, base64: ${base64Data.length} caracteres`);
      
      return base64Data;
    } catch (error) {
      logger.error(`[MEDIA_PROCESSOR] Error descargando media de ${phoneNumber}: ${error.message}`);
      logger.error(`[MEDIA_PROCESSOR] Stack trace: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Extrae información de un mensaje de media
   * @param {Object} mediaMessage - Mensaje de media (imageMessage, videoMessage, etc.)
   * @param {string} defaultFilename - Nombre de archivo por defecto
   * @returns {Object} Información del media
   */
  static extractMediaInfo(mediaMessage, defaultFilename) {
    return {
      mimetype: mediaMessage.mimetype,
      filename: mediaMessage.fileName || defaultFilename,
      caption: mediaMessage.caption || ''
    };
  }
}

export default MediaProcessor;

