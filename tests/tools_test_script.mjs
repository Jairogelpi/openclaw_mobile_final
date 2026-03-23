import { processMessage } from '../core/core_engine.mjs';

async function test() {
    const data = {
        clientId: 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6',
        clientSlug: 'jairogelpi-cc2af',
        channel: 'whatsapp',
        senderId: '159755754573992@lid',
        text: 'Quien es victor...',
        isSentByMe: true,
        metadata: { pushName: 'Yo (Asistente)', isGroup: false, isSelfChat: true }
    };

    console.log("🚀 Iniciando processMessage localmente...");
    try {
        const reply = await processMessage(data);
        console.log("✅ processMessage finalizado. Reply:", reply);
    } catch (e) {
        console.error("🔥 processMessage lanzó un error SIN CACHEAR:", e);
    }
}

test().then(() => {
    console.log("🏁 Test script finalizado.");
    process.exit(0);
});
