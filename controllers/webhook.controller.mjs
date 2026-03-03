import supabase from '../config/supabase.mjs';
import fs from 'fs/promises';
import process from 'node:process';
import { getClientSlug } from '../utils/helpers.mjs';

export async function handleSupabaseWebhook(req, res) {
    try {
        const payload = req.body;
        console.log('[Webhook] Recepción HTTP en endpoint:', JSON.stringify(payload, null, 2));

        // 1. Validate Secret Token
        const authHeader = req.headers['authorization'] || req.headers['x-webhook-secret'];
        // Strip potential quotes from the .env variable
        const webhookSecret = process.env.SUPABASE_WEBHOOK_SECRET ? process.env.SUPABASE_WEBHOOK_SECRET.replace(/^"|"$/g, '') : null;

        // Only validate if a secret is configured in the environment
        if (webhookSecret && (!authHeader || authHeader.replace('Bearer ', '') !== webhookSecret)) {
            console.warn(`[Webhook] ⚠️ Unauthorized access attempt to webhook. Secret mismatch.`);
            return res.status(401).send('Unauthorized');
        }

        // 2. Process DELETE event
        if (payload.type === 'DELETE') {
            const oldRecord = payload.old_record;
            let clientSlug = null;

            if (payload.table === 'user_souls' && oldRecord && oldRecord.slug) {
                clientSlug = oldRecord.slug;
            } else if (payload.table === 'users' && oldRecord && oldRecord.id && oldRecord.email) {
                clientSlug = getClientSlug(oldRecord.email, oldRecord.id);
            }

            if (clientSlug) {
                const clientDir = `./clients/${clientSlug}`;

                console.log(`[Webhook] Evento DELETE recibido para ${clientSlug}. Purgando archivos locales...`);
                try {
                    await fs.rm(clientDir, { recursive: true, force: true });
                    console.log(`[Webhook] ✅ Archivos de ${clientSlug} eliminados correctamente.`);
                } catch (e) {
                    console.log(`[Webhook] ⚠️ No se pudieron borrar archivos de ${clientSlug} o ya no existían:`, e.message);
                }

                await supabase.from('system_logs').insert({
                    level: 'info',
                    message: `Webhook: Archivos locales purgados tras borrado en DB para ${clientSlug}`
                });
            } else {
                console.log(`[Webhook] ℹ️ Evento ignorado o no contiene datos suficientes para determinar el slug.`);
            }
        }
        res.status(200).send('OK');
    } catch (e) {
        console.error('[Webhook] Error procesando webhook:', e.message);
        res.status(500).send('Error');
    }
}
