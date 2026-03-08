import 'dotenv/config';
import { Worker } from 'bullmq';
import { outgoingQueue } from './config/queues.mjs';
import { processMessage } from './core_engine.mjs';
import { warmupEmbedder } from './services/local_ai.mjs';
import { preloadConfigCache } from './services/config.service.mjs';
import IORedis from 'ioredis';
import redisClient from './config/redis.mjs';
import supabase from './config/supabase.mjs';

const redisConnection = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
});

console.log('🧠 [Brain Worker] Iniciando servicio neuro-cognitivo (AI Microservice)...');
try {
    await preloadConfigCache();
} catch (err) {
    console.warn(`[Brain Worker] Config preload skipped: ${err.message}`);
}
warmupEmbedder('brain_worker_boot').catch(err => {
    console.warn(`[Brain Worker] Warmup skipped: ${err.message}`);
});

async function loadLatestTraceForAdmin(clientId, queryText) {
    try {
        const normalizedQuery = String(queryText || '').trim().slice(0, 500);
        const { data } = await supabase
            .from('rag_metrics')
            .select('*')
            .eq('client_id', clientId)
            .eq('query', normalizedQuery)
            .order('created_at', { ascending: false })
            .limit(1);

        if (data?.[0]) return data[0];

        const { data: fallback } = await supabase
            .from('rag_metrics')
            .select('*')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(1);

        return fallback?.[0] || null;
    } catch (error) {
        console.warn(`[Brain Worker] Trace lookup skipped: ${error.message}`);
        return null;
    }
}

async function storeAdminResult(requestId, payload) {
    if (!requestId || !redisClient) return;
    try {
        await redisClient.set(`admin_neural_result:${requestId}`, JSON.stringify(payload), { EX: 180 });
    } catch (error) {
        console.warn(`[Brain Worker] Admin result store skipped: ${error.message}`);
    }
}

async function enqueueReply({ clientId, clientSlug, senderId, aiReply, isSelfChat }) {
    if (!aiReply) {
        console.log('[Brain Worker] ℹ️ La IA decidió no responder (reply fue null/vacío).');
        return;
    }

    if (isSelfChat) {
        const prefixedReply = aiReply.startsWith('🤖') ? aiReply : `🤖 ${aiReply}`;
        console.log(`[Queue-Out] 🗣️ Empujando respuesta a outgoingMessagesQueue para ${clientSlug}...`);
        await outgoingQueue.add('send_reply', {
            clientId,
            clientSlug,
            senderId,
            text: prefixedReply,
            memoryText: aiReply
        }, {
            removeOnComplete: true,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 }
        });
        console.log('[Queue-Out] ✅ Respuesta self-chat encolada para WhatsApp.');
        return;
    }

    console.log(`[Queue-Out] 🗣️ Empujando respuesta a outgoingMessagesQueue para ${clientSlug}...`);
    await outgoingQueue.add('send_reply', {
        clientId,
        clientSlug,
        senderId,
        text: aiReply,
        memoryText: aiReply
    }, {
        removeOnComplete: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 }
    });
    console.log('[Queue-Out] ✅ Respuesta encolada para WhatsApp.');
}

export async function runBrainCycle(data, { enqueueOutgoing = true, logPrefix = '[Queue-In]' } = {}) {
    const { clientId, clientSlug, text, senderId } = data;

    console.log('\n======================================================');
    console.log(`${logPrefix} 📨 Analizando mensaje entrante de ${clientSlug}...`);
    console.log(`📝 Texto: "${String(text || '').substring(0, 50)}..."`);

    const aiReply = await processMessage(data);

    if (enqueueOutgoing) {
        await enqueueReply({
            clientId,
            clientSlug,
            senderId,
            aiReply,
            isSelfChat: Boolean(data.metadata?.isSelfChat)
        });
    }

    return {
        reply: aiReply,
        trace: await loadLatestTraceForAdmin(clientId, text)
    };
}

const workerOptions = {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 300000,
    lockRenewTime: 15000,
    stalledInterval: 300000,
    maxStalledCount: 5
};

const brainWorker = new Worker('incomingMessagesQueue', async (job) => {
    try {
        await runBrainCycle(job.data, { enqueueOutgoing: true, logPrefix: '[Queue-In]' });
    } catch (err) {
        console.error(`❌ [Brain Worker] Error procesando mensaje de ${job?.data?.clientSlug}:`, err.message);
        throw err;
    }
}, workerOptions);

brainWorker.on('failed', (job, err) => {
    console.error(`[BullMQ-Brain] 💥 Job ID ${job?.id} falló de forma crítica:`, err.message);
});

const adminNeuralWorker = new Worker('adminNeuralQueue', async (job) => {
    const data = job.data || {};
    try {
        const result = await runBrainCycle(data, { enqueueOutgoing: false, logPrefix: '[Queue-Admin]' });
        await storeAdminResult(data.adminRequestId, {
            ok: true,
            reply: result.reply,
            trace: result.trace,
            requestId: data.adminRequestId
        });
        return result;
    } catch (error) {
        await storeAdminResult(data.adminRequestId, {
            ok: false,
            error: error.message,
            requestId: data.adminRequestId
        });
        throw error;
    }
}, {
    ...workerOptions,
    maxStalledCount: 2
});

adminNeuralWorker.on('failed', async (job, err) => {
    console.error(`[BullMQ-Admin] 💥 Job ID ${job?.id} falló de forma crítica:`, err.message);
    await storeAdminResult(job?.data?.adminRequestId, {
        ok: false,
        error: err.message,
        requestId: job?.data?.adminRequestId
    });
});

console.log('🌟 [Brain Worker] Listo y escuchando. Esperando señales en incomingMessagesQueue...');
