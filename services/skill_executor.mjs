import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execPromise = promisify(exec);
const SKILLS_ROOT = path.resolve('/root/openclaw-server/skills');

/**
 * Skill Executor: El puente entre la IA y los scripts locales.
 */
export async function executeSkill(skillSlug, scriptName, args = []) {
    try {
        console.log(`🛠️ [Skill-Executor] Intentando ejecutar: ${skillSlug}/${scriptName} con args: ${args.join(', ')}`);

        // 1. Validar que la Skill existe
        const skillPath = path.join(SKILLS_ROOT, skillSlug);
        const scriptPath = path.join(skillPath, 'scripts', scriptName);

        // Seguridad: Verificar que el path está dentro de SKILLS_ROOT
        if (!scriptPath.startsWith(SKILLS_ROOT)) {
            throw new Error('Intento de path traversal detectado.');
        }

        await fs.access(scriptPath);

        // 2. Determinar el comando (python3 por defecto para .py, node para .mjs/.js)
        let command = '';
        if (scriptName.endsWith('.py')) {
            command = `python3 "${scriptPath}"`;
        } else if (scriptName.endsWith('.js') || scriptName.endsWith('.mjs')) {
            command = `node "${scriptPath}"`;
        } else {
            throw new Error(`Tipo de script no soportado: ${scriptName}`);
        }

        // 3. Ejecutar
        const fullCommand = `${command} ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`;
        console.log(`🚀 [Skill-Executor] Ejecutando: ${fullCommand}`);

        const { stdout, stderr } = await execPromise(fullCommand, { timeout: 60000 });

        if (stderr && !stdout) {
            console.error(`❌ [Skill-Executor] Error en script stderr:`, stderr);
            return `[Error en Skill]: ${stderr}`;
        }

        return stdout.trim();

    } catch (err) {
        console.error(`❌ [Skill-Executor] Error crítico ejecutando skill ${skillSlug}:`, err.message);
        return `[Error crítico Skill]: ${err.message}`;
    }
}

/**
 * YouTube Specific Wrapper: Para facilitar la integración.
 */
export async function summarizeYouTubeVideo(videoUrl) {
    console.log(`📺 [YouTube-Skill] Procesando URL: ${videoUrl}`);
    // Usamos el script get_transcript.py de la skill youtube-watcher
    // Nota: El script original de la skill parece estar en youtube-watcher/scripts/get_transcript.py
    return await executeSkill('youtube-watcher', 'get_transcript.py', [videoUrl]);
}
