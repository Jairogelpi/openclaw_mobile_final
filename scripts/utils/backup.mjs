import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import process from 'node:process';
import fs from 'node:fs/promises';
import { createReadStream } from 'fs';
import { exec } from 'child_process';
import util from 'util';
import crypto from 'crypto';
const execPromise = util.promisify(exec);


const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Error: Faltan variables de entorno (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = `/tmp/openclaw-backup-${timestamp}.tar.gz`;
    const encryptedFile = `${backupFile}.enc`;

    console.log(`📦 [Backup] Iniciando respaldo: ${timestamp}`);

    try {
        // 1. Comprimir la carpeta /clients
        console.log('📦 Comprimiendo datos de clientes...');
        await execPromise(`tar -czf ${backupFile} -C . clients/`);

        const stats = await fs.stat(backupFile);
        console.log(`📦 Archivo comprimido: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

        // 2. Cifrar el archivo con AES-256-CBC
        if (ENCRYPTION_KEY && ENCRYPTION_KEY.length === 64) {
            console.log('🔒 Cifrando con AES-256...');
            const key = Buffer.from(ENCRYPTION_KEY, 'hex');
            const iv = crypto.randomBytes(16);
            const input = await fs.readFile(backupFile);

            const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
            const encrypted = Buffer.concat([iv, cipher.update(input), cipher.final()]);
            await fs.writeFile(encryptedFile, encrypted);
            console.log('🔒 Cifrado completo.');
        } else {
            console.warn('⚠️ ENCRYPTION_KEY no disponible, subiendo sin cifrar.');
            await fs.copyFile(backupFile, encryptedFile);
        }

        // 3. Subir a Supabase Storage
        console.log('☁️ Subiendo a Supabase Storage...');
        const fileBuffer = await fs.readFile(encryptedFile);
        const fileName = `backup-${timestamp}.tar.gz.enc`;

        const { error } = await supabase.storage
            .from('backups')
            .upload(fileName, fileBuffer, {
                contentType: 'application/octet-stream',
                upsert: false
            });

        if (error) throw error;
        console.log(`✅ [Backup] Subido exitosamente: ${fileName}`);

        // 4. Limpiar archivos temporales
        await fs.unlink(backupFile).catch(() => { });
        await fs.unlink(encryptedFile).catch(() => { });

        // 5. Registrar en system_logs
        await supabase.from('system_logs').insert({
            level: 'INFO',
            message: `Backup completado: ${fileName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`,
            client_id: 'system'
        });

        // 6. Limpieza de backups antiguos (mantener últimos 7)
        const { data: files } = await supabase.storage.from('backups').list('', {
            sortBy: { column: 'created_at', order: 'asc' }
        });

        if (files && files.length > 7) {
            const toDelete = files.slice(0, files.length - 7).map(f => f.name);
            await supabase.storage.from('backups').remove(toDelete);
            console.log(`🧹 Limpiados ${toDelete.length} backups antiguos.`);
        }

        console.log('✅ [Backup] Proceso completo.');
    } catch (err) {
        console.error('❌ [Backup] Error:', err.message);
        try {
            await supabase.from('system_logs').insert({
                level: 'ERROR',
                message: `Backup fallido: ${err.message}`,
                client_id: 'system'
            });
        } catch (logErr) {
            console.error('❌ [Backup] Error logging to system_logs:', logErr.message);
        }
    }
}

runBackup();
