const axios = require('axios');

// Configuración del test
const BOT_URL = process.env.BOT_URL || 'http://localhost:4002';
const BOT_TOKEN = process.env.TOKENACCESS || 'your-test-token';

describe('Test - Linked ID Resolution', () => {
  test('should resolve Linked ID 264711786496203@lid to real phone number', async () => {
    console.log('\n=== TEST DE RESOLUCIÓN DE LINKED ID ===');
    console.log(`URL del bot: ${BOT_URL}`);
    console.log(`Linked ID a probar: 264711786496203@lid`);
    console.log('');

    try {
      // Llamar al endpoint de resolución
      const response = await axios.post(`${BOT_URL}/api/resolve-linked-id`, {
        linkedId: '264711786496203@lid'
      }, {
        headers: {
          'Authorization': `Bearer ${BOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      console.log('=== RESULTADO DEL TEST ===');
      console.log(`Status: ${response.status}`);
      console.log(`Success: ${response.data.success}`);
      console.log(`Linked ID original: ${response.data.linkedId}`);
      console.log(`Resuelto: ${response.data.resolved}`);
      console.log(`Número real: ${response.data.realPhone || 'NO RESUELTO'}`);
      console.log(`Timestamp: ${response.data.timestamp}`);
      console.log('');

      if (response.data.success && response.data.realPhone) {
        console.log('✅ ÉXITO: Linked ID resuelto a número real');
        console.log(`   ${response.data.linkedId} → ${response.data.realPhone}`);
        
        // Verificar que el número resultante sea diferente del Linked ID
        const linkedIdNumber = response.data.linkedId.replace('@lid', '');
        if (response.data.realPhone !== linkedIdNumber) {
          console.log('✅ CONFIRMADO: El número resultante es diferente del Linked ID');
        } else {
          console.log('⚠️  ADVERTENCIA: El número resultante es igual al Linked ID');
        }
      } else {
        console.log('❌ FALLO: No se pudo resolver el Linked ID');
        console.log('   Esto puede indicar que:');
        console.log('   - Los métodos de Baileys no están disponibles');
        console.log('   - El Linked ID no se puede resolver a un número real');
        console.log('   - WhatsApp no proporciona esta información');
      }

      // Assertions del test
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('linkedId');
      expect(response.data).toHaveProperty('resolved');
      expect(response.data).toHaveProperty('realPhone');
      expect(response.data).toHaveProperty('timestamp');

    } catch (error) {
      console.log('=== ERROR EN EL TEST ===');
      if (error.response) {
        console.log(`Status: ${error.response.status}`);
        console.log(`Error: ${error.response.data.error || 'Error desconocido'}`);
        console.log(`Message: ${error.response.data.message || 'Sin mensaje'}`);
      } else {
        console.log(`Error: ${error.message}`);
      }
      
      // El test debe fallar si hay error
      throw error;
    }
  });

  test('should reject request without token', async () => {
    try {
      await axios.post(`${BOT_URL}/api/resolve-linked-id`, {
        linkedId: '264711786496203@lid'
      }, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      // Si llega aquí, el test debe fallar
      expect(true).toBe(false);
    } catch (error) {
      expect(error.response.status).toBe(401);
      expect(error.response.data.error).toBe('Token inválido');
    }
  });

  test('should reject request without linkedId', async () => {
    try {
      await axios.post(`${BOT_URL}/api/resolve-linked-id`, {}, {
        headers: {
          'Authorization': `Bearer ${BOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      
      // Si llega aquí, el test debe fallar
      expect(true).toBe(false);
    } catch (error) {
      expect(error.response.status).toBe(400);
      expect(error.response.data.error).toBe('Linked ID requerido');
    }
  });
});

