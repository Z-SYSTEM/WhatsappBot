const fs = require('fs-extra');
const path = require('path');
const { logger } = require('../logger');

class SessionManager {
  constructor() {
    this.sessionDir = 'sessions';
    this.backupDir = 'backups';
    
    // Crear directorios necesarios
    this.ensureDirectories();
  }

  ensureDirectories() {
    const dirs = ['logs', 'sessions', 'backups'];
    dirs.forEach(dir => {
      fs.ensureDirSync(dir);
    });
  }

  // Función para hacer backup de la sesión - Solo cuando sea necesario
  async backupSession(force = false) {
    try {
      // Verificar si existe la sesión
      if (!await fs.pathExists(this.sessionDir)) {
        logger.debug('No hay sesión para hacer backup');
        return; // No hay sesión para hacer backup
      }
      
      // Si no es forzado, verificar si es necesario hacer backup
      if (!force) {
        const sessionFiles = await fs.readdir(this.sessionDir);
        if (sessionFiles.length === 0) {
          logger.debug('Sesión vacía, no hacer backup');
          return; // Sesión vacía, no hacer backup
        }
        
        // Verificar si ya existe un backup reciente (menos de 24 horas)
        const existingBackups = await fs.readdir(this.backupDir);
        const timestampBackups = existingBackups.filter(file => /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(file));
        
        if (timestampBackups.length > 0) {
          const latestBackup = timestampBackups.sort().pop();
          const backupTime = new Date(latestBackup.replace(/-/g, ':').replace(' ', 'T'));
          const oneDayAgo = new Date(Date.now() - (24 * 60 * 60 * 1000));
          
          if (backupTime > oneDayAgo) {
            logger.debug('Backup reciente encontrado (menos de 24 horas), saltando creación de nuevo backup');
            return; // Ya hay un backup reciente
          }
        }
      }
      
      // Crear backup solo si es forzado o si no hay backup reciente
      const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(/:/g, '-');
      const backupPath = path.join(this.backupDir, timestamp);
      await fs.copy(this.sessionDir, backupPath);
      logger.info(`Backup de sesión creado: ${backupPath}`);
      
      // Limpiar backups antiguos (mantener solo los 3 más recientes)
      await this.cleanupOldBackups();
      
    } catch (error) {
      logger.error('Error creando backup de sesión:', error.message);
    }
  }

  // Función para limpiar backups antiguos
  async cleanupOldBackups() {
    try {
      const existingBackups = await fs.readdir(this.backupDir);
      const timestampBackups = existingBackups.filter(file => /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(file));
      
      if (timestampBackups.length > 3) {
        // Ordenar por timestamp (más antiguos primero)
        const sortedBackups = timestampBackups.sort();
        const backupsToDelete = sortedBackups.slice(0, timestampBackups.length - 3);
        
        for (const backup of backupsToDelete) {
          const backupPath = path.join(this.backupDir, backup);
          await fs.remove(backupPath);
          logger.debug(`Backup antiguo eliminado: ${backup}`);
        }
        
        logger.info(`Limpieza completada: ${backupsToDelete.length} backups antiguos eliminados`);
      }
    } catch (error) {
      logger.error('Error limpiando backups antiguos:', error.message);
    }
  }

  // Función para restaurar sesión desde backup
  async restoreSessionFromBackup() {
    try {
      const backupFiles = await fs.readdir(this.backupDir);
      const timestampBackups = backupFiles.filter(file => /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(file));
      
      if (timestampBackups.length > 0) {
        // Tomar el backup más reciente
        const latestBackup = timestampBackups.sort().pop();
        const backupPath = path.join(this.backupDir, latestBackup);
        
        await fs.copy(backupPath, this.sessionDir);
        logger.info(`Sesión restaurada desde backup: ${latestBackup}`);
        return true;
      }
    } catch (error) {
      logger.error('Error restaurando sesión desde backup:', error.message);
    }
    return false;
  }

  // Función para verificar si la sesión está corrupta
  async isSessionCorrupted() {
    try {
      if (!await fs.pathExists(this.sessionDir)) {
        return false; // No hay sesión, no está corrupta
      }
      
      const files = await fs.readdir(this.sessionDir);
      return files.length === 0; // Si no hay archivos, está corrupta
    } catch (error) {
      logger.error('Error verificando sesión:', error.message);
      return true;
    }
  }
}

module.exports = SessionManager;
