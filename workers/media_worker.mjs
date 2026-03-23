import 'dotenv/config';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { mediaQueue, incomingQueue } from '../config/queues.mjs';
import supabase from '../config/supabase.mjs';
import { discoverWhatsAppGroup } from '../skills/whatsapp_groups.mjs';
import { fallbackNameFromRemoteId, pickBestHumanName } from '../utils/message_guard.mjs';
import { buildRawMessageRecord } from '../services/raw_message_ingest.service.mjs';
import { enrichMediaFile } from '../services/media_enrichment.service.mjs';

const redisConnection = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
});

console.log('[Media Worker] Iniciando servicio de media (Nivel 6 Parallel)...');

const mediaWorker = new Worker('mediaProcessingQueue', async (job) => {
    const {
        clientId, clientSlug, senderId, participantJid, isSentByMe,
        pushName, isGroup, text, type, tempFilePath,
        mimetype, filename
    } = job.data;

    console.log('\n======================================================');
    console.log(`[Queue-Media] Procesando archivo multimedia de ${clientSlug}...`);
    console.log(`[Queue-Media] Tipo: ${type} | Archivo temporal: ${tempFilePath}`);

    try {
        const enrichment = await enrichMediaFile({
            filePath: tempFilePath,
            mediaType: type,
            mimeType: mimetype,
            originalName: filename
        });

        const finalText = [enrichment.semanticText, text].filter(Boolean).join(' ').trim();

        if (finalText) {
            console.log(`[Queue-Media] ${enrichment.enrichmentKind} completado. Guardando en DB y encolando...`);

            const groupMeta = isGroup ? await discoverWhatsAppGroup(clientId, senderId).catch(() => null) : null;
            const conversationName = isGroup
                ? (pickBestHumanName(groupMeta?.subject, fallbackNameFromRemoteId(senderId)) || senderId)
                : (pushName || senderId);

            const mediaFileName = tempFilePath.replace('./uploads/', '');
            const media_url = `/uploads/${mediaFileName}`;

            const rawRecord = buildRawMessageRecord({
                clientId,
                senderRole: isSentByMe ? 'user_sent' : (pushName || senderId),
                content: text || '',
                remoteId: senderId,
                processed: false,
                channel: 'whatsapp',
                participantJid,
                canonicalSenderName: isSentByMe ? 'Yo' : (pushName || senderId),
                conversationName,
                isGroup,
                isHistory: false,
                deliveryStatus: isSentByMe ? 'sent' : 'read',
                mediaType: type,
                mediaMimeType: mimetype,
                mediaFilename: filename,
                semanticText: finalText,
                metadata: {
                    pushName,
                    media_url,
                    historical: false,
                    enrichment_kind: enrichment.enrichmentKind,
                    sourced_by: 'media_worker'
                }
            });

            const { error: dbErr, data: insertedRows } = await supabase
                .from('raw_messages')
                .insert([rawRecord])
                .select('id, created_at');

            if (dbErr) console.error('[Queue-Media] DB Error:', dbErr.message);

            if (!dbErr && global.__wss) {
                const insertedMsg = insertedRows?.[0];
                const wsPayload = JSON.stringify({
                    type: 'new_message',
                    data: {
                        conversation_id: senderId,
                        participant_jid: participantJid,
                        id: insertedMsg?.id || `media_${Date.now()}`,
                        text: finalText,
                        from_me: isSentByMe,
                        timestamp: insertedMsg?.created_at || new Date().toISOString(),
                        sender_name: isSentByMe ? 'Yo' : pushName,
                        media_url,
                        media_type: type,
                        status: isSentByMe ? 'sent' : 'read'
                    }
                });
                global.__wss.clients.forEach(ws => {
                    if (ws.readyState === 1 && ws.userId === clientId) {
                        ws.send(wsPayload);
                    }
                });
            }

            await redisClient.set(`idle:${clientId}`, 'process', { EX: 60 });
            console.log(`[Queue-Media] Reloj de memoria activado para ${clientId}.`);

            await incomingQueue.add('process_message', {
                clientId,
                clientSlug,
                channel: 'whatsapp',
                senderId,
                text: finalText,
                isSentByMe,
                metadata: { pushName, isGroup, hasMedia: true }
            }, {
                removeOnComplete: true,
                removeOnFail: 50
            });
            console.log('[Queue-Media] Exito. Texto enrutado al cerebro.');
        } else {
            console.log('[Queue-Media] Media vacio o ilegible, ignorando enrutamiento.');
        }

    } catch (err) {
        console.error(`[Media Worker] Error procesando media de ${clientSlug}:`, err.message);
        throw err;
    }
}, {
    connection: redisConnection,
    concurrency: 10
});

mediaWorker.on('failed', (job, err) => {
    console.error(`[BullMQ-Media] Job ID ${job.id} fallo de forma critica:`, err.message);
});

console.log('[Media Worker] Listo y escuchando.');
