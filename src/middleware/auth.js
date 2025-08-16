const config = require('../config/environment');

// Middleware de autenticación
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token || token !== config.TOKENACCESS) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  next();
};

module.exports = { authenticateToken };
