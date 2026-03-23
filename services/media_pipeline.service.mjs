import crypto from 'node:crypto';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createRequire } from 'module';
import path from 'node:path';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';

import groq from './groq.mjs';
import { chunkAndContextualize } from '../utils/chunker.mjs';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

const TEMP_MEDIA_DIR = path.join(process.cwd(), 'uploads', 'tmp');

function normalizeText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function lower(value = '') {
    return String(value || '').trim().toLowerCase();
}

async function ensureTempDir() {
    await fs.mkdir(TEMP_MEDIA_DIR, { recursive: true });
}

function inferMimeTypeFromFilename(filename = '', fallback = 'application/octet-stream') {
    const ext = path.extname(String(filename || '')).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.txt') return 'text/plain';
    if (ext === '.csv') return 'text/csv';
    return fallback;
}

function buildImageMimeType(filePath = '', fallback = 'image/jpeg') {
    const inferred = inferMimeTypeFromFilename(filePath, fallback);
    return inferred.startsWith('image/') ? inferred : fallback;
}

async function materializeAttachmentToTempFile({ data, filename = 'file.bin' } = {}) {
    const base64Data = String(data || '').replace(/^data:.*?;base64,/, '');
    if (!base64Data) {
        throw new Error('Attachment base64 payload is empty');
    }

    await ensureTempDir();
    const safeFilename = path.basename(String(filename || 'file.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempPath = path.join(TEMP_MEDIA_DIR, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeFilename}`);
    await fs.writeFile(tempPath, Buffer.from(base64Data, 'base64'));
    return tempPath;
}

async function ensureAudioTranscriptionPath(filePath = '') {
    if (filePath.endsWith('.m4a')) {
        return { transcriptionPath: filePath, cleanupTempCopy: false };
    }

    const transcriptionPath = `${filePath}.m4a`;
    await fs.copyFile(filePath, transcriptionPath);
    return { transcriptionPath, cleanupTempCopy: true };
}

export async function transcribeAudioFile(filePath, { timeoutMs = 120000, language = 'es' } = {}) {
    if (!filePath) throw new Error('filePath is required for audio transcription');

    const { transcriptionPath, cleanupTempCopy } = await ensureAudioTranscriptionPath(filePath);
    try {
        const transcription = await groq.audio.transcriptions.create({
            file: createReadStream(transcriptionPath),
            model: 'whisper-large-v3',
            response_format: 'json',
            language
        }, { timeout: timeoutMs });

        return normalizeText(transcription?.text || '');
    } finally {
        if (cleanupTempCopy) {
            await fs.unlink(transcriptionPath).catch(() => { });
        }
    }
}

export async function analyzeImageFile(filePath) {
    if (!filePath) throw new Error('filePath is required for image analysis');

    const data = await fs.readFile(filePath, { encoding: 'base64' });
    const mimeType = buildImageMimeType(filePath);
    const response = await groq.chat.completions.create({
        model: 'llama-3.2-90b-vision-preview',
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: 'Describe esta imagen con detalle util para memoria personal. Resume personas, lugares, objetos, acciones, texto visible y tono si son visibles.'
                },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
            ]
        }],
        temperature: 0.2,
        max_tokens: 512
    });

    return normalizeText(response?.choices?.[0]?.message?.content || '');
}

export async function extractDocumentText(filePath, mimeType = '', originalName = '') {
    if (!filePath) throw new Error('filePath is required for document extraction');

    const safeName = String(originalName || path.basename(filePath || 'archivo'));
    const lowerName = lower(safeName);
    const safeMime = lower(mimeType);

    if (safeMime.includes('pdf') || lowerName.endsWith('.pdf')) {
        const dataBuffer = await fs.readFile(filePath);
        const data = await pdf(dataBuffer);
        return normalizeText(data?.text || '');
    }

    if (safeMime.includes('word') || lowerName.endsWith('.docx')) {
        const result = await mammoth.extractRawText({ path: filePath });
        return normalizeText(result?.value || '');
    }

    if (safeMime.includes('sheet') || safeMime.includes('excel') || lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
        const workbook = xlsx.readFile(filePath);
        const text = workbook.SheetNames.map(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            return `--- Sheet: ${sheetName} ---\n${xlsx.utils.sheet_to_txt(sheet)}`;
        }).join('\n');
        return normalizeText(text);
    }

    if (safeMime.includes('text') || safeMime.includes('csv') || lowerName.endsWith('.txt') || lowerName.endsWith('.csv')) {
        const text = await fs.readFile(filePath, 'utf8');
        return normalizeText(text);
    }

    if (safeMime.includes('json') || lowerName.endsWith('.json')) {
        const text = await fs.readFile(filePath, 'utf8');
        return normalizeText(text);
    }

    return '';
}

export async function enrichMediaFile({ filePath, mediaType, mimeType = '', originalName = '', cleanup = false } = {}) {
    const type = lower(mediaType);
    if (!type || !filePath) {
        return { semanticText: '', enrichmentKind: 'none' };
    }

    try {
        if (type === 'audio') {
            const semanticText = await transcribeAudioFile(filePath);
            return { semanticText, enrichmentKind: 'transcription' };
        }

        if (type === 'image') {
            const semanticText = await analyzeImageFile(filePath);
            return { semanticText, enrichmentKind: 'vision' };
        }

        if (type === 'document') {
            const semanticText = await extractDocumentText(filePath, mimeType, originalName);
            return { semanticText, enrichmentKind: 'document_text' };
        }

        return { semanticText: '', enrichmentKind: 'unsupported' };
    } finally {
        if (cleanup) {
            await fs.unlink(filePath).catch(() => { });
        }
    }
}

export async function processAttachment(attachment = {}) {
    const { type, path: providedPath, mimetype, filename, data } = attachment;
    let localPath = providedPath;
    let ownsTempFile = false;

    if (!localPath && data) {
        localPath = await materializeAttachmentToTempFile({ data, filename });
        ownsTempFile = true;
    }

    if (!localPath) {
        return { text: '[Error: No se pudo localizar el archivo]', chunks: [] };
    }

    try {
        const normalizedType = lower(type);
        const normalizedMime = lower(mimetype);

        if (normalizedType === 'audio' || normalizedMime.includes('audio')) {
            const text = await transcribeAudioFile(localPath);
            return { text: `[Audio Transcrito: "${text}"]`, chunks: [] };
        }

        if (normalizedType === 'image' || normalizedMime.includes('image')) {
            const text = await analyzeImageFile(localPath);
            return { text: `[Imagen Analizada: "${text}"]`, chunks: [] };
        }

        const fullText = await extractDocumentText(localPath, mimetype || '', filename || 'documento');
        if (fullText.split(/\s+/).filter(Boolean).length > 800) {
            const chunks = await chunkAndContextualize(fullText, { filename, mimetype });
            const summary = chunks.length > 0
                ? chunks[0].contextualized.substring(0, 500)
                : fullText.substring(0, 500);

            return {
                text: `[Documento largo "${filename}" procesado con RAG V5. Fragmentos extraidos: ${chunks.length}. Resumen inicial: "${summary}..."]`,
                chunks
            };
        }

        return { text: `[Archivo "${filename || 'adjunto'}": ${fullText}]`, chunks: [] };
    } finally {
        if (ownsTempFile) {
            await fs.unlink(localPath).catch(() => { });
        }
    }
}
