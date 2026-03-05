import fs from 'fs/promises';
import path from 'path';
import { transcribeAudio } from '../utils/media.mjs';

/**
 * Skill: Recall Media
 * Permite a la IA descargar y analizar un archivo multimedia histórico (foto o audio)
 * bajo demanda, usando su Message ID, sin saturar la DB ni la API con todo el historial.
 */
export default {
    name: 'recall_media',
    description: 'Use this skill to extract the content/description of old images or audios explicitly mentioned in memory as [Imagen: ID] or [Audio: ID]. ONLY use this if you REALLY need to know what the image or audio was about to answer the user.',
    parameters: {
        type: 'object',
        properties: {
            remoteJid: {
                type: 'string',
                description: 'El ID del chat de WhatsApp (ej. 12345678@s.whatsapp.net o 12345678-123@g.us)'
            },
            messageId: {
                type: 'string',
                description: 'El Message ID extraído del tag [Imagen: MSG_ID] o [Audio: MSG_ID]'
            }
        },
        required: ['remoteJid', 'messageId']
    },
    async execute(params, context) {
        const { remoteJid, messageId } = params;
        const { clientId, clientSlug } = context;

        if (!clientId) {
            return `[Recall Media Error] Missing clientId in context.`;
        }

        try {
            console.log(`[Skill: recall_media] 🔍 AI solicitó análisis diferido de ${messageId} en ${remoteJid}`);

            // Llamar al endpoint interno de la API (Gateway)
            const response = await fetch(`http://localhost:3000/rpc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    method: 'whatsapp.fetchMedia',
                    params: { remoteJid, messageId, clientId },
                    id: Date.now()
                })
            });

            const rawData = await response.json();

            if (rawData.error) {
                return `[Recall Media Error] ${rawData.error.message}`;
            }

            const { mediaType, mimeType, data: base64Data } = rawData.result;

            if (!base64Data) {
                return `[Recall Media Error] Extracción exitosa, pero el buffer estaba vacío.`;
            }

            console.log(`[Skill: recall_media] 📦 Buffer de ${mediaType} recibido. Analizando...`);
            const buffer = Buffer.from(base64Data, 'base64');

            // 1) AUDIO: Whisper
            if (mediaType === 'audio' || mediaType === 'video') {
                const tempFile = path.join(process.cwd(), 'uploads', `lazy_${messageId}.ogg`);
                await fs.writeFile(tempFile, buffer);
                try {
                    const text = await transcribeAudio(tempFile);
                    await fs.unlink(tempFile).catch(() => null);
                    return text ? `[Audio Transcrito]: "${text}"` : `[Audio Analizado]: Solo ruido o silencio.`;
                } catch (transErr) {
                    await fs.unlink(tempFile).catch(() => null);
                    return `[Audio Transcription Error] ${transErr.message}`;
                }
            }

            // 2) IMAGEN: Llama Vision (Groq)
            if (mediaType === 'image') {
                const { processAttachment } = await import('../utils/media.mjs');
                const tempFile = path.join(process.cwd(), 'uploads', `lazy_${messageId}.jpg`);
                await fs.writeFile(tempFile, buffer);
                try {
                    const analysis = await processAttachment({
                        path: tempFile,
                        mimetype: mimeType,
                        filename: `lazy_${messageId}.jpg`,
                        type: 'image'
                    });
                    await fs.unlink(tempFile).catch(() => null);
                    return `[Descripción de Imagen]: ${analysis.text}`;
                } catch (visErr) {
                    await fs.unlink(tempFile).catch(() => null);
                    return `[Vision Analysis Error] ${visErr.message}`;
                }
            }

            // 3) DOCUMENTO
            return `[Documento] Tipo Mime: ${mimeType}. No se puede extraer el texto bajo demanda aún.`;

        } catch (e) {
            return `[Recall Media Error] ${e.message}`;
        }
    }
};
