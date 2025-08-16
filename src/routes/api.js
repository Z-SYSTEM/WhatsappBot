const express = require('express');
const axios = require('axios');
const { logger } = require('../logger');
const { authenticateToken } = require('../middleware/auth');
const Validators = require('../validators');
const constants = require('../config/constants');
const config = require('../config/environment');

class ApiRoutes {
  constructor(messageSender, healthChecker, rateLimiter) {
    this.messageSender = messageSender;
    this.healthChecker = healthChecker;
    this.rateLimiter = rateLimiter;
    this.router = express.Router();
    this.setupRoutes();
  }

  setupRoutes() {
    // Endpoint de health check
    this.router.get('/test', authenticateToken, this.handleHealthCheck.bind(this));

    // Endpoint para ver estadísticas del rate limiter
    this.router.get('/rate-limit-stats', authenticateToken, this.handleRateLimitStats.bind(this));

    // Endpoint para ver información de health checks
    this.router.get('/health-info', authenticateToken, this.handleHealthInfo.bind(this));

    // Endpoint para enviar mensajes
    this.router.post('/send', authenticateToken, this.handleSendMessage.bind(this));

    // Endpoint para obtener información de contactos
    this.router.get('/contact', authenticateToken, this.handleGetContact.bind(this));
  }

  // Endpoint de health check
  handleHealthCheck(req, res) {
    // Log adicional para requests externos (solo una vez por minuto por IP)
    let clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
    
    // Extraer solo la IPv4 si viene con prefijo ::ffff:
    if (clientIP && clientIP.startsWith('::ffff:')) {
      clientIP = clientIP.substring(7);
    }
    
    const isLocalhost = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === 'localhost';
    
    if (!isLocalhost) {
      const now = Date.now();
      const lastLogKey = `health_check_${clientIP}`;
      
      if (!global.lastHealthCheckLog || !global.lastHealthCheckLog[lastLogKey] || 
          (now - global.lastHealthCheckLog[lastLogKey]) > 60000) { // 1 minuto
        
        if (!global.lastHealthCheckLog) global.lastHealthCheckLog = {};
        global.lastHealthCheckLog[lastLogKey] = now;
        
        logger.info(`[HEALTH_CHECK] External health check from ${clientIP} - User-Agent: ${req.headers['user-agent'] || 'Unknown'}`);
      }
    }
    
    res.json({
      status: 'ok',
      bot_name: config.BOT_NAME,
      is_ready: this.messageSender.isConnected,
      timestamp: new Date().toISOString()
    });
  }

  // Endpoint para ver estadísticas del rate limiter
  handleRateLimitStats(req, res) {
    const stats = this.rateLimiter.getStats();
    res.json({
      rate_limit_stats: stats,
      timestamp: new Date().toISOString()
    });
  }

  // Endpoint para ver información de health checks
  handleHealthInfo(req, res) {
    const healthStats = this.healthChecker.getStats();
    res.json({
      health_checker: healthStats,
      timestamp: new Date().toISOString()
    });
  }

