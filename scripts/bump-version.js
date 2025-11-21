import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VERSION_FILE = path.join(__dirname, '../VERSION');

try {
    // Verificar si hay commits nuevos para pushear (comparar HEAD con origin/main)
    let hasNewCommits = false;
    try {
        // Obtener el nombre de la rama actual
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
        const remoteBranch = `origin/${currentBranch}`;
        
        // Verificar si hay commits locales que no están en el remoto
        try {
            execSync(`git fetch origin ${currentBranch}`, { stdio: 'ignore' });
            const localCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
            const remoteCommit = execSync(`git rev-parse ${remoteBranch}`, { encoding: 'utf8' }).trim();
            hasNewCommits = localCommit !== remoteCommit;
        } catch (e) {
            // Si no existe la rama remota, asumir que hay cambios nuevos
            hasNewCommits = true;
        }
    } catch (e) {
        // Si hay error, asumir que hay cambios nuevos para ser seguro
        hasNewCommits = true;
    }

    if (!hasNewCommits) {
        console.log('No hay commits nuevos para pushear, no se incrementa la versión');
        process.exit(0);
    }

    // Leer o crear versión
    let version = '1.0.0';
    if (fs.existsSync(VERSION_FILE)) {
        version = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    }

    // Incrementar patch
    const [major, minor, patch] = version.split('.').map(Number);
    const newVersion = `${major}.${minor}.${patch + 1}`;

    // Escribir nueva versión
    fs.writeFileSync(VERSION_FILE, newVersion);

    // Hacer commit de la nueva versión
    execSync(`git add ${VERSION_FILE}`, { stdio: 'inherit' });
    execSync(`git commit -m "Bump version to ${newVersion}" --no-verify`, { stdio: 'inherit' });
    console.log(`✓ Versión incrementada a ${newVersion}`);
    
} catch (e) {
    console.error('Error al incrementar versión:', e.message);
    process.exit(1);
}

