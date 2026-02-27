import fs from 'fs/promises';
import { createReadStream } from 'fs';
import groq from '../services/groq.mjs';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import * as xlsx from 'xlsx';
import mammoth from 'mammoth';

export async function transcribeAudio(filePath) {
    let tempPathWithExt = `${filePath}.m4a`;
    try {
        const stats = await fs.stat(filePath);
        console.log(`[Transcription] 🎤 Starting transcription for ${filePath} (${stats.size} bytes)`);

        await fs.rename(filePath, tempPathWithExt);

        // Add timeout to Groq call
        const transcription = await groq.audio.transcriptions.create({
            file: createReadStream(tempPathWithExt),
            model: 'whisper-large-v3',
            response_format: 'json',
            language: 'es',
        }, { timeout: 30000 }); // 30 second timeout

        console.log(`[Transcription] ✅ Success: "${transcription.text.substring(0, 30)}..."`);
        return transcription.text;
    } catch (err) {
        console.error('[Transcription Tool] ❌ Error:', err.message);
        if (err.message.includes('timeout')) {
            return "[Error: Tiempo de espera agotado en la transcripción. Por favor, intenta de nuevo.]";
        }
        throw err;
    } finally {
        // Always attempt to cleanup
        await fs.unlink(tempPathWithExt).catch(() => { });
    }
}

export async function analyzeImage(filePath) {
    try {
        const data = await fs.readFile(filePath, { encoding: 'base64' });
        const response = await groq.chat.completions.create({
            model: 'llama-3.2-11b-vision-preview',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: "Describe esta imagen detalladamente para que una IA la use como contexto de la vida del usuario." },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }
                    ]
                }
            ]
        });
        return response.choices[0].message.content;
    } catch (err) {
        console.error('[Vision Tool] Error:', err.message);
        return "[Error analizando la imagen]";
    }
}

export async function extractFileText(filePath, mimeType, originalName) {
    try {
        if (mimeType.includes('pdf') || originalName.toLowerCase().endsWith('.pdf')) {
            const dataBuffer = await fs.readFile(filePath);
            const data = await pdf(dataBuffer);
            return data.text;
        } else if (mimeType.includes('word') || originalName.toLowerCase().endsWith('.docx')) {
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value;
        } else if (mimeType.includes('sheet') || originalName.toLowerCase().endsWith('.xlsx') || originalName.toLowerCase().endsWith('.xls')) {
            const workbook = xlsx.readFile(filePath);
            let text = '';
            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                text += `\n--- Sheet: ${sheetName} ---\n`;
                text += xlsx.utils.sheet_to_txt(sheet);
            });
            return text;
        } else if (mimeType.includes('text') || originalName.toLowerCase().endsWith('.txt') || originalName.toLowerCase().endsWith('.csv')) {
            return await fs.readFile(filePath, 'utf8');
        }
        return `[Contenido del archivo ${originalName} no extraíble directamente]`;
    } catch (error) {
        console.error('Error extracting text:', error);
        return `[Error extrayendo texto de ${originalName}]`;
    }
}
