import supabase from '../../config/supabase.mjs';
import fs from 'fs/promises';
import { ClientStorageService } from '../client_storage.service.mjs';
import { encrypt } from '../../core/security.mjs';

export class DistillationService {
    /**
     * Updates the Soul JSON and syncs Markdown files to disk.
     */
    static async updateSoulAndSyncFiles(clientId, slug, soulUpdate) {
        const { data: soulRow } = await supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single();
        const updatedSoul = { ...soulRow.soul_json, ...soulUpdate };

        // 1. Update Database
        await supabase.from('user_souls').update({ soul_json: updatedSoul }).eq('client_id', clientId);

        // 2. Sync to Disk
        const clientDir = ClientStorageService.getClientDir(slug);
        await fs.mkdir(clientDir, { recursive: true });

        const files = {
            'SOUL.md': `# Identidad\nEres ${updatedSoul.nombre || 'OpenClaw'}.`,
            'USER.md': `# Perfil\n- Usuario: ${updatedSoul.nombre || 'Usuario'}`,
            'CONTEXT.md': `# Contexto\nActualizado el ${new Date().toISOString()}`,
            'AGENT.md': `# Directrices\n- Sistema sincronizado.`
        };

        for (const [filename, content] of Object.entries(files)) {
            await fs.writeFile(`${clientDir}/${filename}`, encrypt(content));
        }

        console.log(`[Distillation] Soul & MD files synced for ${slug} ✅`);
        return updatedSoul;
    }
}
