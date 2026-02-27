import crypto from 'crypto';
import fs from 'fs/promises';
import JSON5 from 'json5';
import groq from '../services/groq.mjs';
import { extractJson } from '../utils/helpers.mjs';
import { transcribeAudio, analyzeImage } from '../utils/media.mjs';
import supabase from '../config/supabase.mjs';

export async function handleSoulGet(req, res, id) {
    const clientId = req.clientId;

    try {
        const { data, error } = await supabase
            .from('user_souls')
            .select('soul_json')
            .eq('client_id', clientId)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            return res.json({ result: null, id });
        }

        return res.json({ result: data.soul_json, id });
    } catch (err) {
        return res.status(500).json({ error: { message: err.message }, id });
    }
}

export async function handleSoulRefine(req, res, params, id, triggerMemoryTimer) {
    const clientId = req.clientId;
    const { feedback, currentSoul, attachments } = params;

    try {
        await triggerMemoryTimer(clientId);

        const REFINE_SYSTEM_PROMPT = `
Eres un modelador de Almas (Souls) de IA experto. Tu objetivo es refinar el JSON del alma de un asistente basándote en el feedback del usuario y cualquier contexto adicional proporcionado.

ALMA ACTUAL:
${JSON.stringify(currentSoul, null, 2)}

INSTRUCCIONES:
1. Lee el feedback del usuario atentamente.
2. Considera los "Observaciones del Sistema" (archivos/audios/imágenes) si los hay.
3. Devuelve UNICAMENTE el JSON actualizado con los cambios solicitados.
4. Mantén la estructura original del JSON.
5. NO añadas texto explicativo, solo el JSON.
`;

        const promptMessages = [{ role: 'system', content: REFINE_SYSTEM_PROMPT }];

        if (attachments && Array.isArray(attachments)) {
            for (const attachment of attachments) {
                try {
                    let additionalContext = "";
                    if (attachment.type === 'audio' && attachment.data) {
                        const tempId = crypto.randomUUID();
                        const tempFile = `uploads/temp_refine_audio_${tempId}`;
                        await fs.writeFile(tempFile, Buffer.from(attachment.data, 'base64'));
                        const text = await transcribeAudio(tempFile);
                        additionalContext = `[Sistema - Audio Transcrito: "${text}"]`;
                    } else if (attachment.type === 'image' && attachment.data) {
                        const tempId = crypto.randomUUID();
                        const tempFile = `uploads/temp_refine_img_${tempId}`;
                        await fs.writeFile(tempFile, Buffer.from(attachment.data, 'base64'));
                        const description = await analyzeImage(tempFile);
                        await fs.unlink(tempFile);
                        additionalContext = `[Sistema - Imagen Analizada: "${description}"]`;
                    } else if (attachment.text) {
                        additionalContext = `[Sistema - Documento/Análisis: "${attachment.text}"]`;
                    }

                    if (additionalContext) {
                        promptMessages.push({ role: 'system', content: additionalContext });
                    }
                } catch (err) {
                    console.error("Error processing refinement attachment:", err);
                }
            }
        }

        promptMessages.push({ role: 'user', content: feedback });

        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: promptMessages,
            temperature: 0.5,
            max_tokens: 1024
        });

        const reply = response.choices[0].message.content;
        const jsonStr = extractJson(reply);

        if (!jsonStr) throw new Error("Could not parse refined soul JSON");
        const refinedSoul = JSON5.parse(jsonStr);

        await supabase
            .from('user_souls')
            .upsert({
                client_id: clientId,
                soul_json: refinedSoul,
                last_updated: new Date()
            });

        return res.json({ result: refinedSoul, id });
    } catch (err) {
        return res.status(500).json({ error: { message: err.message }, id });
    }
}
