import axios from 'axios';
import { logger } from './logger.js';

class HttpClient {
  constructor() {
    // Constantes de endpoints
    this._FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';
    this._CONNECTIVITY_TEST_URL = 'https://www.google.com';
    
    // Configuraciones por defecto para diferentes tipos de requests
    this._DEFAULT_CONFIG = {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsApp-Bot/1.0'
      }
    };

    this._WEBHOOK_CONFIG = {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'WhatsApp-Bot/1.0'
      }
    };

    this._DOWNLOAD_CONFIG = {
      timeout: 30000,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'WhatsApp-Bot/1.0'
      }
    };

    this._HEALTH_CHECK_CONFIG = {
      timeout: 10000
    };

    this._CONNECTIVITY_CHECK_CONFIG = {
      timeout: 5000
    };
  }

  /**
   * Crea una respuesta estandarizada
   * @param {boolean} success - Si la operación fue exitosa
   * @param {number} responseCode - Código de respuesta HTTP
   * @param {string} status - 'ok' o 'error'
   * @param {any} data - Datos de respuesta (si success)
   * @param {string} error - Descripción del error (si !success)
   * @returns {object} Respuesta estandarizada
   */
  _createResponse(success, responseCode, status, data = null, error = null) {
    return {
      success,
      responseCode,
      status,
      ...(success ? { data } : { error })
    };
  }

  /**
   * Envía un webhook POST request
   * @param {string} url - URL del webhook
   * @param {object} data - Datos a enviar
   * @param {function} logFunction - Función para loggear el request (opcional)
   * @returns {Promise<object>} Respuesta estandarizada
   */
  async sendWebhook(url, data, logFunction = null) {
    try {
      logger.debug(`[HTTP_CLIENT] Enviando webhook a ${url}`);
      
      // Llamar función de log si se proporciona
      if (logFunction && typeof logFunction === 'function') {
        await logFunction(data);
      }

      const response = await axios.post(url, data, this._WEBHOOK_CONFIG);
      
      logger.debug(`[HTTP_CLIENT] Webhook enviado exitosamente a ${url}`);
      return this._createResponse(true, response.status, 'ok', response.data);
    } catch (error) {
      logger.error(`[HTTP_CLIENT] Error enviando webhook a ${url}:`, error.message);
      logger.error(`[HTTP_CLIENT] Datos enviados:`, JSON.stringify(data, null, 2));
      return this._createResponse(false, error.response?.status || 500, 'error', null, error.message);
    }
  }

  /**
   * Envía notificación FCM
   * @param {string} deviceToken - Token del dispositivo FCM
   * @param {object} notificationData - Datos de la notificación
   * @returns {Promise<object>} Respuesta estandarizada
   */
  async sendFCMNotification(deviceToken, notificationData) {
    try {
      logger.debug('[HTTP_CLIENT] Enviando notificación FCM');

      const config = {
        ...this._DEFAULT_CONFIG,
        headers: {
          'Authorization': `key=${deviceToken}`,
          'Content-Type': 'application/json'
        }
      };

      const response = await axios.post(this._FCM_ENDPOINT, notificationData, config);
      
      logger.info('[HTTP_CLIENT] Notificación FCM enviada exitosamente');
      return this._createResponse(true, response.status, 'ok', response.data);
    } catch (error) {
      logger.error('[HTTP_CLIENT] Error enviando notificación FCM:', error.message);
      return this._createResponse(false, error.response?.status || 500, 'error', null, error.message);
    }
  }

  /**
   * Descarga un archivo desde una URL
   * @param {string} url - URL del archivo
   * @param {string} mimetype - Tipo MIME del archivo (opcional)
   * @returns {Promise<object>} Respuesta estandarizada con Buffer en data
   */
  async downloadFile(url, mimetype = 'image/jpeg') {
    try {
      logger.debug(`[HTTP_CLIENT] Descargando archivo desde ${url}`);

      const response = await axios.get(url, this._DOWNLOAD_CONFIG);
      
      const buffer = Buffer.from(response.data);
      logger.debug(`[HTTP_CLIENT] Archivo descargado exitosamente, tamaño: ${buffer.length} bytes`);
      
      return this._createResponse(true, response.status, 'ok', buffer);
    } catch (error) {
      logger.error(`[HTTP_CLIENT] Error descargando archivo desde ${url}:`, error.message);
      return this._createResponse(false, error.response?.status || 500, 'error', null, `No se pudo descargar el archivo desde la URL: ${error.message}`);
    }
  }

  /**
   * Realiza un health check al bot
   * @param {number} port - Puerto del bot
   * @param {string} token - Token de autorización
   * @returns {Promise<object>} Respuesta estandarizada con estado del bot
   */
  async healthCheckBot(port, token) {
    try {
      const config = {
        ...this._HEALTH_CHECK_CONFIG,
        headers: {
          'Authorization': `Bearer ${token}`
        }
      };

      const response = await axios.get(`http://localhost:${port}/api/test`, config);
      
      return this._createResponse(true, response.status, 'ok', response.data);
    } catch (error) {
      logger.error(`[HTTP_CLIENT] Health check falló: ${error.message}`);
      return this._createResponse(false, error.response?.status || 500, 'error', null, error.message);
    }
  }

  /**
   * Verifica conectividad de red
   * @param {string} testUrl - URL para probar conectividad (default: google.com)
   * @returns {Promise<object>} Respuesta estandarizada con estado de conectividad
   */
  async checkNetworkConnectivity(testUrl = null) {
    try {
      const url = testUrl || this._CONNECTIVITY_TEST_URL;
      const response = await axios.get(url, this._CONNECTIVITY_CHECK_CONFIG);
      
      return this._createResponse(true, response.status, 'ok', {
        timestamp: new Date().toISOString(),
        testedUrl: url
      });
    } catch (error) {
      logger.error('[HTTP_CLIENT] Problema de conectividad de red detectado:', error.message);
      return this._createResponse(false, error.response?.status || 500, 'error', null, error.message);
    }
  }

  /**
   * Método genérico POST
   * @param {string} url - URL destino
   * @param {object} data - Datos a enviar
   * @param {object} customConfig - Configuración personalizada (opcional)
   * @returns {Promise<object>} Respuesta estandarizada
   */
  async post(url, data, customConfig = {}) {
    try {
      const config = { ...this._DEFAULT_CONFIG, ...customConfig };
      const response = await axios.post(url, data, config);
      
      return this._createResponse(true, response.status, 'ok', response.data);
    } catch (error) {
      logger.error(`[HTTP_CLIENT] Error en POST a ${url}:`, error.message);
      return this._createResponse(false, error.response?.status || 500, 'error', null, error.message);
    }
  }

  /**
   * Método genérico GET
   * @param {string} url - URL destino
   * @param {object} customConfig - Configuración personalizada (opcional)
   * @returns {Promise<object>} Respuesta estandarizada
   */
  async get(url, customConfig = {}) {
    try {
      const config = { ...this._DEFAULT_CONFIG, ...customConfig };
      const response = await axios.get(url, config);
      
      return this._createResponse(true, response.status, 'ok', response.data);
    } catch (error) {
      logger.error(`[HTTP_CLIENT] Error en GET a ${url}:`, error.message);
      return this._createResponse(false, error.response?.status || 500, 'error', null, error.message);
    }
  }
}

export default HttpClient;
