import 'dotenv/config';
import fs from 'fs/promises';
import { Worker } from 'bullmq';
import { mediaQueue, incomingQueue } from './config/queues.mjs';
import redisClient from './config/redis.mjs';
import supabase from './config/supabase.mjs';
import { discoverWhatsAppGroup } from './skills/whatsapp_groups.mjs';
import { fallbackNameFromRemoteId, pickBestHumanName } from './utils/message_guard.mjs';
import { transcribeAudio, analyzeImage, extractFileText } from './utils/media.mjs';

console.log('[Media Worker] Iniciando servicio de media...');

const mediaWorker = new Worker('mediaProcessingQueue', async (job) => {
    const {
        clientId, clientSlug, senderId, participantJid, isSentByMe,
        pushName, isGroup, text, type, tempFilePath,
        mimetype, filename
    } = job.data;

    console.log('\n======================================================');
    console.log(`[Queue-Media] Procesando archivo multimedia de ${clientSlug}...`);
    console.log(`[Queue-Media] Tipo: ${type} | Archivo temporal: ${tempFilePath}`);

    let mediaDescription = '';

    try {
        if (type === 'audio') {
            mediaDescription = await transcribeAudio(tempFilePath);
        } else if (type === 'image') {
            mediaDescription = await analyzeImage(tempFilePath);
        } else if (type === 'document') {
            mediaDescription = await extractFileText(tempFilePath, mimetype, filename);
        }

        const finalText = [mediaDescription, text].filter(Boolean).join(' ');

        if (finalText) {
            console.log('[Queue-Media] Transcripcion/analisis completado. Guardando en DB y encolando...');

            const groupMeta = isGroup ? await discoverWhatsAppGroup(clientId, senderId).catch(() => null) : null;
            const conversationName = isGroup
                ? (pickBestHumanName(groupMeta?.subject, fallbackNameFromRemoteId(senderId)) || senderId)
                : (pushName || senderId);

            const mediaFileName = tempFilePath.replace('./uploads/', '');
            const media_url = `/uploads/${mediaFileName}`;

            const { error: dbErr, data: insertedRows } = await supabase.from('raw_messages').insert([{
                client_id: clientId,
                sender_role: isSentByMe ? 'user_sent' : (pushName || senderId),
                content: finalText,
                remote_id: senderId,
                processed: false,
                metadata: {
                    pushName,
                    channel: 'whatsapp',
                    isGroup,
                    hasMedia: true,
                    mediaType: type,
                    media_type: type,
                    media_url,
                    historical: false,
                    participantJid,
                    status: isSentByMe ? 'sent' : 'read',
                    canonicalSenderName: isSentByMe ? 'Yo' : (pushName || senderId),
                    conversationName
                }
            }]).select('id, created_at');

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
    } finally {
        console.log(`[Media Worker] Archivo multimedia conservado para persistencia: ${tempFilePath}`);
    }
}, {
    connection: redisClient,
    concurrency: 2
});

mediaWorker.on('failed', (job, err) => {
    console.error(`[BullMQ-Media] Job ID ${job.id} fallo de forma critica:`, err.message);
});

console.log('[Media Worker] Listo y escuchando.');
