import {
    analyzeImageFile,
    extractDocumentText,
    processAttachment,
    transcribeAudioFile
} from '../services/media_pipeline.service.mjs';

export { processAttachment };

export async function transcribeAudio(filePath) {
    try {
        return await transcribeAudioFile(filePath, { timeoutMs: 120000 });
    } catch (err) {
        console.error('[Media-Audio] Error:', err.message);
        return `[Error en audio: ${err.message}]`;
    }
}

export async function analyzeImage(filePath) {
    try {
        return await analyzeImageFile(filePath);
    } catch (err) {
        console.error('[Media-Vision] Error:', err.message);
        return '[Error analizando la imagen]';
    }
}

export async function extractFileText(filePath, mimeType, originalName) {
    try {
        return await extractDocumentText(filePath, mimeType, originalName);
    } catch (err) {
        console.error('[Media-Doc] Error:', err.message);
        return `[Error extrayendo texto de ${originalName}: ${err.message}]`;
    }
}
