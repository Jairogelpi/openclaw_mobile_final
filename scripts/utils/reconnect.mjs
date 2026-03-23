import { startWhatsAppClient } from '../../channels/whatsapp.mjs';

async function run() {
    console.log('--- RECONNECT SCRIPT ---');
    const clientId = '4b817c0c-bb1b-47d6-b5b1-4367af9403ff';
    const clientSlug = 'gelpierreape-4b817';

    try {
        console.log(`Starting client for ${clientSlug}...`);
        await startWhatsAppClient(clientId, clientSlug);
        console.log('Reconnection command sent.');
    } catch (e) {
        console.error('Error in reconnect script:', e.message);
    }
}

run();
