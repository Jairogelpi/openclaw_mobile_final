import 'dotenv/config';
import fs from 'fs/promises';
import { Worker } from 'bullmq';
import { mediaQueue, incomingQueue } from './config/queues.mjs';
import redisClient from './config/redis.mjs';
import supabase from './config/supabase.mjs';
import { transcribeAudio, analyzeImage, extractFileText } from './utils/media.mjs';

console.log('🎧 [Media Worker] Iniciando servicio del "Oído" (Media Ingestion)...');

const mediaWorker = new Worker('mediaProcessingQueue', async (job) => {
    const {
        clientId, clientSlug, senderId, participantJid, isSentByMe,
        pushName, isGroup, text, type, tempFilePath,
        mimetype, filename
    } = job.data;

    console.log(`\n======================================================`);
    console.log(`[Queue-Media] 📥 Procesando archivo multimedia de ${clientSlug}...`);
    console.log(`📎 Tipo: ${type} | Archivo temporal: ${tempFilePath}`);

    let mediaDescription = '';

    try {
        // Enviar a Groq (Whisper para Audio, Vision para Imagen)
        if (type === 'audio') {
            mediaDescription = await transcribeAudio(tempFilePath);
        } else if (type === 'image') {
            mediaDescription = await analyzeImage(tempFilePath);
        } else if (type === 'document') {
            mediaDescription = await extractFileText(tempFilePath, mimetype, filename);
        }

        // Combinar con texto original (si el clip o imagen venía con un pie de foto)
        const finalText = [mediaDescription, text].filter(Boolean).join(' ');

        if (finalText) {
            console.log(`[Queue-Media] 🗣️ Transcripción/Análisis completado. Guardando en DB y encolando...`);

            // Build the media URL (served from /uploads/ static route)
            const mediaFileName = tempFilePath.replace('./uploads/', '');
            const media_url = `/uploads/${mediaFileName}`;

            // 💾 GUARDAR EN DB (Persistencia de Media Procesado)
            const { error: dbErr, data: insertedRows } = await supabase.from('raw_messages').insert([{
                client_id: clientId,
                sender_role: isSentByMe ? 'user_sent' : (pushName || senderId),
                content: finalText,
                remote_id: senderId,
                metadata: {
                    pushName,
                    isGroup,
                    hasMedia: true,
                    mediaType: type,
                    media_type: type,
                    media_url: media_url,
                    historical: false,
                    participantJid,
                    status: isSentByMe ? 'sent' : 'read'
                }
            }]).select('id, created_at');

            if (dbErr) console.error(`[Queue-Media] ❌ DB Error:`, dbErr.message);

            // 🔴 BROADCAST: Real-time WebSocket event for media messages
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
                        media_url: media_url,
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

            // ⏳ ACTIVAR TEMPORIZADOR DE MEMORIA (Trigger Memory Worker)
            await redisClient.set(`idle:${clientId}`, 'process', { EX: 60 });
            console.log(`[Queue-Media] ⏳ Reloj de memoria activado para ${clientId}.`);

            // Empujamos el texto crudo simulando un mensaje de WhatsApp normal
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
            console.log(`[Queue-Media] ✅ Exito! Texto enrutado al Cerebro.`);
        } else {
            console.log(`[Queue-Media] ℹ️ Media vacío o ilegible, ignorando enrutamiento.`);
        }

    } catch (err) {
        console.error(`❌ [Media Worker] Error procesando media de ${clientSlug}:`, err.message);
        throw err; // El trabajo fallará y BullMQ lo reintentará
    } finally {
        // [MODIFIED] Mantenemos el archivo para que el dashboard y el RAG puedan acceder a él
        console.log(`[Media Worker] Archivo multimedia conservado para persistencia: ${tempFilePath}`);
    }
}, {
    connection: redisClient,
    concurrency: 2 // Procesar máximo 2 transcripciones a la vez para no sobrecargar el ancho de banda
});

mediaWorker.on('failed', (job, err) => {
    console.error(`[BullMQ-Media] 💥 Job ID ${job.id} falló de forma crítica:`, err.message);
});

console.log('🌟 [Media Worker] Listo y escuchando. Esperando notas de voz o imágenes...');
