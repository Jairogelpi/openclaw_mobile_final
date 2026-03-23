import 'dotenv/config';
import { Worker } from 'bullmq';
import { outgoingQueue } from '../config/queues.mjs';
import { processMessage } from '../core/core_engine.mjs';
import { getEmbedderRuntimeSnapshot, unloadEmbedderRuntime, warmupEmbedder } from '../services/local_ai.mjs';
import { preloadConfigCache } from '../services/config.service.mjs';
import IORedis from 'ioredis';
import supabase from '../config/supabase.mjs';
import express from 'express';
import cors from 'cors';
import { formatProcessMemorySnapshot, getProcessMemorySnapshot, startProcessMemoryGuard } from '../core/runtime_guard.mjs';

const redisConnection = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
});
const BRAIN_ADMIN_PORT = Number(process.env.OPENCLAW_BRAIN_ADMIN_PORT || 3001);
const BRAIN_MEMORY_WARN_MB = Number(process.env.OPENCLAW_BRAIN_MEMORY_WARN_MB || 1100);
const BRAIN_MEMORY_HARD_MB = Number(process.env.OPENCLAW_BRAIN_MEMORY_HARD_MB || 1450);
const BRAIN_MEMORY_CHECK_MS = Number(process.env.OPENCLAW_BRAIN_MEMORY_CHECK_MS || 60_000);

console.log('🧠 [Brain Worker] Iniciando servicio neuro-cognitivo (AI Microservice)...');
try {
    await preloadConfigCache();
} catch (err) {
    console.warn(`[Brain Worker] Config preload skipped: ${err.message}`);
}
warmupEmbedder('brain_worker_boot').catch(err => {
    console.warn(`[Brain Worker] Warmup skipped: ${err.message}`);
});

startProcessMemoryGuard({
    label: 'Brain-Guard',
    warnRssMb: BRAIN_MEMORY_WARN_MB,
    hardRssMb: BRAIN_MEMORY_HARD_MB,
    intervalMs: BRAIN_MEMORY_CHECK_MS,
    onWarn: async snapshot => {
        console.warn(`[Brain Worker] Snapshot: ${formatProcessMemorySnapshot(snapshot)} | embedder=${JSON.stringify(getEmbedderRuntimeSnapshot())}`);
    },
    onHard: async snapshot => {
        console.warn(`[Brain Worker] Intentando aliviar memoria. ${formatProcessMemorySnapshot(snapshot)} | embedder=${JSON.stringify(getEmbedderRuntimeSnapshot())}`);
        await unloadEmbedderRuntime({
            force: true,
            clearCache: true,
            reason: 'brain_memory_guard'
        });
    }
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

async function enqueueReply({ clientId, clientSlug, senderId, aiReply, isSelfChat }) {
    if (!aiReply) {
        console.log('[Brain Worker] ℹ️ La IA decidió no responder (reply fue null/vacío).');
        return;
    }

    if (isSelfChat) {
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

const brainAdminApp = express();
brainAdminApp.use(cors());
brainAdminApp.use(express.json({ limit: '2mb' }));

brainAdminApp.get('/healthz', (_req, res) => {
    res.json({
        ok: true,
        service: 'openclaw-brain',
        port: BRAIN_ADMIN_PORT,
        memory: getProcessMemorySnapshot(),
        embedder: getEmbedderRuntimeSnapshot()
    });
});

brainAdminApp.post('/admin/api/neural_chat', async (req, res) => {
    if (req.query.token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const { clientId, text, remoteId, asSelfChat, threadId } = req.body || {};
    if (!clientId || !text) {
        return res.status(400).json({ error: 'Faltan parámetros' });
    }

    try {
        const { data: soul } = await supabase
            .from('user_souls')
            .select('slug')
            .eq('client_id', clientId)
            .single();

        const clientSlug = soul?.slug || 'unknown';
        console.log(`🧠 [Brain Admin API] Probe for ${clientId} (${clientSlug}): "${String(text).slice(0, 30)}..."`);

        const selfChatMode = Boolean(asSelfChat);

        const result = await runBrainCycle({
            clientId,
            clientSlug,
            text,
            senderId: selfChatMode ? (threadId || `terminal-self-chat:${clientId}`) : (remoteId || 'terminal-admin'),
            pushName: selfChatMode ? 'Yo (Asistente)' : 'Admin Debugger',
            channel: 'terminal',
            isSentByMe: selfChatMode,
            metadata: {
                adminProbe: true,
                isSelfChat: selfChatMode,
                debugRemoteId: remoteId || null
            }
        }, {
            enqueueOutgoing: false,
            logPrefix: '[Brain-HTTP]'
        });

        return res.json({
            reply: result.reply,
            trace: result.trace || null,
            path: 'brain_http'
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

brainAdminApp.listen(BRAIN_ADMIN_PORT, '0.0.0.0', () => {
    console.log(`🧠 [Brain Admin API] Listening on http://0.0.0.0:${BRAIN_ADMIN_PORT}`);
});

console.log('🌟 [Brain Worker] Listo y escuchando. Esperando señales en incomingMessagesQueue...');
