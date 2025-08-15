const qrcode = require('qrcode-terminal');
const { logger } = require('./logger');

// Función para generar QR code visual
async function generateQRCode(qr) {
  try {
    console.log('\n' + '='.repeat(30));
    console.log('📱 ESCANEA ESTE CÓDIGO QR CON WHATSAPP');
    console.log('='.repeat(30));
    console.log(''); // Enter adicional para separar
    
    // qrcode-terminal genera el QR directamente en la consola
    qrcode.generate(qr, { small: true });
    
    console.log(''); // Enter adicional después del QR
    console.log('='.repeat(30) + '\n');
    
    // También mostrar el texto del QR como alternativa
    console.log('🔗 O copia este texto en una app de QR:');
    console.log(qr);
    console.log('\n');
  } catch (error) {
    logger.error('Error generando QR code:', error.message);
    console.log('QR Code (texto):', qr);
  }
}

module.exports = {
  generateQRCode
};
