/**
 * Middleware de autenticación por token Bearer
 */
function authenticateToken(tokenAccess) {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token || token !== tokenAccess) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    next();
  };
}

export { authenticateToken };

