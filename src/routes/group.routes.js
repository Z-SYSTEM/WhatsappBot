import express from 'express';
import { logger } from '../logger.js';
import Validators from '../validators.js';

const router = express.Router();

/**
 * Configura las rutas de información de grupos
 */
function setupGroupRoutes(bot, authenticateToken) {
  // Endpoint para obtener información de grupos
  router.get('/group', authenticateToken, async (req, res) => {
    try {
      // Verificar estado del bot
      if (!bot.isReady()) {
        logger.warn('[GROUP_ROUTE] WhatsApp client not ready for group lookup');
        return res.status(503).json({ 
          res: false, 
          error: 'WhatsApp client not connected or session closed' 
        });
      }

      // Obtener groupId de query, body o params
      let groupId = req.query?.groupId || req.body?.groupId || req.params?.groupId;
      
      // Validar groupId
      const validation = Validators.validateGetGroupPayload({ groupId });
      if (!validation.valid) {
        logger.warn('[GROUP_ROUTE] Group validation failed:', validation.errors);
        return res.status(400).json({ 
          res: false, 
          error: 'Validation failed',
          details: validation.errors 
        });
      }

      const { groupId: cleanGroupId } = validation.payload;
      
      try {
        const groupInfo = await bot.getGroupInfo(cleanGroupId);
        
        logger.info(`[GROUP_ROUTE] Group info retrieved for ${cleanGroupId}: ${groupInfo.name} (${groupInfo.participantsCount} participants)`);
        res.json({
          res: true,
          group: groupInfo
        });
        
      } catch (err) {
        logger.error(`[GROUP_ROUTE] Error fetching group info: ${err.message}`);
        
        // Manejar errores específicos
        if (err.message.includes('not-authorized')) {
          return res.status(403).json({ success: false, error: 'No autorizado para acceder a este grupo' });
        }
        
        if (err.message.includes('item-not-found') || err.message.includes('not-found') || err.message.includes('Grupo no encontrado')) {
          return res.status(404).json({ success: false, error: 'Grupo no encontrado' });
        }
        
        if (err.message.includes('groupMetadata is not a function')) {
          logger.error('[GROUP_ROUTE] groupMetadata function not available in this Baileys version');
          return res.status(500).json({ success: false, error: 'Función de grupo no disponible en esta versión de Baileys' });
        }
        
        res.status(500).json({ success: false, error: 'Error interno al obtener información del grupo' });
      }
      
    } catch (error) {
      logger.error('[GROUP_ROUTE] Error en endpoint de grupo:', error.message);
      res.status(500).json({ 
        res: false, 
        error: 'Error interno del servidor',
        details: error.message 
      });
    }
  });

  return router;
}

export default setupGroupRoutes;

