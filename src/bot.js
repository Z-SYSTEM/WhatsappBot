const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const winston = require('winston');
const { logger, logMessage } = require('./logger');
const { generateQRCode } = require('./qr-handler');
require('dotenv').config();

// Logger personalizado para Baileys con todos los niveles necesarios
const baileysLogger = winston.createLogger({
  level: 'silent', // Silenciar logs de Baileys por defecto
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Agregar métodos faltantes al logger de Baileys
baileysLogger.trace = baileysLogger.debug;
baileysLogger.debug = baileysLogger.debug;
baileysLogger.info = baileysLogger.info;
baileysLogger.warn = baileysLogger.warn;
baileysLogger.error = baileysLogger.error;

const BOT_NAME = process.env.BOT_NAME;
const PORT = process.env.PORT || 4002;
const ONDOWN = process.env.ONDOWN;
const ONMESSAGE = process.env.ONMESSAGE;

// Crear directorio de sesión si no existe
const sessionDir = path.join('sessions', BOT_NAME);
fs.ensureDirSync(sessionDir);

let sock = null;
let isConnected = false;
let messageQueue = [];

// Función para conectar WhatsApp
async function connectToWhatsApp() {
  try {
    logger.info('Iniciando conexión con WhatsApp...');
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    sock = makeWASocket({
      auth: state,
      logger: baileysLogger
    });

    // Manejar eventos de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        logger.info('QR Code generado, escanea con WhatsApp');
        await generateQRCode(qr);
      }
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect) {
          logger.warn('Conexión cerrada, reconectando...');
          setTimeout(connectToWhatsApp, 5000);
        } else {
          logger.error('Conexión cerrada por logout');
          if (ONDOWN) {
            try {
              await axios.post(ONDOWN, {
                bot_name: BOT_NAME,
                status: 'logged_out',
                reason: 'user_logged_out',
                timestamp: new Date().toISOString()
              });
            } catch (error) {
              logger.error('Error enviando webhook ONDOWN:', error.message);
            }
          }
          process.exit(1);
        }
      } else if (connection === 'open') {
        isConnected = true;
        logger.info('Bot conectado exitosamente');
        console.log('✅ Bot conectado exitosamente');
        
        // Procesar cola de mensajes pendientes
        while (messageQueue.length > 0) {
          const msg = messageQueue.shift();
          await sendMessage(msg);
        }
      }
    });

    // Manejar credenciales
    sock.ev.on('creds.update', saveCreds);

    // Manejar mensajes entrantes
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      
      // Filtrar mensajes: solo procesar mensajes de chat individual, no de grupos ni status
      if (!msg.key.fromMe && msg.message && 
          !msg.key.remoteJid.includes('@g.us') && 
          !msg.key.remoteJid.includes('@broadcast')) {
        await handleIncomingMessage(msg);
      } else if (msg.key.remoteJid.includes('@g.us')) {
        logger.debug(`Mensaje de grupo ignorado: ${msg.key.remoteJid}`);
      } else if (msg.key.remoteJid.includes('@broadcast')) {
        logger.debug(`Mensaje de status ignorado: ${msg.key.remoteJid}`);
      }
    });

    // Manejar llamadas
    sock.ev.on('call', async (json) => {
      await handleCall(json);
    });

  } catch (error) {
    logger.error('Error conectando a WhatsApp:', error.message);
    throw error;
  }
}

