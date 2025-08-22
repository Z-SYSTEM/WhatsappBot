// Configuración global para los tests
require('dotenv').config();

// Configurar timeouts más largos para tests de integración
jest.setTimeout(30000);

// Configurar variables de entorno para testing si no están definidas
if (!process.env.BOT_URL) {
  process.env.BOT_URL = 'http://localhost:4002';
}
