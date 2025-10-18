// Constantes para tipos de mensajes de WhatsApp
export const _PROTOCOL_MESSAGE_ALBUM = 14;
export const _PROTOCOL_MESSAGE_REVOKE = 7;
export const _PROTOCOL_MESSAGE_EPHEMERAL_SETTING = 18;

// Constantes para tipos de mensajes
export const _MESSAGE_TYPE_CHAT = 'chat';
export const _MESSAGE_TYPE_IMAGE = 'image';
export const _MESSAGE_TYPE_VIDEO = 'video';
export const _MESSAGE_TYPE_AUDIO = 'audio';
export const _MESSAGE_TYPE_DOCUMENT = 'document';
export const _MESSAGE_TYPE_LOCATION = 'location';
export const _MESSAGE_TYPE_CONTACT = 'contact';
export const _MESSAGE_TYPE_ALBUM = 'album';
export const _MESSAGE_TYPE_CALL = 'call';

// Constantes para timeouts y límites
export const _ALBUM_WAIT_TIMEOUT = 10000; // 10 segundos para esperar mensajes de álbum
export const _ALBUM_MAX_IMAGES = 30; // Máximo número de imágenes en un álbum
export const _PROCESSED_MESSAGES_MAX_SIZE = 1000;
export const _PROCESSED_MESSAGES_KEEP_SIZE = 500;

// Versión fija de WhatsApp (solución temporal para estabilidad)
export const _WHATSAPP_VERSION = [2, 3000, 1027934701];

// Constantes de reintentos y reconexión
export const _DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
export const _DEFAULT_INITIAL_RECONNECT_DELAY = 5000; // 5 segundos
export const _DEFAULT_MAX_RECONNECT_DELAY = 300000; // 5 minutos
export const _DEFAULT_RECONNECT_BACKOFF_MULTIPLIER = 2.0;
export const _DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

