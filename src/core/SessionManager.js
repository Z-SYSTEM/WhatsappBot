import fs from 'fs-extra';
import path from 'path';
import { logger } from '../logger.js';

class SessionManager {
  constructor(sessionPath = 'sessions', backupDir = 'backups') {
    this.sessionPath = sessionPath;
    this.backupDir = backupDir;
    
    // Asegurar que los directorios existan
    fs.ensureDirSync(sessionPath);
    fs.ensureDirSync(backupDir);
  }

  /**
   * Hace backup de la sesión actual
   * @param {boolean} force - Si true, hace backup sin verificar si existe uno reciente
   */
  async backup(force = false) {
    try {
      // Verificar si existe la sesión
      if (!await fs.pathExists(this.sessionPath)) {
        logger.debug('[SESSION_MANAGER] No hay sesión para hacer backup');
        return;
      }
      
      // Si no es forzado, verificar si es necesario hacer backup
      if (!force) {
        const sessionFiles = await fs.readdir(this.sessionPath);
        if (sessionFiles.length === 0) {
          logger.debug('[SESSION_MANAGER] Sesión vacía, no hacer backup');
          return;
        }
        
        // Verificar si ya existe un backup reciente (menos de 24 horas)
        const existingBackups = await fs.readdir(this.backupDir);
        const timestampBackups = existingBackups.filter(file => /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(file));
        
        if (timestampBackups.length > 0) {
          const latestBackup = timestampBackups.sort().pop();
          const backupTime = new Date(latestBackup.replace(/-/g, ':').replace(' ', 'T'));
          const oneDayAgo = new Date(Date.now() - (24 * 60 * 60 * 1000));
          
          if (backupTime > oneDayAgo) {
            logger.debug('[SESSION_MANAGER] Backup reciente encontrado (menos de 24 horas), saltando creación de nuevo backup');
            return;
          }
        }
      }
      
      // Crear backup
      const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(/:/g, '-');
      const backupPath = path.join(this.backupDir, timestamp);
      await fs.copy(this.sessionPath, backupPath);
      logger.info(`[SESSION_MANAGER] Backup de sesión creado: ${backupPath}`);
      
      // Limpiar backups antiguos (mantener solo los 3 más recientes)
      await this.cleanupOldBackups();
      
    } catch (error) {
      logger.error('[SESSION_MANAGER] Error creando backup de sesión:', error.message);
    }
  }

  /**
   * Limpia backups antiguos (mantiene solo los 3 más recientes)
   */
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
          logger.debug(`[SESSION_MANAGER] Backup antiguo eliminado: ${backup}`);
        }
        
        logger.info(`[SESSION_MANAGER] Limpieza completada: ${backupsToDelete.length} backups antiguos eliminados`);
      }
    } catch (error) {
      logger.error('[SESSION_MANAGER] Error limpiando backups antiguos:', error.message);
    }
  }

  /**
   * Restaura sesión desde el backup más reciente
   * @returns {Promise<boolean>} true si se restauró exitosamente
   */
  async restore() {
    try {
      const backupFiles = await fs.readdir(this.backupDir);
      const timestampBackups = backupFiles.filter(file => /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(file));
      
      if (timestampBackups.length > 0) {
        // Tomar el backup más reciente
        const latestBackup = timestampBackups.sort().pop();
        const backupPath = path.join(this.backupDir, latestBackup);
        
        await fs.copy(backupPath, this.sessionPath);
        logger.info(`[SESSION_MANAGER] Sesión restaurada desde backup: ${latestBackup}`);
        return true;
      }
    } catch (error) {
      logger.error('[SESSION_MANAGER] Error restaurando sesión desde backup:', error.message);
    }
    return false;
  }

  /**
   * Limpia la sesión actual (logout)
   */
  async cleanupSession() {
    try {
      logger.info('[SESSION_MANAGER] Limpiando sesión actual para logout...');
      await fs.remove(this.sessionPath);
      await fs.ensureDir(this.sessionPath);
      logger.info('[SESSION_MANAGER] Directorio de sesión limpiado.');
    } catch (error) {
      logger.error('[SESSION_MANAGER] Error limpiando la sesión:', error.message);
    }
  }

  /**
   * Limpia sesión corrupta y hace backup antes de eliminarla
   * @param {object} options - Opciones.
   * @param {boolean} options.restoreAfter - Si es true, intenta restaurar desde backup.
   */
  async cleanupCorrupted({ restoreAfter = true } = {}) {
    try {
      // Hacer backup de la sesión corrupta antes de eliminarla
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptedBackupPath = path.join(this.backupDir, `corrupted_${timestamp}`);
      
      if (await fs.pathExists(this.sessionPath)) {
        await fs.copy(this.sessionPath, corruptedBackupPath);
        logger.info(`[SESSION_MANAGER] Sesión corrupta respaldada en: ${corruptedBackupPath}`);
      }
      
      // Eliminar sesión actual
      await fs.remove(this.sessionPath);
      await fs.ensureDir(this.sessionPath);
      
      logger.info('[SESSION_MANAGER] Sesión corrupta eliminada');
      
      if (restoreAfter) {
        // Intentar restaurar desde backup más reciente
        logger.info('[SESSION_MANAGER] Intentando restore automático desde backup...');
        const restored = await this.restore();
        
        if (restored) {
          logger.info('[SESSION_MANAGER] ✅ Sesión restaurada automáticamente desde backup');
        } else {
          logger.warn('[SESSION_MANAGER] ⚠️ No se encontró backup válido, se requerirá nuevo QR');
        }
      }
      
    } catch (error) {
      logger.error('[SESSION_MANAGER] Error limpiando/restaurando sesión:', error.message);
    }
  }
}

export default SessionManager;

