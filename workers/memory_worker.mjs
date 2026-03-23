import 'dotenv/config';
import supabase from '../config/supabase.mjs';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { ExtractionService } from '../services/intelligence/extraction.service.mjs';
import { DistillationService } from '../services/intelligence/distillation.service.mjs';
import { VectorService } from '../services/intelligence/vector.service.mjs';
import { eventBus } from '../core/event_bus.mjs';
import { 
    isMemoryEligibleRawMessage, 
    renderConversationLine,
    pickBestHumanName,
    deriveOwnerNameFromSlug
} from '../utils/message_guard.mjs';
import { extractSpeakersFromLines } from '../utils/knowledge_guard.mjs';

/**
 * OpenClaw Memory Worker (Phase 5 - Modular Edition)
 */

async function resolveOwnerName(clientId, soulData) {
    const soulName = pickBestHumanName(soulData?.soul_json?.nombre);
    if (soulName) return soulName;
    return deriveOwnerNameFromSlug(soulData?.slug) || 'Titular';
}

async function markMessagesProcessed(ids) {
    if (!ids.length) return;
    await supabase.from('raw_messages').update({ processed: true }).in('id', ids);
}

export async function distillAndVectorize(clientId, options = {}) {
    console.log(`🧠 [MemoryWorker] Processing client ${clientId}...`);
    
    const { data: soulData } = await supabase.from('user_souls').select('slug, soul_json').eq('client_id', clientId).single();
    if (!soulData) return;
    
    const ownerName = await resolveOwnerName(clientId, soulData);

    try {
        const { data: messages } = await supabase
            .from('raw_messages')
            .select('*')
            .eq('client_id', clientId)
            .eq('processed', false)
            .or('enrichment_status.eq.ready,content_ready.eq.true')
            .order('created_at', { ascending: true })
            .limit(100); // Increased batch size for efficiency

        if (!messages?.length) return;

        // 1. Group by Conversation
        const conversations = {};
        messages.forEach(m => {
            if (!conversations[m.remote_id]) conversations[m.remote_id] = [];
            conversations[m.remote_id].push(m);
        });

        const processingPromises = Object.entries(conversations).map(async ([remoteId, convMessages]) => {
            const isGroup = remoteId.endsWith('@g.us');
            const contactName = convMessages[0].metadata?.pushName || remoteId;
            const lines = convMessages.map(m => renderConversationLine(m, ownerName, contactName));
            const speakers = extractSpeakersFromLines(lines);

            // Run Graph Extraction and Vectorization in parallel
            await Promise.all([
                ExtractionService.extractGroundedGraph(clientId, remoteId, ownerName, contactName, lines, { isGroup, speakers })
                    .catch(err => console.error(`⚠️ [MemoryWorker] Graph extraction failed for ${remoteId}: ${err.message}`)),
                VectorService.saveHolographicMemory(clientId, {
                    text: lines.join('\n'),
                    remoteId,
                    contactName,
                    userName: ownerName,
                    rawMessages: convMessages,
                    speakers
                }).catch(err => console.error(`⚠️ [MemoryWorker] Vectorization failed for ${remoteId}: ${err.message}`))
            ]);
        });

        await Promise.all(processingPromises);

        // 4. Marcar mensajes como procesados (Incluso si falla el Soul)
        await markMessagesProcessed(messages.map(m => m.id));

        try {
            // 5. Destilación de Identidad (Soul)
            const soulDelta = await ExtractionService.extractSoulDelta(ownerName, messages, soulData.soul_json);
            if (soulDelta && Object.keys(soulDelta).length > 0) {
                await DistillationService.updateSoulAndSyncFiles(clientId, soulData.slug, soulDelta);
                eventBus.publish('SOUL_UPDATED', { clientId, slug: soulData.slug });
            }
        } catch (err) {
            console.error(`⚠️ [MemoryWorker] Soul distillation failed: ${err.message}`);
        }

        console.log(`✅ [MemoryWorker] Finished processing batch of ${messages.length} messages.`);

    } catch (e) {
        console.error(`❌ [MemoryWorker] Error for ${clientId}:`, e.message);
    }
}

async function main() {
    console.log('🚀 OpenClaw Memory Worker Online');
    
    // Subscribe to idle events via Bus
    eventBus.subscribeGlobal('CLIENT_IDLE', async (data) => {
        if (data.clientId) await distillAndVectorize(data.clientId);
    });

    // Fallback Cron
    cron.schedule('*/30 * * * *', async () => {
        const { data: pends } = await supabase.from('raw_messages').select('client_id').eq('processed', false);
        const uniqueClients = [...new Set((pends || []).map(m => m.client_id))];
        for (const cid of uniqueClients) await distillAndVectorize(cid);
    });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
    main().catch(console.error);
}
