import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename)); // up to src/

export function createWebServer(config) {
  logger.info(`[WEB_UI] Creando servidor web en puerto ${config.portWeb}...`);
  const app = express();
  const server = http.createServer(app);
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
    res.render('index', { botName: config.botName });
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

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`[WEB_UI] El puerto ${config.portWeb} ya está en uso.`);
      logger.error('[WEB_UI] Por favor, libera el puerto o cambia PORT_WEB en el archivo .env');
      process.exit(1);
    } else {
      logger.error('[WEB_UI] Error en el servidor web:', err.message);
      process.exit(1);
    }
  });

  server.listen(config.portWeb, () => {
    logger.info(`[WEB_UI] Interfaz web iniciada en http://localhost:${config.portWeb}`);
  });

  return { app, server, io };
}
