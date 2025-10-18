import { logger } from '../logger.js';
import { _MESSAGE_TYPE_CALL } from '../constants.js';

class CallHandler {
  constructor(sock, acceptCall, httpClient, onMessageUrl, logOnMessageRequest) {
    this.sock = sock;
    this.acceptCall = acceptCall;
    this.httpClient = httpClient;
    this.onMessageUrl = onMessageUrl;
    this.logOnMessageRequest = logOnMessageRequest;
  }

  /**
   * Actualiza el socket de WhatsApp
   */
  updateSocket(sock) {
    this.sock = sock;
  }

  /**
   * Maneja llamadas entrantes
   */
  async handleCall(json) {
    try {
      // Verificar que json sea un array y tenga elementos
      if (!Array.isArray(json) || json.length === 0) {
        return;
      }

      const callData = json[0];
      
      // Debug: mostrar información básica de la llamada
      logger.debug(`[CALL_HANDLER] Status: ${callData.status}, ID: ${callData.id}, from: ${callData.from}`);
      
      // Crear datos del mensaje
      const messageData = {
        phoneNumber: callData.from.replace('@c.us', '').replace('@s.whatsapp.net', ''),
        type: _MESSAGE_TYPE_CALL,
        from: callData.from.replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@lid', ''),
        id: `call_${Date.now()}`,
        timestamp: Math.floor(Date.now() / 1000),
        body: 'Llamada entrante rechazada automáticamente',
        hasMedia: false,
        data: {
          status: callData.status || 'offer',
          duration: callData.duration || 0,
          callId: callData.id,
          callType: callData.isVideo ? 'video' : 'voice',
          fromMe: false,
          timestamp: callData.date ? Math.floor(callData.date.getTime() / 1000) : Math.floor(Date.now() / 1000),
          isVideo: callData.isVideo || false,
          isGroup: callData.isGroup || false
        }
      };

      // Solo procesar llamadas de tipo 'offer' (inicio de llamada)
      if (messageData.data.status === 'offer') {
        if (this.acceptCall) {
          await this.acceptIncomingCall(callData, messageData);
        } else {
          await this.rejectIncomingCall(callData, messageData);
        }

        // Enviar webhook para llamadas aceptadas o rechazadas
        if (this.onMessageUrl) {
          try {
            await this.httpClient.sendWebhook(this.onMessageUrl, messageData, this.logOnMessageRequest);
            logger.info(`[CALL_HANDLER] Webhook enviado: llamada ${this.acceptCall ? 'aceptada' : 'rechazada'} de ${messageData.phoneNumber}`);
          } catch (error) {
            logger.error('[CALL_HANDLER] Error enviando webhook:', error.message);
          }
        }
      }

    } catch (error) {
      logger.error('[CALL_HANDLER] Error procesando llamada:', error.message);
    }
  }

  /**
   * Acepta una llamada entrante
   */
  async acceptIncomingCall(callData, messageData) {
    logger.info(`[CALL_HANDLER] Llamada entrante de ${messageData.phoneNumber}, aceptando automáticamente (ACCEPT_CALL=TRUE)`);
    
    try {
      logger.debug(`[CALL_HANDLER] Socket disponible: ${!!this.sock}, acceptCall: ${this.sock && typeof this.sock.acceptCall === 'function'}`);
      
      if (this.sock && typeof this.sock.acceptCall === 'function') {
        await this.sock.acceptCall(callData.id, callData.from);
        logger.info(`[CALL_HANDLER] Llamada aceptada exitosamente de ${messageData.phoneNumber}`);
      } else {
        logger.warn('[CALL_HANDLER] Función acceptCall no disponible');
      }
    } catch (acceptError) {
      logger.error('[CALL_HANDLER] Error aceptando llamada:', acceptError.message);
    }
    
    messageData.body = 'Llamada entrante aceptada automáticamente';
  }

  /**
   * Rechaza una llamada entrante
   */
  async rejectIncomingCall(callData, messageData) {
    logger.info(`[CALL_HANDLER] Llamada entrante de ${messageData.phoneNumber}, rechazando automáticamente (ACCEPT_CALL=FALSE)`);
    
    try {
      logger.debug(`[CALL_HANDLER] Socket disponible: ${!!this.sock}, rejectCall: ${this.sock && typeof this.sock.rejectCall === 'function'}`);
      
      if (this.sock && typeof this.sock.rejectCall === 'function') {
        await this.sock.rejectCall(callData.id, callData.from);
        logger.info(`[CALL_HANDLER] Llamada rechazada exitosamente de ${messageData.phoneNumber}`);
      } else {
        logger.warn('[CALL_HANDLER] Función rejectCall no disponible');
        // Intentar método alternativo
        if (this.sock && typeof this.sock.query === 'function') {
          const stanza = {
            tag: 'call',
            attrs: {
              from: this.sock.authState?.creds?.me?.id,
              to: callData.from,
            },
            content: [{
              tag: 'reject',
              attrs: {
                'call-id': callData.id,
                'call-creator': callData.from,
                count: '0',
              },
              content: undefined,
            }],
          };
          await this.sock.query(stanza);
          logger.info(`[CALL_HANDLER] Llamada rechazada usando método alternativo de ${messageData.phoneNumber}`);
        }
      }
    } catch (rejectError) {
      logger.error('[CALL_HANDLER] Error rechazando llamada:', rejectError.message);
    }
    
    messageData.body = 'Llamada entrante rechazada automáticamente';
  }
}

export default CallHandler;

