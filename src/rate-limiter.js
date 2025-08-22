const { logger } = require('./logger');

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 15 * 60 * 1000; // 15 minutos por defecto
    this.maxRequests = options.maxRequests || 100; // 100 requests por ventana
    this.requests = new Map(); // IP -> { count: number, resetTime: number }
    // ELIMINADO: Sistema de bloqueo de IPs completamente removido
  }

  // ELIMINADO: Métodos de bloqueo de IPs completamente removidos

  // Verificar rate limit (SIN bloqueo de IPs)
  checkRateLimit(ip) {
    const now = Date.now();
    const requestData = this.requests.get(ip);

    // Si es la primera request de esta IP
    if (!requestData) {
      this.requests.set(ip, {
        count: 1,
        resetTime: now + this.windowMs
      });
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime: now + this.windowMs
      };
    }

    // Si la ventana de tiempo ha expirado
    if (now > requestData.resetTime) {
      this.requests.set(ip, {
        count: 1,
        resetTime: now + this.windowMs
      });
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime: now + this.windowMs
      };
    }

    // Incrementar contador
    const newCount = requestData.count + 1;
    this.requests.set(ip, {
      count: newCount,
      resetTime: requestData.resetTime
    });

    // Verificar si excede el límite (SOLO log, NO bloqueo)
    if (newCount > this.maxRequests) {
      logger.warn(`[RATE_LIMIT] IP ${ip} exceeded limit: ${newCount}/${this.maxRequests} requests - returning 429 but NOT blocking IP`);
      return {
        allowed: false,
        blocked: false, // NUNCA bloqueado
        remaining: 0,
        resetTime: requestData.resetTime,
        reason: 'Rate limit exceeded (temporary)'
      };
    }

    return {
      allowed: true,
      remaining: this.maxRequests - newCount,
      resetTime: requestData.resetTime
    };
  }

  // Limpiar datos expirados
  cleanup() {
    const now = Date.now();
    let cleanedRequests = 0;
    
    // Limpiar requests expirados
    for (const [ip, data] of this.requests.entries()) {
      if (now > data.resetTime) {
        this.requests.delete(ip);
        cleanedRequests++;
      }
    }

    // Log de estadísticas periódicas
    if (this.requests.size > 0) {
      logger.info(`[RATE_LIMIT_STATS] Active requests: ${this.requests.size}, Cleaned: ${cleanedRequests} requests`);
    }
  }

  // Obtener estadísticas
  getStats() {
    return {
      activeRequests: this.requests.size,
      blockedIPs: 0, // SIEMPRE 0 - no se bloquean IPs
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
      blockingEnabled: false // Indicador de que el bloqueo está deshabilitado
    };
  }

  // Convertir IP IPv6 a IPv4 si es posible
  normalizeIP(ip) {
    // Si es una IP IPv4 mapeada a IPv6 (::ffff:xxx.xxx.xxx.xxx)
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7); // Remover el prefijo ::ffff:
    }
    return ip;
  }

  // Middleware para Express
  middleware() {
    return (req, res, next) => {
      let ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket?.remoteAddress;
      
      if (!ip) {
        logger.warn('Could not determine client IP address');
        return next();
      }

      // Normalizar IP para mejor legibilidad
      ip = this.normalizeIP(ip);

      // Log del request con información adicional
      const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
      const logLevel = isLocalhost ? 'debug' : 'info';
      logger[logLevel](`[REQUEST] ${req.method} ${req.path} from IP ${ip}${isLocalhost ? ' (internal)' : ' (external)'}`);

      const result = this.checkRateLimit(ip);

      if (!result.allowed) {
        logger.warn(`Rate limit exceeded for IP ${ip}. Returning 429 but NOT blocking IP`);
        return res.status(429).json({
          error: 'Too many requests',
          message: result.reason || 'Rate limit exceeded (temporary)',
          retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000)
        });
      }

      // Log del rate limit status
      logger.debug(`[RATE_LIMIT] IP ${ip}: ${result.remaining} requests remaining, resets at ${new Date(result.resetTime).toISOString()}`);

      // Agregar headers de rate limit
      res.set({
        'X-RateLimit-Limit': this.maxRequests,
        'X-RateLimit-Remaining': result.remaining,
        'X-RateLimit-Reset': new Date(result.resetTime).toISOString()
      });

      next();
    };
  }
}

module.exports = RateLimiter;
