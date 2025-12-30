import { logger } from './logger.js';

class Validators {
  // Validar número de teléfono
  static validatePhoneNumber(phoneNumber) {
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return { valid: false, error: 'phoneNumber must be a non-empty string' };
    }

    // Remover espacios y caracteres especiales
    const cleanPhone = phoneNumber.replace(/[\s\-\(\)\.]/g, '');
    
    // Validar formato internacional
    if (!/^\+?[1-9]\d{1,14}$/.test(cleanPhone)) {
      return { valid: false, error: 'Invalid phone number format. Must be international format (e.g., +1234567890)' };
    }

    // Validar longitud mínima y máxima
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      return { valid: false, error: 'Phone number must be between 10 and 15 digits' };
    }

    return { valid: true, cleanPhone };
  }

  // Validar ID de grupo de WhatsApp
  static validateGroupId(groupId) {
    if (!groupId || typeof groupId !== 'string') {
      return { valid: false, error: 'Group ID requerido' };
    }

    // Limpiar el groupId
    let cleanGroupId = groupId.trim();

    // Si no termina en @g.us, agregarlo
    if (!cleanGroupId.endsWith('@g.us')) {
      cleanGroupId = `${cleanGroupId}@g.us`;
    }

    // Validar formato básico de grupo (acepta tanto grupos normales como de Business)
    // Grupos normales: 5491160553338-1616012738@g.us (con guión)
    // Grupos Business: 120363363116366813@g.us (sin guión)
    // Grupos con +: +120363322119703037@g.us
    if (!/^\+?[\d-]+@g\.us$/.test(cleanGroupId)) {
      return { valid: false, error: 'Formato de Group ID inválido. Debe ser algo como: 5491160553338-1616012738@g.us, 120363363116366813@g.us o +120363322119703037@g.us' };
    }

    return { valid: true, cleanGroupId };
  }

  // Validar URL
  static validateUrl(url, allowedProtocols = ['http:', 'https:']) {
    if (!url || typeof url !== 'string') {
      return { valid: false, error: 'URL must be a non-empty string' };
    }

    try {
      const urlObj = new URL(url);
      
      // Validar protocolo
      if (!allowedProtocols.includes(urlObj.protocol)) {
        return { valid: false, error: `URL protocol must be one of: ${allowedProtocols.join(', ')}` };
      }

      // Validar hostname
      if (!urlObj.hostname || urlObj.hostname.length === 0) {
        return { valid: false, error: 'URL must have a valid hostname' };
      }

      // Validar que no sea localhost o IP privada
      if (urlObj.hostname === 'localhost' || 
          urlObj.hostname === '127.0.0.1' || 
          urlObj.hostname.startsWith('192.168.') ||
          urlObj.hostname.startsWith('10.') ||
          urlObj.hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
        return { valid: false, error: 'URL cannot be localhost or private IP address' };
      }

      return { valid: true, urlObj };
    } catch (error) {
      return { valid: false, error: 'Invalid URL format' };
    }
  }

  // Validar array de URLs
  static validateUrlArray(urls, maxUrls = 10) {
    if (!Array.isArray(urls)) {
      return { valid: false, error: 'URLs must be an array' };
    }

    if (urls.length === 0) {
      return { valid: false, error: 'URLs array cannot be empty' };
    }

    if (urls.length > maxUrls) {
      return { valid: false, error: `Maximum ${maxUrls} URLs allowed` };
    }

    const validatedUrls = [];
    for (let i = 0; i < urls.length; i++) {
      const urlValidation = this.validateUrl(urls[i]);
      if (!urlValidation.valid) {
        return { valid: false, error: `URL at index ${i}: ${urlValidation.error}` };
      }
      validatedUrls.push(urlValidation.urlObj.href);
    }

    return { valid: true, urls: validatedUrls };
  }

  // Validar mensaje de texto
  static validateMessage(message, maxLength = 4096) {
    if (message === undefined || message === null) {
      return { valid: true, message: '' }; // Mensaje vacío es válido
    }

    if (typeof message !== 'string') {
      return { valid: false, error: 'Message must be a string' };
    }

    if (message.length > maxLength) {
      return { valid: false, error: `Message too long. Maximum ${maxLength} characters allowed` };
    }

    // Sanitizar mensaje (remover caracteres peligrosos)
    const sanitizedMessage = message
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remover caracteres de control
      .trim();

    return { valid: true, message: sanitizedMessage };
  }

  // Validar tipo de archivo por extensión
  static validateFileType(filename, allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx', '.mp4', '.avi', '.mov', '.mp3', '.wav', '.ogg']) {
    if (!filename || typeof filename !== 'string') {
      return { valid: false, error: 'Filename must be a non-empty string' };
    }

    const extension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    
    if (!allowedExtensions.includes(extension)) {
      return { valid: false, error: `File type not allowed. Allowed types: ${allowedExtensions.join(', ')}` };
    }

    return { valid: true, extension };
  }

  // Validar MIME type
  static validateMimeType(mimeType, allowedTypes = ['image/', 'video/', 'audio/', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    if (!mimeType || typeof mimeType !== 'string') {
      return { valid: false, error: 'MIME type must be a non-empty string' };
    }

    const isValid = allowedTypes.some(type => mimeType.startsWith(type));
    
    if (!isValid) {
      return { valid: false, error: `MIME type not allowed. Allowed types: ${allowedTypes.join(', ')}` };
    }

    return { valid: true, mimeType };
  }

  // Validar tamaño de archivo (en bytes)
  static validateFileSize(sizeInBytes, maxSizeInMB = 16) {
    const maxSizeInBytes = maxSizeInMB * 1024 * 1024;
    
    if (typeof sizeInBytes !== 'number' || sizeInBytes <= 0) {
      return { valid: false, error: 'File size must be a positive number' };
    }

    if (sizeInBytes > maxSizeInBytes) {
      return { valid: false, error: `File too large. Maximum ${maxSizeInMB}MB allowed` };
    }

    return { valid: true, sizeInBytes };
  }

  // Validar coordenadas de ubicación
  static validateLocation(latitude, longitude) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return { valid: false, error: 'Latitude and longitude must be numbers' };
    }

    if (latitude < -90 || latitude > 90) {
      return { valid: false, error: 'Latitude must be between -90 and 90' };
    }

    if (longitude < -180 || longitude > 180) {
      return { valid: false, error: 'Longitude must be between -180 and 180' };
    }

    return { valid: true, latitude, longitude };
  }

  // Validar vCard
  static validateVCard(vcard) {
    if (!vcard || typeof vcard !== 'string') {
      return { valid: false, error: 'vCard must be a string' };
    }
    
    if (!vcard.includes('BEGIN:VCARD') || !vcard.includes('END:VCARD')) {
      return { valid: false, error: 'Invalid vCard format' };
    }
    
    if (vcard.length > 10000) {
      return { valid: false, error: 'vCard too large (max 10KB)' };
    }
    
    return { valid: true, vcard: vcard.trim() };
  }

  // Validar contacto
  static validateContact(contact) {
    if (!contact || typeof contact !== 'object') {
      return { valid: false, error: 'Contact must be an object' };
    }
    
    const errors = [];
    
    if (!contact.name || typeof contact.name !== 'string' || contact.name.trim().length === 0) {
      errors.push('Contact name is required and must be a non-empty string');
    }
    
    if (!contact.number || typeof contact.number !== 'string') {
      errors.push('Contact number is required and must be a string');
    } else {
      const phoneValidation = this.validatePhoneNumber(contact.number);
      if (!phoneValidation.valid) {
        errors.push(`Contact number: ${phoneValidation.error}`);
      }
    }
    
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    
    return {
      valid: true,
      contact: {
        name: contact.name.trim(),
        number: contact.number.replace(/[^\d]/g, '')
      }
    };
  }

  // Validar payload para envío de contactos
  static validateSendContactPayload(payload) {
    const errors = [];
    const sanitizedPayload = this.sanitizeInput(payload);

    // Validar phoneNumber
    const phoneValidation = this.validatePhoneNumber(sanitizedPayload.phoneNumber);
    if (!phoneValidation.valid) {
      errors.push(phoneValidation.error);
    }

    // Validar contact
    if (sanitizedPayload.contact) {
      const contactValidation = this.validateContact(sanitizedPayload.contact);
      if (!contactValidation.valid) {
        errors.push(`contact: ${contactValidation.errors ? contactValidation.errors.join(', ') : contactValidation.error}`);
      }
    } else if (sanitizedPayload.vcard) {
      const vcardValidation = this.validateVCard(sanitizedPayload.vcard);
      if (!vcardValidation.valid) {
        errors.push(`vcard: ${vcardValidation.error}`);
      }
    } else {
      errors.push('Either contact object or vcard string is required');
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      payload: {
        ...sanitizedPayload,
        phoneNumber: phoneValidation.cleanPhone,
        contact: sanitizedPayload.contact ? contactValidation.contact : undefined,
        vcard: sanitizedPayload.vcard ? vcardValidation.vcard : undefined
      }
    };
  }

  // Validar payload para obtener información de contacto
  static validateGetContactPayload(payload) {
    const errors = [];
    const sanitizedPayload = this.sanitizeInput(payload);

    if (!sanitizedPayload.phoneNumber || typeof sanitizedPayload.phoneNumber !== 'string') {
      return { valid: false, errors: ['phoneNumber must be a non-empty string'] };
    }

    const input = sanitizedPayload.phoneNumber.trim();

    // Verificar si es un LID (Linked ID)
    if (input.endsWith('@lid')) {
      // Validar formato LID: debe ser solo dígitos antes de @lid
      const lidPattern = /^\d+@lid$/;
      if (!lidPattern.test(input)) {
        errors.push('Invalid LID format. Must be digits followed by @lid (e.g., 30949668610142@lid)');
      }

      if (errors.length > 0) {
        return { valid: false, errors };
      }

      return {
        valid: true,
        payload: {
          ...sanitizedPayload,
          phoneNumber: input
        }
      };
    }

    // Si no es LID, validar como número de teléfono
    const phoneValidation = this.validatePhoneNumber(input);
    if (!phoneValidation.valid) {
      errors.push(phoneValidation.error);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      payload: {
        ...sanitizedPayload,
        phoneNumber: phoneValidation.cleanPhone
      }
    };
  }

  // Validar payload para obtener información de grupo
  static validateGetGroupPayload(payload) {
    const errors = [];
    const sanitizedPayload = this.sanitizeInput(payload);

    // Validar groupId
    const groupValidation = this.validateGroupId(sanitizedPayload.groupId);
    if (!groupValidation.valid) {
      errors.push(groupValidation.error);
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      payload: {
        ...sanitizedPayload,
        groupId: groupValidation.cleanGroupId
      }
    };
  }

  // Sanitizar datos de entrada
  static sanitizeInput(data) {
    if (typeof data === 'string') {
      return data
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remover caracteres de control
        .trim();
    }
    
    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeInput(item));
    }
    
    if (typeof data === 'object' && data !== null) {
      const sanitized = {};
      for (const [key, value] of Object.entries(data)) {
        sanitized[key] = this.sanitizeInput(value);
      }
      return sanitized;
    }
    
    return data;
  }

  // Validar payload completo para envío de mensajes
  static validateSendMessagePayload(payload) {
    const errors = [];
    const sanitizedPayload = this.sanitizeInput(payload);
    let contactValidation = null;
    let vcardValidation = null;

    // Validar phoneNumber (puede ser número de teléfono o ID de grupo)
    let phoneValidation;
    if (sanitizedPayload.phoneNumber && sanitizedPayload.phoneNumber.includes('@g.us')) {
      // Es un ID de grupo, validar como grupo
      phoneValidation = this.validateGroupId(sanitizedPayload.phoneNumber);
      if (!phoneValidation.valid) {
        errors.push(phoneValidation.error);
      }
    } else {
      // Es un número de teléfono, validar como teléfono
      phoneValidation = this.validatePhoneNumber(sanitizedPayload.phoneNumber);
      if (!phoneValidation.valid) {
        errors.push(phoneValidation.error);
      }
    }

    // Validar message (opcional para contactos)
    if (sanitizedPayload.message !== undefined) {
      const messageValidation = this.validateMessage(sanitizedPayload.message);
      if (!messageValidation.valid) {
        errors.push(messageValidation.error);
      }
    }

    // Validar imageUrl
    if (sanitizedPayload.imageUrl) {
      const urlValidation = this.validateUrl(sanitizedPayload.imageUrl);
      if (!urlValidation.valid) {
        errors.push(`imageUrl: ${urlValidation.error}`);
      }
    }

    // Validar imageUrls
    if (sanitizedPayload.imageUrls !== undefined) {
      const urlsValidation = this.validateUrlArray(sanitizedPayload.imageUrls);
      if (!urlsValidation.valid) {
        errors.push(`imageUrls: ${urlsValidation.error}`);
      }
    }

    // Validar pdfUrl
    if (sanitizedPayload.pdfUrl) {
      const urlValidation = this.validateUrl(sanitizedPayload.pdfUrl);
      if (!urlValidation.valid) {
        errors.push(`pdfUrl: ${urlValidation.error}`);
      }
    }

    // Validar contact
    if (sanitizedPayload.contact) {
      contactValidation = this.validateContact(sanitizedPayload.contact);
      if (!contactValidation.valid) {
        errors.push(`contact: ${contactValidation.errors ? contactValidation.errors.join(', ') : contactValidation.error}`);
      }
    }

    // Validar vcard
    if (sanitizedPayload.vcard) {
      vcardValidation = this.validateVCard(sanitizedPayload.vcard);
      if (!vcardValidation.valid) {
        errors.push(`vcard: ${vcardValidation.error}`);
      }
    }

    // Verificar que al menos hay un contenido para enviar
    const hasContent = (sanitizedPayload.message !== undefined && sanitizedPayload.message !== '') ||
                      sanitizedPayload.imageUrl ||
                      (sanitizedPayload.imageUrls && sanitizedPayload.imageUrls.length > 0) ||
                      sanitizedPayload.pdfUrl ||
                      sanitizedPayload.contact ||
                      sanitizedPayload.vcard;

    if (!hasContent) {
      errors.push('At least one of: message, imageUrl, imageUrls, pdfUrl, contact, or vcard is required');
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return {
      valid: true,
      payload: {
        ...sanitizedPayload,
        phoneNumber: phoneValidation.cleanPhone || phoneValidation.cleanGroupId || sanitizedPayload.phoneNumber,
        message: sanitizedPayload.message !== undefined ? (sanitizedPayload.message || '') : '',
        contact: sanitizedPayload.contact && contactValidation ? contactValidation.contact : undefined,
        vcard: sanitizedPayload.vcard && vcardValidation ? vcardValidation.vcard : undefined
      }
    };
  }
}

export default Validators;
