import express from 'express';
import { logger } from '../logger.js';

const router = express.Router();

/**
 * Configura las rutas de health check
 */
function setupHealthRoutes(bot, config, authenticateToken) {
  // Endpoint de health check
  router.get('/test', authenticateToken, (req, res) => {
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
          (now - global.lastHealthCheckLog[lastLogKey]) > 60000) {
        
        if (!global.lastHealthCheckLog) global.lastHealthCheckLog = {};
        global.lastHealthCheckLog[lastLogKey] = now;
        
        logger.info(`[HEALTH_CHECK] External health check from ${clientIP} - User-Agent: ${req.headers['user-agent'] || 'Unknown'}`);
      }
    }
    
    const status = bot.getStatus();
    
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

  return router;
}

export default setupHealthRoutes;

