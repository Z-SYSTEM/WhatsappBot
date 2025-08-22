# Tests del WhatsApp Bot

## Descripción
Tests de integración que verifican que todos los endpoints del BOT responden correctamente.

## Prerequisitos
1. **El BOT debe estar corriendo** antes de ejecutar los tests
2. Las variables de entorno deben estar configuradas en `.env`

## Variables de Entorno Requeridas
```bash
TOKENACCESS=tu-token-de-acceso
BOT_NAME=nombre-del-bot
PORT=4002
```

## Cómo Ejecutar

### 1. Iniciar el BOT
```bash
npm run dev
```

### 2. En otra terminal, ejecutar los tests

#### Ejecutar todos los tests
```bash
npm test
```

#### Ejecutar test específico "Test" (solo /api/test)
```bash
npm run test:Test
```

#### Ejecutar otros tests específicos por nombre
```bash
npm run test:specific "nombre-del-test"
```

#### Otros comandos útiles
```bash
# Ejecutar tests en modo watch
npm run test:watch

# Ejecutar tests con coverage
npm run test:coverage
```

## Tests Disponibles

### "Test" - `/api/test` Health Check
- ✅ Responde con status OK cuando se proporciona token válido
- ✅ Rechaza requests sin token (401)
- ✅ Rechaza requests con token inválido (401)

**Comando:** `npm run test:Test`

## Próximos Tests a Implementar
- [ ] "Send" - `/api/send` - Envío de mensajes
- [ ] "Contact" - `/api/contact` - Información de contactos  
- [ ] "Group" - `/api/group` - Información de grupos
- [ ] "HealthInfo" - `/api/health-info` - Información de salud
- [ ] "RateLimit" - `/api/rate-limit-stats` - Estadísticas de rate limiting

## Troubleshooting

### Error: "Bot not running"
- Asegúrate de que el bot esté corriendo en `http://localhost:4002`
- Verifica que el puerto en `.env` coincida con el usado en los tests
- Inicia el bot con: `npm run dev`

### Error: "Token inválido"
- Verifica que `TOKENACCESS` esté configurado en `.env`
- Asegúrate de que el token sea el mismo en el bot y en los tests

### Tests lentos
- Los tests tienen timeout de 30 segundos para conexiones
- Si el bot tarda en responder, es normal que los tests tomen tiempo
