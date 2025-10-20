import express from 'express';
import { logger } from '../logger.js';
import Validators from '../validators.js';

const router = express.Router();

/**
 * Configura las rutas de información de contactos
 */
function setupContactRoutes(bot, authenticateToken) {
  // Endpoint para obtener información de contactos
  router.get('/contact', authenticateToken, async (req, res) => {
    try {
      // Verificar estado del bot
      if (!bot.isReady()) {
        logger.warn('[CONTACT_ROUTE] WhatsApp client not ready for contact lookup');
        return res.status(503).json({ 
          res: false, 
          error: 'WhatsApp client not connected or session closed' 
        });
      }

      // Obtener phoneNumber de query, body o params
      let phoneNumber = req.query?.phoneNumber || req.body?.phoneNumber || req.params?.phoneNumber;
      
      // Validar phoneNumber
      const validation = Validators.validateGetContactPayload({ phoneNumber });
      if (!validation.valid) {
        logger.warn('[CONTACT_ROUTE] Contact validation failed:', validation.errors);
        return res.status(400).json({ 
          res: false, 
          error: 'Validation failed',
          details: validation.errors 
        });
      }

      const { phoneNumber: cleanPhone } = validation.payload;
      
      try {
        const contactInfo = await bot.getContactInfo(cleanPhone);
        
        logger.info(`[CONTACT_ROUTE] Contact info retrieved for ${cleanPhone}: ${contactInfo.name}`);
        res.json({
          res: true,
          contact: contactInfo
        });
        
      } catch (err) {
        logger.error(`[CONTACT_ROUTE] Error fetching contact info: ${err.message}`);
        
        // Manejar errores específicos
        if (err.message.includes('not-authorized')) {
          return res.status(403).json({ success: false, error: 'No autorizado para acceder a este contacto' });
        }
        
        if (err.message.includes('not-found')) {
          return res.status(404).json({ success: false, error: 'Contacto no encontrado' });
        }
        
        res.status(500).json({ success: false, error: 'Error interno al obtener información del contacto' });
      }
      
    } catch (error) {
      logger.error(`[CONTACT_ROUTE] Error en endpoint de contacto: ${error.message}`);
      res.status(500).json({ 
        res: false, 
        error: 'Error interno del servidor',
        details: error.message 
      });
    }
  });

  return router;
}

export default setupContactRoutes;

