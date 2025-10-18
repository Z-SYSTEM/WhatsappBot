import express from 'express';
import { logger } from '../logger.js';
import Validators from '../validators.js';
import { _MESSAGE_TYPE_IMAGE, _MESSAGE_TYPE_DOCUMENT, _MESSAGE_TYPE_CONTACT } from '../constants.js';

const router = express.Router();

/**
 * Configura las rutas de envío de mensajes
 */
function setupSendRoutes(bot, authenticateToken) {
  // Endpoint para enviar mensajes
  router.post('/send', authenticateToken, async (req, res) => {
    try {
      // Verificar estado del bot
      if (!bot.isReady()) {
        logger.warn('[SEND_ROUTE] WhatsApp client not ready or session closed');
        return res.status(503).json({ 
          res: false, 
          error: 'WhatsApp client not connected or session closed' 
        });
      }

      // Validar payload
      const validation = Validators.validateSendMessagePayload(req.body);
      if (!validation.valid) {
        logger.warn('[SEND_ROUTE] Validation failed:', validation.errors);
        return res.status(400).json({ 
          res: false, 
          error: 'Validation failed',
          details: validation.errors 
        });
      }

      const { phoneNumber, message, imageUrl, imageUrls, pdfUrl, contact, vcard } = validation.payload;

      // Preparar chatId
      let chatId;
      if (phoneNumber.includes('@g.us')) {
        chatId = phoneNumber;
      } else {
        let cleanPhone = phoneNumber;
        if (cleanPhone.startsWith('+')) {
          cleanPhone = cleanPhone.substring(1);
        }
        chatId = cleanPhone + "@c.us";
      }
      
      logger.info(`[SEND_ROUTE] Looking up WhatsApp ID for ${chatId}`);

      // Control de destinatarios no válidos
      if (chatId === 'status@c.us' || chatId === 'status@broadcast') {
        logger.warn('[SEND_ROUTE] Intento de enviar mensaje a destinatario no válido:', chatId);
        return res.status(400).json({ error: 'Destinatario no permitido.' });
      }

      // Preparar datos para enviar
      const sendData = {
        phone: chatId,
        message: message || '',
        type: 'text'
      };

      // Determinar tipo de contenido y preparar datos
      if (pdfUrl) {
        sendData.type = _MESSAGE_TYPE_DOCUMENT;
        sendData.media = {
          url: pdfUrl,
          mimetype: 'application/pdf',
          filename: 'document.pdf'
        };
        logger.info(`[SEND_ROUTE] Sending PDF to ${chatId}`);
      } else if (imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0) {
        // Para múltiples imágenes, enviar una por una
        logger.info(`[SEND_ROUTE] Sending ${imageUrls.length} images to ${chatId}`);
        
        let successCount = 0;
        for (let i = 0; i < imageUrls.length; i++) {
          try {
            const imageData = {
              phone: chatId,
              message: (i === 0 && message) ? message : '',
              type: _MESSAGE_TYPE_IMAGE,
              media: {
                url: imageUrls[i],
                mimetype: 'image/jpeg'
              }
            };
            
            const result = await bot.sendMessage(imageData);
            
            if (!result.success) {
              throw new Error(`Error sending image ${i + 1}: ${result.error}`);
            }
            
            successCount++;
            logger.info(`[SEND_ROUTE] Image ${i + 1}/${imageUrls.length} sent to ${chatId}`);
            
            // Pequeña pausa entre imágenes
            if (i < imageUrls.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (imageError) {
            logger.error(`[SEND_ROUTE] Error sending image ${i + 1}: ${imageError.message}`);
          }
        }
        
        logger.info(`[SEND_ROUTE] Successfully sent ${successCount}/${imageUrls.length} images to ${chatId}`);
        return res.json({ status: true, imagesSent: successCount, totalImages: imageUrls.length });
        
      } else if (imageUrl) {
        sendData.type = _MESSAGE_TYPE_IMAGE;
        sendData.media = {
          url: imageUrl,
          mimetype: 'image/jpeg'
        };
        logger.info(`[SEND_ROUTE] Sending single image to ${chatId}`);
      } else if (contact) {
        sendData.type = _MESSAGE_TYPE_CONTACT;
        sendData.media = {
          contact: contact
        };
        logger.info(`[SEND_ROUTE] Sending contact to ${chatId}: ${contact.name}`);
      } else if (vcard) {
        sendData.type = _MESSAGE_TYPE_CONTACT;
        sendData.media = {
          vcard: vcard
        };
        logger.info(`[SEND_ROUTE] Sending vCard to ${chatId}`);
      } else if (message) {
        sendData.type = 'text';
      }

      // Enviar mensaje
      const result = await bot.sendMessage(sendData);
      
      if (result.success) {
        return res.json({ status: true });
      } else {
        throw new Error(result.error || 'Unknown error');
      }

    } catch (error) {
      logger.error('[SEND_ROUTE] Error enviando mensaje:', error.message);
      res.status(500).json({
        res: false,
        error: 'Error interno del servidor',
        details: error.message
      });
    }
  });

  return router;
}

export default setupSendRoutes;

