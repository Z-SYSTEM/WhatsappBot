import setupHealthRoutes from './health.routes.js';
import setupSendRoutes from './send.routes.js';
import setupContactRoutes from './contact.routes.js';
import setupGroupRoutes from './group.routes.js';

/**
 * Configura todas las rutas de la API
 */
function setupRoutes(app, bot, config, authenticateToken) {
  // Registrar rutas con prefijo /api
  app.use('/api', setupHealthRoutes(bot, config, authenticateToken));
  app.use('/api', setupSendRoutes(bot, authenticateToken));
  app.use('/api', setupContactRoutes(bot, authenticateToken));
  app.use('/api', setupGroupRoutes(bot, authenticateToken));
}

export default setupRoutes;

