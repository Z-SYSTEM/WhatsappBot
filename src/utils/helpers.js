const axios = require('axios');
const { logger } = require('../logger');

// Función para descargar archivo desde URL
async function downloadFromUrl(url, mimetype = 'image/jpeg') {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'WhatsApp-Bot/1.0'
      }
    });
    
    return Buffer.from(response.data);
  } catch (error) {
    logger.error(`Error descargando archivo desde URL ${url}:`, error.message);
    throw new Error(`No se pudo descargar el archivo desde la URL: ${error.message}`);
  }
}

// Función para verificar si un mensaje es reenviado
function isMessageForwarded(messageObj) {
  return messageObj && messageObj.contextInfo && messageObj.contextInfo.isForwarded;
}

// Función para verificar si ya existe otra instancia corriendo
async function checkExistingInstance(port) {
  try {
    const net = require('net');
    
    return new Promise((resolve) => {
      const tempServer = net.createServer();
      
      tempServer.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Puerto ${port} ya está en uso por otra instancia`);
          logger.warn('Cerrando esta instancia para evitar conflictos');
          process.exit(0);
        } else {
          logger.error('Error verificando puerto:', err.message);
          resolve(); // Continuar en caso de error
        }
      });
      
      tempServer.once('listening', () => {
        tempServer.close();
        logger.info('Puerto disponible, continuando con el inicio');
        resolve();
      });
      
      tempServer.listen(port);
    });
  } catch (error) {
    logger.error('Error en verificación de instancia única:', error.message);
    // En caso de error, continuar
  }
}

module.exports = {
  downloadFromUrl,
  isMessageForwarded,
  checkExistingInstance
};
