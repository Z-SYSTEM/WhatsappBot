import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const config = {
  // Bot and Server configuration
  botName: process.env.BOT_NAME || 'WhatsAppBot',
  port: process.env.PORT || 4002,
  portWeb: process.env.PORT_WEB || 4003,
  tokenAccess: process.env.TOKENACCESS,

  // Web UI Credentials
  sessionSecret: process.env.SESSION_SECRET || 'default_secret_key',
  webUser: process.env.WEB_USER || 'admin',
  webPassword: process.env.WEB_PASSWORD || 'admin',

  // Webhooks
  onMessage: process.env.ONMESSAGE,

  // FCM Notifications
  fcmDeviceToken: process.env.FCM_DEVICE_TOKEN,

  // Call handling
  acceptCall: process.env.ACCEPT_CALL === 'TRUE',

  // Health Check
  healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL_SECONDS, 10) || 30,
  healthCheckMaxSilenceMinutes: parseInt(process.env.HEALTH_CHECK_MAX_SILENCE_MINUTES, 10) || 10,

  // Directories
  dirs: {
    sessions: path.resolve('sessions'),
    backups: path.resolve('backups'),
    logs: path.resolve('logs'),
  },

  // Reconnection strategy (sensible defaults)
  initialReconnectDelay: 5000, // 5 seconds
  reconnectBackoffMultiplier: 1.5,
  maxReconnectDelay: 60000, // 1 minute
  maxReconnectAttempts: 10,
  maxConsecutiveFailures: 5,
};

export default config;

