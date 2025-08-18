const qrcode = require('qrcode-terminal');
const { logger } = require('./logger');

// Función para formatear timestamp en formato local
function formatTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Función para generar QR code visual
async function generateQRCode(qr) {
  try {
    console.log(`${formatTimestamp()} info: ${'='.repeat(30)}`);
    console.log(`${formatTimestamp()} info: 📱 ESCANEA ESTE CÓDIGO QR CON WHATSAPP`);
    console.log(`${formatTimestamp()} info: ${'='.repeat(30)}`);
    console.log(`${formatTimestamp()} info: `); // Enter adicional para separar
    
    // qrcode-terminal genera el QR directamente en la consola
    qrcode.generate(qr, { small: true });
    
    console.log(`${formatTimestamp()} info: `); // Enter adicional después del QR
    console.log(`${formatTimestamp()} info: ${'='.repeat(30)}`);
    
    // También mostrar el texto del QR como alternativa
    console.log(`${formatTimestamp()} info: 🔗 O copia este texto en una app de QR:`);
    console.log(`${formatTimestamp()} info: ${qr}`);
    console.log(`${formatTimestamp()} info: `);
  } catch (error) {
    logger.error('Error generando QR code:', error.message);
    console.log(`${formatTimestamp()} info: QR Code (texto): ${qr}`);
  }
}

module.exports = {
  generateQRCode
};
