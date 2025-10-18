import qrcode from 'qrcode-terminal';
import { logger } from './logger.js';

// Función para generar QR code visual
async function generateQRCode(qr) {
  try {
    logger.info(`${'='.repeat(30)}`);
    logger.info(`📱 ESCANEA ESTE CÓDIGO QR CON WHATSAPP`);
    logger.info(`${'='.repeat(30)}`);
    logger.info(``); // Enter adicional para separar
    
    // qrcode-terminal genera el QR directamente en la consola
    qrcode.generate(qr, { small: true });
    
    logger.info(``); // Enter adicional después del QR
    logger.info(`${'='.repeat(30)}`);
    
    // También mostrar el texto del QR como alternativa
    logger.info(`🔗 O copia este texto en una app de QR:`);
    logger.info(`${qr}`);
    logger.info(``);
  } catch (error) {
    logger.error('Error generando QR code:', error.message);
    logger.info(`QR Code (texto): ${qr}`);
  }
}

export {
  generateQRCode
};
