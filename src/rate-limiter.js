const { logger } = require('./logger');

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 15 * 60 * 1000; // 15 minutos por defecto
    this.maxRequests = options.maxRequests || 100; // 100 requests por ventana
    this.requests = new Map(); // IP -> { count: number, resetTime: number }
    this.blockedIPs = new Map(); // IP -> { blockedUntil: number, reason: string }
    this.blockDuration = options.blockDuration || 60 * 60 * 1000; // 1 hora de bloqueo
  }

  // Verificar si una IP está bloqueada
  isBlocked(ip) {
    const blocked = this.blockedIPs.get(ip);
    if (!blocked) return false;

    if (Date.now() > blocked.blockedUntil) {
      this.blockedIPs.delete(ip);
      logger.info(`[RATE_LIMIT] IP ${ip} unblocked - block period expired`);
      return false;
    }

    return true;
  }

  // Bloquear una IP
  blockIP(ip, reason = 'Rate limit exceeded') {
    const blockedUntil = Date.now() + this.blockDuration;
    this.blockedIPs.set(ip, { blockedUntil, reason });
    logger.warn(`IP ${ip} blocked until ${new Date(blockedUntil).toISOString()}. Reason: ${reason}`);
  }

  // Verificar rate limit
  checkRateLimit(ip) {
    const now = Date.now();
    const requestData = this.requests.get(ip);

    // Si la IP está bloqueada
    if (this.isBlocked(ip)) {
      const blocked = this.blockedIPs.get(ip);
      return {
        allowed: false,
        blocked: true,
        remainingTime: blocked.blockedUntil - now,
        reason: blocked.reason
      };
    }

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

    // Verificar si excede el límite
    if (newCount > this.maxRequests) {
      logger.warn(`[RATE_LIMIT] IP ${ip} exceeded limit: ${newCount}/${this.maxRequests} requests`);
      this.blockIP(ip);
      return {
        allowed: false,
        blocked: true,
        remainingTime: this.blockDuration,
        reason: 'Rate limit exceeded'
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
    let cleanedBlocks = 0;
    
    // Limpiar requests expirados
    for (const [ip, data] of this.requests.entries()) {
      if (now > data.resetTime) {
        this.requests.delete(ip);
        cleanedRequests++;
      }
    }

    // Limpiar IPs bloqueadas expiradas
    for (const [ip, blocked] of this.blockedIPs.entries()) {
      if (now > blocked.blockedUntil) {
        this.blockedIPs.delete(ip);
        cleanedBlocks++;
      }
    }

    // Log de estadísticas periódicas
    if (this.requests.size > 0 || this.blockedIPs.size > 0) {
      logger.info(`[RATE_LIMIT_STATS] Active requests: ${this.requests.size}, Blocked IPs: ${this.blockedIPs.size}, Cleaned: ${cleanedRequests} requests, ${cleanedBlocks} blocks`);
    }
  }

  // Obtener estadísticas
  getStats() {
    return {
      activeRequests: this.requests.size,
      blockedIPs: this.blockedIPs.size,
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
      blockDuration: this.blockDuration
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
        if (result.blocked) {
          logger.warn(`Rate limit exceeded for IP ${ip}. Blocked for ${Math.round(result.remainingTime / 1000)} seconds`);
          return res.status(429).json({
            error: 'Too many requests',
            message: result.reason,
            retryAfter: Math.ceil(result.remainingTime / 1000)
          });
        }
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
