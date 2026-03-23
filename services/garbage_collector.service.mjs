import fs from 'fs/promises';
import path from 'path';
import supabase from '../config/supabase.mjs';

/**
 * Runs the garbage collector to forcefully delete physical folders that no longer exist in Supabase DB.
 */
export async function runGarbageCollector() {
    try {
        const { data: activeUsers, error } = await supabase.from('user_souls').select('slug');
        if (error || !activeUsers) throw error;

        const activeSlugs = activeUsers.map(u => u.slug).filter(Boolean);

        // Revisa carpetas físicas
        const clientsPath = path.resolve('./clients');
        let directories;
        try {
            directories = await fs.readdir(clientsPath, { withFileTypes: true });
        } catch (readErr) {
            // clients folder doesn't exist yet
            await fs.mkdir(clientsPath, { recursive: true });
            directories = [];
        }

        let purged = 0;
        for (let dirent of directories) {
            if (dirent.isDirectory()) {
                const folderName = dirent.name;
                if (!activeSlugs.includes(folderName)) {
                    console.log(`[GarbageCollector] 🗑️ Carpeta fantasma detectada: ${folderName}. Purging...`);
                    await fs.rm(path.join(clientsPath, folderName), { recursive: true, force: true });
                    purged++;
                }
            }
        }
        console.log(`[GarbageCollector] ✅ Ciclo completado. DB slugs: ${activeSlugs.length}, Carpetas: ${directories.filter(d => d.isDirectory()).length}, Purgadas: ${purged}`);
    } catch (e) {
        console.error('[GarbageCollector] ⚠️ Fallo al recolectar basura de clientes:', e.message);
    }
}

export function startGarbageCollector(intervalMs = 2 * 60 * 1000) {
    // Ejecutar inmediatamente al arrancar y luego según el intervalo
    runGarbageCollector();
    return setInterval(runGarbageCollector, intervalMs);
}
