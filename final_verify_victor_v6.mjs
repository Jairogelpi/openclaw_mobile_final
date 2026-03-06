import { invalidateSemanticCache } from './services/local_ai.mjs';
import { processMessage } from './core_engine.mjs';
import 'dotenv/config';

async function finalVerification() {
    const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';

    console.log('🗑️ Clearing cache...');
    await invalidateSemanticCache(clientId);

    console.log('--- Testing Brain Response: Victor Yesterday (V6 Final) ---');
    const text = 'Saca toda la informacion que tengas de lo que he hablando con Víctor ayer, de que trata?';

    try {
        const response = await processMessage({
            clientId,
            clientSlug: 'jairogelpi-cc2af',
            channel: 'whatsapp',
            senderId: 'user_sent',
            text,
            isSentByMe: true,
            metadata: { isSelfChat: true }
        });
        console.log('\n--- BRAIN RESPONSE ---');
        console.log(response);
        console.log('--- END ---');
    } catch (e) {
        console.error('FAIL:', e);
    }
    process.exit(0);
}

finalVerification();
