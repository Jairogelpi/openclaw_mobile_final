import { processIncomingMessage } from './core_engine.mjs';
import 'dotenv/config';

async function testResponse() {
    console.log('--- Testing Brain Response directly ---');
    const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';
    const text = 'Quién es Mireya?';

    try {
        const response = await processIncomingMessage(clientId, text, {
            client_slug: 'jairogelpi-cc2af',
            isSelfChat: true
        });
        console.log('\n--- BRAIN RESPONSE ---');
        console.log(response);
        console.log('--- END ---');
    } catch (e) {
        console.error('FAIL:', e);
    }
    process.exit(0);
}

testResponse();