  // Endpoint para enviar mensajes
  async handleSendMessage(req, res) {
    try {
      // Verificación más robusta del estado del bot
      if (!this.messageSender.isConnected) {
        logger.warn('WhatsApp client not ready or session closed');
        return res.status(503).json({ 
          res: false, 
          error: 'WhatsApp client not connected or session closed' 
        });
      }

      // Validar y sanitizar payload completo
      const validation = Validators.validateSendMessagePayload(req.body);
      if (!validation.valid) {
        logger.warn('Validation failed:', validation.errors);
        return res.status(400).json({ 
          res: false, 
          error: 'Validation failed',
          details: validation.errors 
        });
      }

      const { phoneNumber, message, imageUrl, imageUrls, pdfUrl, contact, vcard } = validation.payload;

      // Declarar chatId fuera del try para que esté disponible en el catch
      let chatId;
      
      let triedRecovery = false;
      let lastError = null;
      
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          chatId = phoneNumber.substring(1) + "@c.us";
          logger.info(`Looking up WhatsApp ID for ${chatId}`);

          // Control de destinatarios no válidos
          if (chatId === 'status@c.us' || chatId === 'status@broadcast') {
            logger.warn('Intento de enviar mensaje a destinatario no válido:', chatId);
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
            sendData.type = constants.MESSAGE_TYPE_DOCUMENT;
            sendData.media = {
              url: pdfUrl,
              mimetype: 'application/pdf',
              filename: 'document.pdf'
            };
            logger.info(`Sending PDF to ${chatId}`);
          } else if (imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0) {
            // Para múltiples imágenes, enviar una por una
            logger.info(`Sending ${imageUrls.length} images to ${chatId}`);
            
            let successCount = 0;
            for (let i = 0; i < imageUrls.length; i++) {
              try {
                const imageData = {
                  phone: chatId,
                  message: (i === 0 && message) ? message : '', // Solo caption en la primera imagen
                  type: constants.MESSAGE_TYPE_IMAGE,
                  media: {
                    url: imageUrls[i],
                    mimetype: 'image/jpeg'
                  }
                };
                
                const result = await this.messageSender.sendMessage(imageData);
                
                if (!result.success) {
                  throw new Error(`Error sending image ${i + 1}: ${result.error}`);
                }
                
                successCount++;
                logger.info(`Image ${i + 1}/${imageUrls.length} sent to ${chatId}`);
                
                // Pequeña pausa entre imágenes para evitar spam
                if (i < imageUrls.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
              } catch (imageError) {
                logger.error(`Error sending image ${i + 1}: ${imageError.message}`);
                // Continuar con las siguientes imágenes en caso de error
              }
            }
            
            logger.info(`Successfully sent ${successCount}/${imageUrls.length} images to ${chatId}`);
            return res.json({ status: true, imagesSent: successCount, totalImages: imageUrls.length });
            
          } else if (imageUrl) {
            sendData.type = constants.MESSAGE_TYPE_IMAGE;
            sendData.media = {
              url: imageUrl,
              mimetype: 'image/jpeg'
            };
            logger.info(`Sending single image to ${chatId}`);
          } else if (contact) {
            sendData.type = constants.MESSAGE_TYPE_CONTACT;
            sendData.media = {
              contact: contact
            };
            logger.info(`Sending contact to ${chatId}: ${contact.name}`);
          } else if (vcard) {
            sendData.type = constants.MESSAGE_TYPE_CONTACT;
            sendData.media = {
              vcard: vcard
            };
            logger.info(`Sending vCard to ${chatId}`);
          } else if (message) {
            sendData.type = 'text';
            logger.info(`Sending text message to ${chatId}: ${message}`);
          }

          // Enviar mensaje directamente
          const result = await this.messageSender.sendMessage(sendData);
          
          if (result.success) {
            logger.info(`Message sent to ${chatId}`);
            return res.json({ status: true });
          } else {
            throw new Error(result.error || 'Unknown error');
          }

        } catch (error) {
          lastError = error;
          logger.error(`Error sending message (attempt ${attempt + 1}): ${error.stack || error}`);
          
          // Verificar si es error de sesión cerrada (adaptado para Baileys)
          if (error.message.includes('connection') || error.message.includes('session') || 
              error.message.includes('disconnect') || error.message.includes('timeout')) {
            logger.warn(`Session lost during message send to ${chatId || phoneNumber}, will auto-reconnect`);
            if (!triedRecovery) {
              triedRecovery = true;
              // Esperar 2 segundos tras recovery para intentar reenvío
              await new Promise(res => setTimeout(res, 2000));
              continue; // Reintentar el envío
            } else {
              return res.status(503).json({ 
                res: false, 
                error: 'WhatsApp session temporarily unavailable, please retry in a few seconds',
                retry: true 
              });
            }
          } else {
            break; // No es error de sesión, no reintentar
          }
        }
      }
      
      // Si llega aquí, falló ambos intentos
      return res.status(500).json({ 
        res: false, 
        error: 'Internal server error', 
        details: lastError && (lastError.stack || lastError.message || lastError) 
      });

    } catch (error) {
      logger.error('Error enviando mensaje:', error.message);
      res.status(500).json({
        res: false,
        error: 'Error interno del servidor',
        details: error.message
      });
    }
  }

  // Endpoint para obtener información de contactos
  async handleGetContact(req, res) {
    try {
      // Verificación del estado del bot
      if (!this.messageSender.isConnected) {
        logger.warn('WhatsApp client not ready for contact lookup');
        return res.status(503).json({ 
          res: false, 
          error: 'WhatsApp client not connected or session closed' 
        });
      }

      // Permitir phoneNumber por query, body o params
      let phoneNumber = undefined;
      if (req.query && req.query.phoneNumber) {
        phoneNumber = req.query.phoneNumber;
      } else if (req.body && req.body.phoneNumber) {
        phoneNumber = req.body.phoneNumber;
      } else if (req.params && req.params.phoneNumber) {
        phoneNumber = req.params.phoneNumber;
      }
      
      // Validar y sanitizar phoneNumber
      const validation = Validators.validateGetContactPayload({ phoneNumber });
      if (!validation.valid) {
        logger.warn('Contact validation failed:', validation.errors);
        return res.status(400).json({ 
          res: false, 
          error: 'Validation failed',
          details: validation.errors 
        });
      }

      const { phoneNumber: cleanPhone } = validation.payload;
      const wid = cleanPhone.endsWith('@c.us') ? cleanPhone : `${cleanPhone}@c.us`;
      
      logger.info(`Looking up contact info for ${wid}`);
      
      try {
        const sock = this.messageSender.getSocket();
        
        // Obtener información del contacto usando las funciones correctas de Baileys
        logger.debug(`Attempting to get contact info for: ${wid}`);
        
        // Intentar obtener el contacto del store
        let contactData = null;
        
        try {
          // Intentar obtener el contacto usando la función correcta de Baileys
          const contacts = await sock.contactsUpsert([{ id: wid }]);
          if (contacts && contacts.length > 0) {
            contactData = contacts[0];
            logger.debug(`Contact found via contactsUpsert`);
          }
        } catch (upsertError) {
          logger.debug(`contactsUpsert failed: ${upsertError.message}`);
        }
        
        // Si no se pudo obtener con contactsUpsert, intentar del store
        if (!contactData && sock.contacts && sock.contacts[wid]) {
          contactData = sock.contacts[wid];
          logger.debug(`Contact found in store`);
        }
        
        // Si aún no hay datos, crear uno básico
        if (!contactData) {
          contactData = {
            id: wid,
            name: 'Unknown',
            pushName: null,
            verifiedName: null,
            status: null
          };
          logger.debug(`Contact not in store, using default data`);
        }
        
        // Intentar obtener foto de perfil
        let profilePicUrl = null;
        try {
          profilePicUrl = await sock.profilePictureUrl(wid, 'image');
          logger.debug(`Profile picture URL obtained: ${profilePicUrl}`);
        } catch (e) {
          // Es normal que algunos contactos no tengan foto
          logger.debug(`No profile picture available for ${wid}: ${e.message}`);
          profilePicUrl = null;
        }
        
        // Verificar si el contacto existe y tiene información válida
        if (!contactData) {
          logger.warn(`Contact not found: ${wid}`);
          return res.status(404).json({ success: false, error: 'Contacto no encontrado' });
        }
        
        const contactName = contactData?.name || contactData?.pushName || 'Unknown';
        logger.debug(`Resolved contact name: ${contactName}`);
        
        const contactInfo = {
          id: wid,
          name: contactName,
          number: wid.replace('@c.us', ''),
          isBusiness: contactData?.verifiedName ? true : false,
          profilePicUrl,
          status: contactData?.status || '',
          verified: contactData?.verifiedName ? true : false,
          verifiedName: contactData?.verifiedName || null
        };
        
        logger.info(`Contact info retrieved for ${wid}: ${contactInfo.name}`);
        res.json({
          res: true,
          contact: contactInfo
        });
        
      } catch (err) {
        logger.error(`Error fetching contact info for ${wid}: ${err.message}`);
        logger.error(`Error stack:`, err.stack);
        
        // Manejar errores específicos de Baileys
        if (err.message.includes('not-authorized')) {
          return res.status(403).json({ success: false, error: 'No autorizado para acceder a este contacto' });
        }
        
        if (err.message.includes('not-found')) {
          return res.status(404).json({ success: false, error: 'Contacto no encontrado' });
        }
        
        if (err.message.includes('contactsUpsert is not a function')) {
          logger.error('contactsUpsert function not available in this Baileys version');
          return res.status(500).json({ success: false, error: 'Función de contacto no disponible en esta versión de Baileys' });
        }
        
        res.status(500).json({ success: false, error: 'Error interno al obtener información del contacto' });
      }
      
    } catch (error) {
      logger.error('Error en endpoint de contacto:', error.message);
      res.status(500).json({ 
        res: false, 
        error: 'Error interno del servidor',
        details: error.message 
      });
    }
  }

  getRouter() {
    return this.router;
  }
}

module.exports = ApiRoutes;
