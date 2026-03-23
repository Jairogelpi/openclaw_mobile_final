import supabase from '../config/supabase.mjs';
import { startWhatsAppClient, activeSessions } from '../channels/whatsapp.mjs';
import { preloadConfigCache } from '../services/config.service.mjs';
import { formatProcessMemorySnapshot, startProcessMemoryGuard } from './runtime_guard.mjs';

export async function bootstrapSystem() {
    try {
        await preloadConfigCache();
    } catch (err) {
        console.warn(`[Gateway Boot] Config preload skipped: ${err.message}`);
    }

    try {
        const { data: souls } = await supabase.from('user_souls').select('client_id, slug');
        if (souls && souls.length > 0) {
            console.log(`[Boot] Intentando reconectar ${souls.length} sesiones de WhatsApp...`);
            for (const soul of souls) {
                if (soul.client_id && soul.slug) {
                    startWhatsAppClient(soul.client_id, soul.slug).catch(error => {
                        console.error(`[Boot] Fallo al iniciar cliente ${soul.slug}:`, error.message);
                    });
                }
            }
        }
    } catch (error) {
        console.error('[Boot] Error al auto-conectar WhatsApp:', error.message);
    }

    setInterval(() => {
        const sessions = activeSessions.size;
        console.log(`💓 [Bridge-Health] Sessions: ${sessions}. ${formatProcessMemorySnapshot()}`);
    }, 3600_000);

    startProcessMemoryGuard({
        label: 'Bridge-Guard',
        warnRssMb: Number(process.env.OPENCLAW_GATEWAY_MEMORY_WARN_MB || 650),
        hardRssMb: Number(process.env.OPENCLAW_GATEWAY_MEMORY_HARD_MB || 900),
        intervalMs: Number(process.env.OPENCLAW_GATEWAY_MEMORY_CHECK_MS || 60_000)
    });
}