// Función para manejar mensajes entrantes
async function handleIncomingMessage(msg) {
  try {
    const messageData = {
      phoneNumber: msg.key.remoteJid.replace('@c.us', ''),
      type: 'chat',
      from: msg.key.remoteJid,
      id: msg.key.id,
      timestamp: msg.messageTimestamp,
      body: '',
      hasMedia: false,
      data: {}
    };

    // Extraer texto del mensaje
    if (msg.message.conversation) {
      messageData.body = msg.message.conversation;
      messageData.type = 'chat';
    } else if (msg.message.extendedTextMessage) {
      messageData.body = msg.message.extendedTextMessage.text;
      messageData.type = 'chat';
    } else if (msg.message.imageMessage) {
      messageData.type = 'image';
      messageData.hasMedia = true;
      messageData.body = msg.message.imageMessage.caption || '';
      messageData.data = {
        mimetype: msg.message.imageMessage.mimetype,
        filename: msg.message.imageMessage.fileName || 'image.jpg'
      };
      
      // Descargar imagen
      try {
        const buffer = await sock.downloadMediaMessage(msg);
        messageData.data.data = buffer.toString('base64');
      } catch (error) {
        logger.debug(`No se pudo descargar imagen de ${messageData.phoneNumber}: ${error.message}`);
        // No es un error crítico, continuar sin los datos de la imagen
      }
    } else if (msg.message.videoMessage) {
      messageData.type = 'video';
      messageData.hasMedia = true;
      messageData.body = msg.message.videoMessage.caption || '';
      messageData.data = {
        mimetype: msg.message.videoMessage.mimetype,
        filename: msg.message.videoMessage.fileName || 'video.mp4'
      };
      
      try {
        const buffer = await sock.downloadMediaMessage(msg);
        messageData.data.data = buffer.toString('base64');
      } catch (error) {
        logger.debug(`No se pudo descargar video de ${messageData.phoneNumber}: ${error.message}`);
        // No es un error crítico, continuar sin los datos del video
      }
    } else if (msg.message.audioMessage) {
      messageData.type = 'audio';
      messageData.hasMedia = true;
      messageData.data = {
        mimetype: msg.message.audioMessage.mimetype,
        filename: msg.message.audioMessage.fileName || 'audio.ogg'
      };
      
      try {
        const buffer = await sock.downloadMediaMessage(msg);
        messageData.data.data = buffer.toString('base64');
      } catch (error) {
        logger.debug(`No se pudo descargar audio de ${messageData.phoneNumber}: ${error.message}`);
        // No es un error crítico, continuar sin los datos del audio
      }
    } else if (msg.message.documentMessage) {
      messageData.type = 'document';
      messageData.hasMedia = true;
      messageData.body = msg.message.documentMessage.title || '';
      messageData.data = {
        mimetype: msg.message.documentMessage.mimetype,
        filename: msg.message.documentMessage.fileName || 'document'
      };
      
      try {
        const buffer = await sock.downloadMediaMessage(msg);
        messageData.data.data = buffer.toString('base64');
      } catch (error) {
        logger.debug(`No se pudo descargar documento de ${messageData.phoneNumber}: ${error.message}`);
        // No es un error crítico, continuar sin los datos del documento
      }
    } else if (msg.message.stickerMessage) {
      messageData.type = 'sticker';
      messageData.hasMedia = true;
      messageData.data = {
        mimetype: msg.message.stickerMessage.mimetype,
        filename: 'sticker.webp'
      };
      
      try {
        const buffer = await sock.downloadMediaMessage(msg);
        messageData.data.data = buffer.toString('base64');
      } catch (error) {
        logger.debug(`No se pudo descargar sticker de ${messageData.phoneNumber}: ${error.message}`);
        // No es un error crítico, continuar sin los datos del sticker
      }
    } else if (msg.message.locationMessage) {
      messageData.type = 'location';
      messageData.data = {
        latitude: msg.message.locationMessage.degreesLatitude,
        longitude: msg.message.locationMessage.degreesLongitude,
        description: msg.message.locationMessage.name || ''
      };
    } else if (msg.message.contactMessage) {
      messageData.type = 'contact';
      messageData.data = {
        vcard: msg.message.contactMessage.vcard
      };
    } else {
      // Mensaje de tipo no soportado
      logMessage.ignored(messageData, 'tipo_no_soportado');
      logger.warn(`Mensaje de tipo no soportado recibido de ${messageData.phoneNumber}`);
      return; // No procesar mensajes no soportados
    }

    // Log del mensaje recibido
    logMessage.received(messageData);

    // Enviar webhook si está configurado
    if (ONMESSAGE) {
      try {
        await axios.post(ONMESSAGE, messageData);
        logger.info(`Mensaje enviado a webhook: ${messageData.type} de ${messageData.phoneNumber}`);
      } catch (error) {
        logger.error('Error enviando webhook ONMESSAGE:', error.message);
      }
    }

    // También enviar al endpoint interno
    try {
      await axios.post(`http://localhost:${PORT}/internal/message`, messageData);
    } catch (error) {
      logger.error('Error enviando mensaje al endpoint interno:', error.message);
    }

  } catch (error) {
    logger.error('Error procesando mensaje entrante:', error.message);
  }
}

// Función para manejar llamadas
async function handleCall(json) {
  try {
    const callData = {
      phoneNumber: json[0].id.replace('@c.us', ''),
      type: 'call',
      from: json[0].id,
      id: `call_${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000),
      body: 'Llamada entrante',
      hasMedia: false,
      data: {
        status: json[0].status,
        duration: json[0].duration || 0
      }
    };

    if (ONMESSAGE) {
      try {
        await axios.post(ONMESSAGE, callData);
        logger.info(`Llamada enviada a webhook: ${callData.data.status} de ${callData.phoneNumber}`);
      } catch (error) {
        logger.error('Error enviando webhook de llamada:', error.message);
      }
    }

    // También enviar al endpoint interno
    try {
      await axios.post(`http://localhost:${PORT}/internal/message`, callData);
    } catch (error) {
      logger.error('Error enviando llamada al endpoint interno:', error.message);
    }

  } catch (error) {
    logger.error('Error procesando llamada:', error.message);
  }
}

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

