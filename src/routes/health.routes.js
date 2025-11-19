import express from 'express';
import { logger } from '../logger.js';

const router = express.Router();

/**
 * Configura las rutas de health check
 */
function setupHealthRoutes(bot, config, authenticateToken) {
  // Endpoint de health check
  router.get('/test', authenticateToken, (req, res) => {
    const status = bot.getStatus();
    
    // Solo loguear si hay un problema (bot no está ready)
    if (!status.isReady) {
      let clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
      
      // Extraer solo la IPv4 si viene con prefijo ::ffff:
      if (clientIP && clientIP.startsWith('::ffff:')) {
        clientIP = clientIP.substring(7);
      }
      
      logger.warn(`[HEALTH_CHECK] Bot not ready - Health check from ${clientIP}`);
    }
    
    res.json({
      status: 'ok',
      bot_name: config.botName,
      is_ready: status.isReady,
      is_connecting: status.isConnecting,
      restart_attempts: status.restartAttempts,
      last_health_check: status.lastHealthCheck,
      timestamp: new Date().toISOString()
    });
  });

  // Endpoint para ver información detallada de health
  router.get('/health-info', authenticateToken, (req, res) => {
    const status = bot.getStatus();
    res.json({
      bot_status: status,
      bot_name: config.botName,
      timestamp: new Date().toISOString()
    });
  });

  return router;
}

export default setupHealthRoutes;

