import { Queue } from 'bullmq';
import IORedis from 'ioredis';

async function testMQ() {
    const connection = new IORedis({ host: '127.0.0.1', port: 6379 });
    const incomingQueue = new Queue('incomingMessagesQueue', { connection });

    const data = {
        clientId: 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6',
        clientSlug: 'jairogelpi-cc2af',
        channel: 'whatsapp',
        senderId: '159755754573992@lid',
        text: 'Quien es victor...',
        isSentByMe: true,
        metadata: { pushName: 'Yo (Asistente)', isGroup: false, isSelfChat: true }
    };

    console.log("🚀 Encolando job a PM2 (incomingMessagesQueue)...");
    await incomingQueue.add('process_message', data);
    console.log("✅ Job encolado.");
    process.exit(0);
}

testMQ();
