import { logger, logRecovery } from './logger.js';
import HttpClient from './http-client.js';

class HealthChecker {
  constructor(config) {
    this.config = config;
    this.lastCheck = null;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 3;
    this.httpClient = new HttpClient();
  }

  // Verificar uso de memoria
  checkMemory() {
    const memoryUsage = process.memoryUsage();
    const formatMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
    
    const memoryInfo = {
      rss: formatMB(memoryUsage.rss),
      heapUsed: formatMB(memoryUsage.heapUsed),
      heapTotal: formatMB(memoryUsage.heapTotal),
      external: formatMB(memoryUsage.external)
    };

    // Alerta si el uso de memoria es alto
    const rssMB = memoryUsage.rss / 1024 / 1024;
    const heapUsedPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

    if (rssMB > 500) { // Más de 500MB RSS
      logger.warn(`Alto uso de memoria RSS: ${memoryInfo.rss}MB`);
    }

    if (heapUsedPercent > 90) { // Más del 90% del heap usado
      logger.warn(`Alto uso de heap: ${heapUsedPercent.toFixed(2)}%`);
    }

    return {
      status: 'ok',
      memory: memoryInfo,
      timestamp: new Date().toISOString()
    };
  }

  // Verificar estado del bot
  async checkBotStatus() {
    try {
      const result = await this.httpClient.healthCheckBot(this.config.port, this.config.token);

      if (result.status === 'ok' && result.data.status === 'ok') {
        this.consecutiveFailures = 0;
        return {
          status: 'ok',
          bot_ready: result.data.is_ready,
          timestamp: new Date().toISOString()
        };
      } else {
        throw new Error('Bot no está listo');
      }
    } catch (error) {
      this.consecutiveFailures++;
      logger.error(`Health check falló (intento ${this.consecutiveFailures}): ${error.message}`);
      
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        logRecovery.started(`health_check_failed_${this.consecutiveFailures}_times`);
        throw new Error(`Health check falló ${this.consecutiveFailures} veces consecutivas`);
      }

      return {
        status: 'error',
        error: error.message,
        consecutive_failures: this.consecutiveFailures,
        timestamp: new Date().toISOString()
      };
    }
  }

  // Verificar conectividad de red
  async checkNetworkConnectivity() {
    const result = await this.httpClient.checkNetworkConnectivity();
    
    if (result.status === 'ok') {
      return {
        status: 'ok',
        timestamp: result.data.timestamp
      };
    } else {
      logger.warn('Problema de conectividad de red detectado');
      return {
        status: 'error',
        error: result.error,
        timestamp: new Date().toISOString()
      };
    }
  }

  // Health check completo
  async performFullHealthCheck() {
    this.lastCheck = new Date();
    
    try {
      const results = {
        memory: this.checkMemory(),
        bot: await this.checkBotStatus(),
        network: await this.checkNetworkConnectivity(),
        timestamp: new Date().toISOString()
      };

      // Determinar estado general
      const allOk = results.memory.status === 'ok' && 
                   results.bot.status === 'ok' && 
                   results.network.status === 'ok';

      if (allOk) {
        logger.debug('Health check completo: OK');
        logRecovery.success('health_check_passed');
      } else {
        logger.warn('Health check completo: Problemas detectados', results);
      }

      return {
        status: allOk ? 'ok' : 'warning',
        results: results
      };

    } catch (error) {
      logger.error('Health check completo falló:', error.message);
      logRecovery.failed(error, 'health_check');
      
      return {
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  // Obtener estadísticas
  getStats() {
    return {
      lastCheck: this.lastCheck,
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures
    };
  }
}

export default HealthChecker;
