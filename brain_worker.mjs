import 'dotenv/config';
import { Worker } from 'bullmq';
import { incomingQueue, outgoingQueue } from './config/queues.mjs';
import { processMessage } from './core_engine.mjs';
import IORedis from 'ioredis';

const redisConnection = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
});
console.log('🧠 [Brain Worker] Iniciando servicio neuro-cognitivo (AI Microservice)...');

// 1. Instanciar el Worker para la Cola de Entrada
// Escucha lo que los clientes dicen por WhatsApp (empujado por el Gateway)
const brainWorker = new Worker('incomingMessagesQueue', async (job) => {
    const data = job.data;
    const { clientId, clientSlug, text, senderId } = data;

    console.log(`\n======================================================`);
    console.log(`[Queue-In] 📨 Analizando mensaje entrante de ${clientSlug}...`);
    console.log(`📝 Texto: "${text.substring(0, 50)}..."`);

    try {
        // Enviar al Cerebro Principal
        const aiReply = await processMessage(data);

        // Prefixar respuesta con 🤖 si es self-chat (para distinguir bot de usuario)
        if (aiReply && data.metadata?.isSelfChat) {
            const prefixedReply = aiReply.startsWith('🤖') ? aiReply : `🤖 ${aiReply}`;
            console.log(`[Queue-Out] 🗣️ Empujando respuesta a outgoingMessagesQueue para ${clientSlug}...`);
            await outgoingQueue.add('send_reply', {
                clientId,
                clientSlug,
                senderId,
                text: prefixedReply
            }, {
                removeOnComplete: true,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 }
            });
            console.log(`[Queue-Out] ✅ Respuesta self-chat encolada para WhatsApp.`);
        } else if (aiReply) {
            console.log(`[Queue-Out] 🗣️ Empujando respuesta a outgoingMessagesQueue para ${clientSlug}...`);
            await outgoingQueue.add('send_reply', {
                clientId,
                clientSlug,
                senderId,
                text: aiReply
            }, {
                removeOnComplete: true,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 }
            });
            console.log(`[Queue-Out] ✅ Respuesta encolada para WhatsApp.`);
        } else {
            console.log(`[Brain Worker] ℹ️ La IA decidió no responder (reply fue null/vacío).`);
        }

    } catch (err) {
        console.error(`❌ [Brain Worker] Error procesando mensaje de ${clientSlug}:`, err.message);
        throw err; // El trabajo fallará y BullMQ lo reintentará
    }
}, {
    connection: redisConnection,
    concurrency: 1, // Reducido a 1 para evitar asfixiar el CPU con ONNX
    lockDuration: 300000,   // 5 minutos para que el RAG+LLM complete (aumentado por ONNX freeze)
    lockRenewTime: 15000,   // Intentar renovar muy frecuentemente
    stalledInterval: 300000, // 5 min sin heartbeat para considerarlo stalled
    maxStalledCount: 5       // Permitir hasta 5 stalls antes de fallar permanentemente
});

brainWorker.on('failed', (job, err) => {
    console.error(`[BullMQ-Brain] 💥 Job ID ${job?.id} falló de forma crítica:`, err.message);
});

console.log('🌟 [Brain Worker] Listo y escuchando. Esperando señales en incomingMessagesQueue...');
