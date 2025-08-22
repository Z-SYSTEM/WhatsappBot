const axios = require('axios');

// Configuración del test
const BOT_URL = process.env.BOT_URL || 'http://localhost:4002';
const BOT_TOKEN = process.env.TOKENACCESS || 'your-test-token';

describe('Test - /api/test endpoint', () => {
  test('should respond with bot status when valid token provided', async () => {
    try {
      const response = await axios.get(`${BOT_URL}/api/test`, {
        headers: {
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 10000
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', 'ok');
      expect(response.data).toHaveProperty('bot_name');
      expect(response.data).toHaveProperty('is_ready');
      expect(response.data).toHaveProperty('timestamp');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      throw error;
    }
  });

  test('should reject request without token', async () => {
    try {
      await axios.get(`${BOT_URL}/api/test`, {
        timeout: 5000
      });
      // Si llegamos aquí, el test falló
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });

  test('should reject request with invalid token', async () => {
    try {
      await axios.get(`${BOT_URL}/api/test`, {
        headers: {
          'Authorization': 'Bearer invalid-token'
        },
        timeout: 5000
      });
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });
});

describe('Contact - /api/contact endpoint', () => {
  test('should return contact information for valid phone number', async () => {
    try {
      const response = await axios.get(`${BOT_URL}/api/contact`, {
        params: {
          phoneNumber: '5491141413338'
        },
        headers: {
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 10000
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('res', true);
      expect(response.data).toHaveProperty('contact');
      expect(response.data.contact).toHaveProperty('id');
      expect(response.data.contact).toHaveProperty('name');
      expect(response.data.contact).toHaveProperty('number');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      throw error;
    }
  });

  test('should reject request without token', async () => {
    try {
      await axios.get(`${BOT_URL}/api/contact`, {
        params: {
          phoneNumber: '5491141413338'
        },
        timeout: 5000
      });
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });

  test('should reject request without phone number', async () => {
    try {
      await axios.get(`${BOT_URL}/api/contact`, {
        headers: {
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 5000
      });
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(400);
      expect(error.response.data).toHaveProperty('res', false);
      expect(error.response.data).toHaveProperty('error', 'Validation failed');
    }
  });
});

describe('Group - /api/group endpoint', () => {
  test('should return group information for valid group ID', async () => {
    try {
      const response = await axios.get(`${BOT_URL}/api/group`, {
        params: {
          groupId: '120363321947067806'
        },
        headers: {
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 10000
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('res', true);
      expect(response.data).toHaveProperty('group');
      expect(response.data.group).toHaveProperty('id');
      expect(response.data.group).toHaveProperty('name');
      expect(response.data.group).toHaveProperty('participantsCount');
      expect(response.data.group).toHaveProperty('participants');
      expect(response.data.group).toHaveProperty('admins');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      throw error;
    }
  });

  test('should reject request without token', async () => {
    try {
      await axios.get(`${BOT_URL}/api/group`, {
        params: {
          groupId: '120363321947067806'
        },
        timeout: 5000
      });
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });

  test('should reject request without group ID', async () => {
    try {
      await axios.get(`${BOT_URL}/api/group`, {
        headers: {
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 5000
      });
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(400);
      expect(error.response.data).toHaveProperty('res', false);
      expect(error.response.data).toHaveProperty('error', 'Validation failed');
    }
  });
});

describe('Send - /api/send endpoint', () => {
  test('should send text message successfully', async () => {
    try {
      const response = await axios.post(`${BOT_URL}/api/send`, {
        message: "Boot - Test TEXT message",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 15000
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', true);
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      throw error;
    }
  });

  test('should reject request without token', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        message: "Boot - Test TEXT message",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });

  test('should reject request with invalid token', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        message: "Boot - Test TEXT message",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid-token'
        },
        timeout: 5000
      });
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });

  test('should reject request without phone number', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        message: "Boot - Test TEXT message"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 5000
      });
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(400);
      expect(error.response.data).toHaveProperty('res', false);
      expect(error.response.data).toHaveProperty('error', 'Validation failed');
    }
  });

  test('should reject request without message content', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 5000
      });
      fail('Expected request to be rejected');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      expect(error.response.status).toBe(400);
      expect(error.response.data).toHaveProperty('res', false);
      expect(error.response.data).toHaveProperty('error', 'Validation failed');
    }
  });

  test('should send message to group successfully', async () => {
    try {
      console.log('🚀 Enviando mensaje al grupo: 5491160553338-1616012738@g.us');
      const response = await axios.post(`${BOT_URL}/api/send`, {
        message: "mensaje de prueba a grupo",
        phoneNumber: "5491160553338-1616012738@g.us"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 15000
      });
      
      console.log('✅ Respuesta recibida:', response.status, response.data);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', true);
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      console.log('❌ Error en envío al grupo:', error.response?.status, error.response?.data);
      throw error;
    }
  });

  test('should send image message successfully', async () => {
    try {
      const response = await axios.post(`${BOT_URL}/api/send`, {
        message: "Boot - Test IMAGE message",
        imageUrl: "https://picsum.photos/800/600?random=1",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 15000
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', true);
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      throw error;
    }
  });

  test('should reject image request without token', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        message: "Test image",
        imageUrl: "https://picsum.photos/800/600?random=1",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      throw new Error('Should have thrown an error');
    } catch (error) {
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });

  test('should reject image request with invalid imageUrl', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        message: "Test image",
        imageUrl: "invalid-url",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        }
      });
      
      throw new Error('Should have thrown an error');
    } catch (error) {
      expect(error.response.status).toBe(400);
      expect(error.response.data).toHaveProperty('res', false);
      expect(error.response.data).toHaveProperty('error', 'Validation failed');
    }
  });

  test('should send multiple images successfully', async () => {
    try {
      const response = await axios.post(`${BOT_URL}/api/send`, {
        imageUrls: [
          "https://picsum.photos/800/600?random=1",
          "https://picsum.photos/800/600?random=2"
        ],
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 20000  // Mayor timeout para múltiples imágenes
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', true);
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      throw error;
    }
  });

  test('should reject multiple images request without token', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        imageUrls: [
          "https://picsum.photos/800/600?random=1",
          "https://picsum.photos/800/600?random=2"
        ],
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      throw new Error('Should have thrown an error');
    } catch (error) {
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });

  test('should reject multiple images with invalid URLs', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        imageUrls: [
          "invalid-url-1",
          "invalid-url-2"
        ],
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        }
      });
      
      throw new Error('Should have thrown an error');
    } catch (error) {
      expect(error.response.status).toBe(400);
      expect(error.response.data).toHaveProperty('res', false);
      expect(error.response.data).toHaveProperty('error', 'Validation failed');
    }
  });

  test('should reject empty imageUrls array', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        imageUrls: [],
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        }
      });
      
      throw new Error('Should have thrown an error');
    } catch (error) {
      expect(error.response.status).toBe(400);
      expect(error.response.data).toHaveProperty('res', false);
      expect(error.response.data).toHaveProperty('error', 'Validation failed');
    }
  });

  test('should send PDF document successfully', async () => {
    try {
      const response = await axios.post(`${BOT_URL}/api/send`, {
        message: "Boot - Test PDF message",
        pdfUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 15000
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', true);
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      throw error;
    }
  });

  test('should reject PDF document request without token', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        message: "Test PDF",
        pdfUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      throw new Error('Should have thrown an error');
    } catch (error) {
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });

  test('should reject PDF document with invalid URL', async () => {
    try {
      await axios.post(`${BOT_URL}/api/send`, {
        message: "Test PDF",
        pdfUrl: "invalid-pdf-url",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        }
      });
      
      throw new Error('Should have thrown an error');
    } catch (error) {
      expect(error.response.status).toBe(400);
      expect(error.response.data).toHaveProperty('res', false);
      expect(error.response.data).toHaveProperty('error', 'Validation failed');
    }
  });

  test('should send PDF document without message successfully', async () => {
    try {
      const response = await axios.post(`${BOT_URL}/api/send`, {
        pdfUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        phoneNumber: "+5491141413338"
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_TOKEN}`
        },
        timeout: 15000
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status', true);
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      throw error;
    }
  });
});

describe('Rate Limit - /api/rate-limit-stats endpoint', () => {
  test('should return rate limit stats with NO blocked IPs', async () => {
    try {
      const response = await axios.get(`${BOT_URL}/api/rate-limit-stats`, {
        headers: {
          'Authorization': `Bearer ${BOT_TOKEN}`
        }
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('rate_limit_stats');
      expect(response.data).toHaveProperty('timestamp');
      
      console.log('📊 Rate Limit Stats:', JSON.stringify(response.data.rate_limit_stats, null, 2));
      
      expect(response.data.rate_limit_stats).toHaveProperty('activeRequests');
      expect(response.data.rate_limit_stats).toHaveProperty('blockedIPs');
      expect(response.data.rate_limit_stats).toHaveProperty('windowMs');
      expect(response.data.rate_limit_stats).toHaveProperty('maxRequests');
      
      // VERIFICAR: NO se bloquean IPs (siempre 0)
      expect(response.data.rate_limit_stats.blockedIPs).toBe(0);
      
      // Verificar configuración de rate limiting
      expect(response.data.rate_limit_stats.windowMs).toBe(60000); // 1 minuto
      expect(response.data.rate_limit_stats.maxRequests).toBe(300); // 300 requests por minuto
      
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Bot not running on ${BOT_URL}. Please start the bot first with: npm run dev`);
      }
      throw error;
    }
  });

  test('should reject request without token', async () => {
    try {
      await axios.get(`${BOT_URL}/api/rate-limit-stats`);
      throw new Error('Should have thrown an error');
    } catch (error) {
      expect(error.response.status).toBe(401);
      expect(error.response.data).toHaveProperty('error', 'Token inválido');
    }
  });
});
