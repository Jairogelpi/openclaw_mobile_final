import supabase from '../config/supabase.mjs';
import fs from 'fs/promises';

export async function handleSupabaseWebhook(req, res) {
    try {
        const payload = req.body;

        // Verificar que es un evento DELETE de user_souls
        if (payload.type === 'DELETE' && payload.table === 'user_souls') {
            const oldRecord = payload.old_record;
            if (oldRecord && oldRecord.slug) {
                const clientSlug = oldRecord.slug;
                const clientDir = `./clients/${clientSlug}`;

                console.log(`[Webhook] Evento DELETE recibido para ${clientSlug}. Purgando archivos locales...`);
                try {
                    await fs.rm(clientDir, { recursive: true, force: true });
                    console.log(`[Webhook] ✅ Archivos de ${clientSlug} eliminados correctamente.`);
                } catch (e) {
                    console.log(`[Webhook] ⚠️ No se pudieron borrar archivos de ${clientSlug} o ya no existían:`, e.message);
                }

                // Opcional: Registrar en system_logs que el webhook actuó
                await supabase.from('system_logs').insert({
                    level: 'info',
                    message: `Webhook: Archivos locales purgados tras borrado en DB para ${clientSlug}`
                });
            }
        }
        res.status(200).send('OK');
    } catch (e) {
        console.error('[Webhook] Error procesando webhook:', e.message);
        res.status(500).send('Error');
    }
}
