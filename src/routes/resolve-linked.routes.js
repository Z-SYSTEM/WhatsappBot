import express from 'express';
import { logger } from '../logger.js';

const router = express.Router();

/**
 * POST /api/resolve-linked-id — intenta obtener número PN desde store Baileys (getContactInfo).
 */
function setupResolveLinkedRoutes(bot, authenticateToken) {
  router.post('/resolve-linked-id', authenticateToken, async (req, res) => {
    const linkedId = req.body?.linkedId;
    if (!linkedId || String(linkedId).trim() === '') {
      return res.status(400).json({ error: 'Linked ID requerido' });
    }

    if (!bot.isReady()) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp client not connected',
        linkedId,
        resolved: false,
        realPhone: null,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const info = await bot.getContactInfo(String(linkedId).trim());
      const digits = info?.number ? String(info.number).replace(/\D/g, '') : '';
      const realPhone = digits.length >= 8 ? `${digits}@c.us` : null;

      return res.status(200).json({
        success: true,
        linkedId: String(linkedId).trim(),
        resolved: !!realPhone,
        realPhone,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(`[resolve-linked-id] ${err.message}`);
      return res.status(200).json({
        success: false,
        linkedId: String(linkedId).trim(),
        resolved: false,
        realPhone: null,
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}

export default setupResolveLinkedRoutes;