// Función para enviar mensajes
async function sendMessage({ phone, message, type = 'text', media }) {
  try {
    if (!isConnected) {
      logger.warn('Bot no conectado, agregando mensaje a cola');
      messageQueue.push({ phone, message, type, media });
      return { success: false, error: 'Bot no conectado' };
    }

    const jid = phone.includes('@c.us') ? phone : `${phone}@c.us`;

    let sentMessage;

    switch (type) {
      case 'text':
        sentMessage = await sock.sendMessage(jid, { text: message });
        break;
      
      case 'image':
        if (media && media.url) {
          // Descargar imagen desde URL
          const buffer = await downloadFromUrl(media.url, media.mimetype);
          sentMessage = await sock.sendMessage(jid, {
            image: buffer,
            caption: message,
            mimetype: media.mimetype || 'image/jpeg'
          });
        } else if (media && media.data) {
          // Usar datos base64 existentes
          const buffer = Buffer.from(media.data, 'base64');
          sentMessage = await sock.sendMessage(jid, {
            image: buffer,
            caption: message,
            mimetype: media.mimetype || 'image/jpeg'
          });
        } else {
          throw new Error('URL o datos de imagen requeridos');
        }
        break;
      
      case 'video':
        if (media && media.url) {
          // Descargar video desde URL
          const buffer = await downloadFromUrl(media.url, media.mimetype);
          sentMessage = await sock.sendMessage(jid, {
            video: buffer,
            caption: message,
            mimetype: media.mimetype || 'video/mp4'
          });
        } else if (media && media.data) {
          // Usar datos base64 existentes
          const buffer = Buffer.from(media.data, 'base64');
          sentMessage = await sock.sendMessage(jid, {
            video: buffer,
            caption: message,
            mimetype: media.mimetype || 'video/mp4'
          });
        } else {
          throw new Error('URL o datos de video requeridos');
        }
        break;
      
      case 'audio':
        if (media && media.url) {
          // Descargar audio desde URL
          const buffer = await downloadFromUrl(media.url, media.mimetype);
          sentMessage = await sock.sendMessage(jid, {
            audio: buffer,
            mimetype: media.mimetype || 'audio/ogg',
            ptt: false
          });
        } else if (media && media.data) {
          // Usar datos base64 existentes
          const buffer = Buffer.from(media.data, 'base64');
          sentMessage = await sock.sendMessage(jid, {
            audio: buffer,
            mimetype: media.mimetype || 'audio/ogg',
            ptt: false
          });
        } else {
          throw new Error('URL o datos de audio requeridos');
        }
        break;
      
      case 'document':
        if (media && media.url) {
          // Descargar documento desde URL
          const buffer = await downloadFromUrl(media.url, media.mimetype);
          sentMessage = await sock.sendMessage(jid, {
            document: buffer,
            mimetype: media.mimetype || 'application/octet-stream',
            fileName: media.filename || 'document'
          });
        } else if (media && media.data) {
          // Usar datos base64 existentes
          const buffer = Buffer.from(media.data, 'base64');
          sentMessage = await sock.sendMessage(jid, {
            document: buffer,
            mimetype: media.mimetype || 'application/octet-stream',
            fileName: media.filename || 'document'
          });
        } else {
          throw new Error('URL o datos de documento requeridos');
        }
        break;
      
      case 'location':
        if (media && media.latitude && media.longitude) {
          sentMessage = await sock.sendMessage(jid, {
            location: {
              degreesLatitude: media.latitude,
              degreesLongitude: media.longitude,
              name: media.description || ''
            }
          });
        } else {
          throw new Error('Coordenadas de ubicación requeridas');
        }
        break;
      
      case 'contact':
        if (media && media.contact) {
          // Enviar contacto usando objeto contact
          sentMessage = await sock.sendMessage(jid, {
            contacts: {
              displayName: media.contact.name,
              contacts: [{
                name: media.contact.name,
                number: media.contact.number
              }]
            }
          });
        } else if (media && media.vcard) {
          // Enviar contacto usando vCard
          sentMessage = await sock.sendMessage(jid, {
            contacts: {
              displayName: 'Contact',
              contacts: [{
                vcard: media.vcard
              }]
            }
          });
        } else {
          throw new Error('Datos de contacto requeridos');
        }
        break;
      
      default:
        throw new Error(`Tipo de mensaje no soportado: ${type}`);
    }

    logger.info(`Mensaje enviado exitosamente a ${phone}: ${type}`);
    logMessage.sent({ phoneNumber: phone, type: type });
    return { success: true, messageId: sentMessage.key.id };

  } catch (error) {
    logger.error(`Error enviando mensaje a ${phone}:`, error.message);
    logMessage.failed({ phoneNumber: phone, type: type }, error);
    return { success: false, error: error.message };
  }
}

