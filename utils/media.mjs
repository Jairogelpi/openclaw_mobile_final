import fs from 'fs/promises';
import { createReadStream } from 'fs';
import groq from '../services/groq.mjs';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse'); // FIXED named export for v2.4.5
import * as xlsx from 'xlsx';
import mammoth from 'mammoth';

/**
 * Transcribe any audio file to text using Groq Whisper.
 */
export async function transcribeAudio(filePath) {
    let tempPathWithExt = `${filePath}.m4a`;
    try {
        const stats = await fs.stat(filePath);
        console.log(`[Media-Audio] 🎤 Transcribiendo ${filePath} (${stats.size} bytes)`);

        await fs.rename(filePath, tempPathWithExt);

        const transcription = await groq.audio.transcriptions.create({
            file: createReadStream(tempPathWithExt),
            model: 'whisper-large-v3',
            response_format: 'json',
            language: 'es',
        }, { timeout: 120000 }); // Aumentado a 2 minutos para audios largos

        console.log(`[Media-Audio] ✅ Éxito: "${transcription.text.substring(0, 30)}..."`);
        return transcription.text;
    } catch (err) {
        console.error('[Media-Audio] ❌ Error:', err.message);
        return `[Error en audio: ${err.message}]`;
    } finally {
        try { await fs.unlink(tempPathWithExt); } catch (e) { }
    }
}

/**
 * Analyze any image file using Groq Vision.
 */
export async function analyzeImage(filePath) {
    try {
        const data = await fs.readFile(filePath, { encoding: 'base64' });
        console.log(`[Media-Vision] 🖼️ Analizando imagen: ${filePath}`);

        const response = await groq.chat.completions.create({
            model: 'llama-3.2-11b-vision-preview',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: `Describe esta imagen detalladamente para un sistema de memoria a largo plazo. 
                            Incluye:
                            1. Objetos y personas presentes.
                            2. Texto legible (OCR), números o fechas.
                            3. Contexto aparente (es una factura, una foto familiar, un pantallazo de chat, un esquema técnico).
                            4. Colores y ambiente.
                            Responde en español, de forma estructurada pero fluida.`
                        },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }
                    ]
                }
            ],
            max_tokens: 512,
            temperature: 0.2
        });

        const description = response.choices[0].message.content;
        console.log(`[Media-Vision] ✅ Éxito: "${description.substring(0, 40)}..."`);
        return description;
    } catch (err) {
        console.error('[Media-Vision] ❌ Error:', err.message);
        return "[Error analizando la imagen]";
    }
}

/**
 * Extract text from documents (PDF, Docx, Excel, CSV, TXT).
 */
export async function extractFileText(filePath, mimeType, originalName) {
    try {
        mimeType = mimeType?.toLowerCase() || '';
        const name = originalName?.toLowerCase() || '';

        console.log(`[Media-Doc] 📄 Extrayendo texto de ${name} (${mimeType})`);

        if (mimeType.includes('pdf') || name.endsWith('.pdf')) {
            const dataBuffer = await fs.readFile(filePath);
            const data = await PDFParse(dataBuffer); // FIXED call
            return data.text;
        } else if (mimeType.includes('word') || name.endsWith('.docx')) {
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value;
        } else if (mimeType.includes('sheet') || mimeType.includes('excel') || name.endsWith('.xlsx') || name.endsWith('.xls')) {
            const workbook = xlsx.readFile(filePath);
            let text = '';
            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                text += `\n--- Hoja: ${sheetName} ---\n`;
                text += xlsx.utils.sheet_to_txt(sheet);
            });
            return text;
        } else if (mimeType.includes('text') || mimeType.includes('csv') || name.endsWith('.txt') || name.endsWith('.csv')) {
            return await fs.readFile(filePath, 'utf8');
        } else if (mimeType.includes('json') || name.endsWith('.json')) {
            const content = await fs.readFile(filePath, 'utf8');
            return `JSON Content:\n${content}`;
        }

        return `[Archivo "${originalName}" de tipo ${mimeType} - No extraíble dinámicamente]`;
    } catch (error) {
        console.error('[Media-Doc] ❌ Error:', error.message);
        return `[Error extrayendo texto de ${originalName}: ${error.message}]`;
    }
}

import { chunkAndContextualize } from './chunker.mjs';

/**
 * UNIFIED WRAPPER: Processes any attachment and returns a text representation.
 * @param {Object} attachment - { type, data, path, mimetype, filename }
 */
export async function processAttachment(attachment) {
    const { type, path, mimetype, filename, data } = attachment;

    // Si viene 'data' (base64) pero no path, creamos archivo temporal para los extractores que lo necesiten
    let localPath = path;
    let isTemp = false;

    if (!localPath && data) {
        isTemp = true;
        const base64Data = data.replace(/^data:.*?;base64,/, '');
        localPath = `/tmp/media_${Date.now()}_${filename || 'file'}`;
        await fs.mkdir('/tmp', { recursive: true }).catch(() => { });
        await fs.writeFile(localPath, Buffer.from(base64Data, 'base64'));
    }

    if (!localPath) return { text: "[Error: No se pudo localizar el archivo]", chunks: [] };

    try {
        let text = "";
        let chunks = [];

        if (type === 'audio' || mimetype?.includes('audio')) {
            text = await transcribeAudio(localPath);
            return { text: `[🎤 Audio Transcrito: "${text}"]`, chunks: [] };
        } else if (type === 'image' || mimetype?.includes('image')) {
            text = await analyzeImage(localPath);
            return { text: `[🖼️ Imagen Analizada: "${text}"]`, chunks: [] };
        } else {
            // Documento: Aplicar RAG V5 (Recuperación Contextual)
            const fullText = await extractFileText(localPath, mimetype || '', filename || 'documento');

            // Si el documento es largo (> 1000 palabras), lo fragmentamos
            if (fullText.split(/\s+/).length > 800) {
                console.log(`[Media-Doc] 🧩 Documento largo detectado. Iniciando Fragmentación Contextual (V5)...`);
                chunks = await chunkAndContextualize(fullText, { filename, mimetype });

                // Para la respuesta inmediata, devolvemos un resumen inicial
                const summary = chunks.length > 0 ? chunks[0].contextualized.substring(0, 500) : fullText.substring(0, 500);
                return {
                    text: `[📄 Documento largo "${filename}" procesado con RAG V5. Fragmentos extraídos: ${chunks.length}. Resumen inicial: "${summary}..."]`,
                    chunks: chunks
                };
            } else {
                return { text: `[📄 Archivo "${filename || 'adjunto'}": ${fullText}]`, chunks: [] };
            }
        }
    } finally {
        if (isTemp) {
            await fs.unlink(localPath).catch(() => { });
        }
    }
}
