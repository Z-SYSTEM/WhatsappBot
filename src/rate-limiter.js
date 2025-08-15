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
    
    // Limpiar requests expirados
    for (const [ip, data] of this.requests.entries()) {
      if (now > data.resetTime) {
        this.requests.delete(ip);
      }
    }

    // Limpiar IPs bloqueadas expiradas
    for (const [ip, blocked] of this.blockedIPs.entries()) {
      if (now > blocked.blockedUntil) {
        this.blockedIPs.delete(ip);
      }
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

  // Middleware para Express
  middleware() {
    return (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket?.remoteAddress;
      
      if (!ip) {
        logger.warn('Could not determine client IP address');
        return next();
      }

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
