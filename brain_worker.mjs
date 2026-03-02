import 'dotenv/config';
import { Worker } from 'bullmq';
import { incomingQueue, outgoingQueue } from './config/queues.mjs';
import { processMessage } from './core_engine.mjs';
import redisClient from './config/redis.mjs';

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

        // Si la IA generó una respuesta válida, se la pasamos al Oído/Boca (WhatsApp)
        if (aiReply) {
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
    connection: redisClient,
    concurrency: 5 // Este servidor puede "pensar" en 5 respuestas de IA al mismo tiempo
});

brainWorker.on('failed', (job, err) => {
    console.error(`[BullMQ-Brain] 💥 Job ID ${job.id} falló de forma crítica:`, err.message);
});

console.log('🌟 [Brain Worker] Listo y escuchando. Esperando señales en incomingMessagesQueue...');