// Servidor HTTP interno para recibir mensajes del index.js
const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));

// Endpoint para recibir mensajes del index.js
app.post('/internal/send', async (req, res) => {
  try {
    const result = await sendMessage(req.body);
    if (result.success) {
      res.json({ success: true, messageId: result.messageId });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    logger.error('Error en endpoint interno:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para obtener información de contactos
app.post('/internal/contact', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'phoneNumber is required' });
    }
    
    if (!isConnected) {
      return res.status(503).json({ success: false, error: 'Bot no conectado' });
    }
    
    const wid = phoneNumber.endsWith('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
    
    try {
      // Obtener información del contacto usando las funciones correctas de Baileys
      logger.debug(`Attempting to get contact info for: ${wid}`);
      
      // Intentar obtener el contacto del store
      let contactData = null;
      
      if (sock.contacts && sock.contacts[wid]) {
        contactData = sock.contacts[wid];
        logger.debug(`Contact found in store`);
      } else {
        // Si no existe en el store, crear uno básico
        contactData = {
          id: wid,
          name: 'Unknown',
          pushName: null,
          verifiedName: null,
          status: null
        };
        logger.debug(`Contact not in store, using default data`);
      }
      
      logger.debug(`Contact data from Baileys:`, JSON.stringify(contactData, null, 2));
      
      // Intentar obtener foto de perfil
      let profilePicUrl = null;
      try {
        profilePicUrl = await sock.profilePictureUrl(wid, 'image');
        logger.debug(`Profile picture URL obtained: ${profilePicUrl}`);
      } catch (e) {
        // Es normal que algunos contactos no tengan foto
        logger.debug(`No profile picture available for ${wid}: ${e.message}`);
        profilePicUrl = null;
      }
      
      // Verificar si el contacto existe y tiene información válida
      if (!contact || contact.length === 0) {
        logger.warn(`Contact not found: ${wid}`);
        return res.status(404).json({ success: false, error: 'Contacto no encontrado' });
      }
      
      const contactName = contactData?.name || contactData?.pushName || 'Unknown';
      logger.debug(`Resolved contact name: ${contactName}`);
      
      // Si el nombre es 'Unknown' y no hay pushName, intentar obtener más información
      if (contactName === 'Unknown' && !contactData?.pushName) {
        logger.debug(`Contact ${wid} has no name information, but exists in WhatsApp`);
      }
      
      const contactInfo = {
        id: wid,
        name: contactName,
        number: wid.replace('@c.us', ''),
        isBusiness: contactData?.verifiedName ? true : false,
        profilePicUrl,
        status: contactData?.status || '',
        verified: contactData?.verifiedName ? true : false,
        verifiedName: contactData?.verifiedName || null
      };
      
      logger.info(`Contact info retrieved for ${wid}: ${contactInfo.name}`);
      res.json({ success: true, contact: contactInfo });
      
    } catch (err) {
      logger.error(`Error fetching contact info for ${wid}: ${err.message}`);
      
      // Manejar errores específicos de Baileys
      if (err.message.includes('not-authorized')) {
        return res.status(403).json({ success: false, error: 'No autorizado para acceder a este contacto' });
      }
      
      if (err.message.includes('not-found')) {
        return res.status(404).json({ success: false, error: 'Contacto no encontrado' });
      }
      
      res.status(500).json({ success: false, error: 'Error interno al obtener información del contacto' });
    }
    
  } catch (error) {
    logger.error('Error en endpoint interno de contacto:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Iniciar servidor interno en puerto diferente
const internalPort = PORT + 1;
app.listen(internalPort, () => {
  logger.info(`Servidor interno iniciado en puerto ${internalPort}`);
});

// Conectar a WhatsApp
connectToWhatsApp().catch(error => {
  logger.error('Error fatal conectando a WhatsApp:', error.message);
  process.exit(1);
});

// Manejo de señales
process.on('SIGINT', () => {
  logger.info('Cerrando bot...');
  if (sock) {
    sock.end();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Cerrando bot...');
  if (sock) {
    sock.end();
  }
  process.exit(0);
});
