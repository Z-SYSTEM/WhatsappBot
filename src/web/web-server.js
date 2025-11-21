import express from 'express';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import fs from 'fs';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename)); // up to src/
const ROOT_DIR = path.dirname(__dirname); // up to project root

// Leer versión de la aplicación
function getAppVersion() {
  const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');
  try {
    if (fs.existsSync(VERSION_FILE)) {
      return fs.readFileSync(VERSION_FILE, 'utf8').trim();
    }
  } catch (e) {
    logger.warn('[WEB_UI] No se pudo leer VERSION, usando versión por defecto');
  }
  return '1.0.0';
}

const appVersion = getAppVersion();

export function setupWebUI(app, server, config) {
  logger.info('[WEB_UI] Configurando interfaz web...');
  
  const io = new Server(server);

  // Session Middleware
  const sessionMiddleware = session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
  });

  app.use(sessionMiddleware);
  app.use(express.urlencoded({ extended: true }));

  // Share session with Socket.IO
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));

  // Auth Middleware
  const checkAuth = (req, res, next) => {
    if (req.session.isAuthenticated) {
      return next();
    }
    res.redirect('/login');
  };

  // Routes
  app.get('/', checkAuth, (req, res) => {
    res.render('index', { 
      botName: config.botName,
      appVersion: appVersion
    });
  });

  app.get('/login', (req, res) => {
    res.render('login', { botName: config.botName, error: null });
  });

  app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === config.webUser && password === config.webPassword) {
      req.session.isAuthenticated = true;
      res.redirect('/');
    } else {
      res.render('login', { botName: config.botName, error: 'Credenciales incorrectas' });
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  });

  // Endpoint para obtener versión y changelog (vista HTML)
  app.get('/api/version', checkAuth, (req, res) => {
    const changelogPath = path.join(ROOT_DIR, 'CHANGELOG.md');
    let changelog = '';
    try {
      if (fs.existsSync(changelogPath)) {
        changelog = fs.readFileSync(changelogPath, 'utf8');
      } else {
        changelog = 'No hay changelog disponible';
      }
    } catch (e) {
      logger.warn('[WEB_UI] No se pudo leer CHANGELOG.md');
      changelog = 'No se pudo cargar el changelog';
    }
    
    res.render('changelog', {
      botName: config.botName,
      appVersion: appVersion,
      changelog: changelog
    });
  });

  logger.info('[WEB_UI] Interfaz web configurada correctamente');

  return io;
}
