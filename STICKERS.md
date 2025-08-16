# Soporte para Stickers en WhatsApp Bot

## Descripción

El bot ahora incluye soporte completo para stickers de WhatsApp, tanto para recibir como para enviar.

## Funcionalidades

### Recibir Stickers

Los stickers recibidos incluyen la siguiente información:

- **Tipo de mensaje**: `sticker`
- **Datos del sticker**:
  - `mimetype`: Tipo MIME (ej: `image/webp`)
  - `filename`: Nombre del archivo (ej: `sticker.webp`)
  - `stickerId`: ID único del sticker
  - `packId`: ID del paquete de stickers
  - `packName`: Nombre del paquete
  - `packPublisher`: Editor del paquete
  - `isAnimated`: Si el sticker es animado
  - `data`: Datos del sticker en base64 (si se descargó correctamente)

### Enviar Stickers

Puedes enviar stickers usando el endpoint `/api/send` con el parámetro `stickerUrl`.

## Ejemplos de Uso

### Enviar un Sticker

```bash
curl -X POST http://localhost:4002/api/send \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+1234567890",
    "stickerUrl": "https://example.com/sticker.webp"
  }'
```

### Respuesta del Webhook para Stickers Recibidos

```json
{
  "phoneNumber": "1234567890",
  "type": "sticker",
  "from": "1234567890@c.us",
  "id": "3EB0C767D0953D0F",
  "timestamp": 1640995200,
  "body": "",
  "hasMedia": true,
  "data": {
    "mimetype": "image/webp",
    "filename": "sticker.webp",
    "stickerId": "1234567890",
    "packId": "pack123",
    "packName": "Mi Paquete",
    "packPublisher": "Editor",
    "isAnimated": false,
    "data": "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAADsAD+JaQAA3AAAAAA"
  },
  "isForwarded": false
}
```

## Formatos Soportados

- **WebP**: Formato estándar de stickers de WhatsApp
- **GIF**: Para stickers animados
- **PNG**: Para stickers estáticos

## Notas Importantes

1. **Tamaño máximo**: Los stickers deben ser menores a 100KB
2. **Dimensiones recomendadas**: 512x512 píxeles
3. **Formato preferido**: WebP para mejor compresión
4. **Descarga automática**: Los stickers se descargan automáticamente cuando se reciben
5. **Logs detallados**: Se incluyen logs específicos para debugging de stickers

## Logs de Debugging

El bot incluye logs detallados para stickers con el prefijo `[STICKER]`:

```
[STICKER] Sticker recibido de 1234567890
[STICKER] StickerId: 1234567890
[STICKER] PackId: pack123
[STICKER] PackName: Mi Paquete
[STICKER] IsAnimated: false
[STICKER] Iniciando descarga de sticker para 1234567890
[STICKER] Sticker descargado exitosamente para 1234567890, tamaño: 45678 bytes
```

## Errores Comunes

1. **"Media marcado como true pero no hay datos"**: El sticker se recibió pero no se pudo descargar
2. **"URL o datos de sticker requeridos"**: Falta el parámetro `stickerUrl` al enviar
3. **"Invalid URL format"**: La URL del sticker no es válida

## Solución de Problemas

Si los stickers no se descargan correctamente:

1. Verifica que el bot tenga permisos de red
2. Revisa los logs para errores específicos
3. Asegúrate de que la URL del sticker sea accesible
4. Verifica que el formato del sticker sea compatible
