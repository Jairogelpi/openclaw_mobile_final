import 'dotenv/config';
import { processMessage } from '../core/core_engine.mjs';

const mockEvent = {
    clientId: 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6', 
    clientSlug: 'victor',
    senderId: 'user_123',
    channel: 'whatsapp',
    text: '¿Cómo va mi vida según lo que sabes de mí?',
    metadata: {
        isSelfChat: false
    }
};

async function test() {
    console.log("🧪 [Test] Starting Neural Core Verification...");
    try {
        const response = await processMessage(mockEvent);
        console.log("\n🤖 [Bot Response]:");
        console.log(response);
    } catch (error) {
        console.error("❌ [Test Failed]:", error);
    }
}

test();
