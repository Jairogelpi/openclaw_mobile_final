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
        clientId, clientSlug, senderId, isSentByMe,
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

            // 💾 GUARDAR EN DB (Persistencia de Media Procesado)
            const { error: dbErr } = await supabase.from('raw_messages').insert([{
                client_id: clientId,
                sender_role: isSentByMe ? 'user_sent' : (pushName || senderId),
                content: finalText,
                remote_id: senderId,
                metadata: {
                    pushName,
                    isGroup,
                    hasMedia: true,
                    mediaType: type,
                    historical: false
                }
            }]);

            if (dbErr) console.error(`[Queue-Media] ❌ DB Error:`, dbErr.message);

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
        // Limpiamos el archivo temporal (Oído limpio)
        try {
            await fs.unlink(tempFilePath);
            console.log(`🧹 [Media Worker] Archivo temporal limpiado: ${tempFilePath}`);
        } catch (unlinkErr) {
            console.warn(`[Queue-Media] ⚠️ Error limpiando ${tempFilePath}:`, unlinkErr.message);
        }
    }
}, {
    connection: redisClient,
    concurrency: 2 // Procesar máximo 2 transcripciones a la vez para no sobrecargar el ancho de banda
});

mediaWorker.on('failed', (job, err) => {
    console.error(`[BullMQ-Media] 💥 Job ID ${job.id} falló de forma crítica:`, err.message);
});

console.log('🌟 [Media Worker] Listo y escuchando. Esperando notas de voz o imágenes...');
