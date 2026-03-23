import fs from 'fs/promises';
import { transcribeAudio as transcribeAudioUtil } from '../utils/media.mjs';

/**
 * Transcribe audio files using Whisper.
 */
export async function handleTranscribe(req, res) {
    try {
        if (!req.file) throw new Error('No audio file provided');
        if (req.file.size === 0) throw new Error('Audio file is empty');

        console.log(`[Transcription] Processing file: ${req.file.originalname} (${req.file.size} bytes)`);
        const text = await transcribeAudioUtil(req.file.path);

        if (!text || text.trim().length === 0) {
            console.warn('[Transcription] Whisper returned empty text');
            return res.json({ text: "" });
        }

        res.json({ text });
    } catch (err) {
        console.error('[Transcription] Error:', err.message);
        res.status(500).json({ error: `Error de transcripción: ${err.message}` });
    } finally {
        if (req.file) {
            await fs.unlink(req.file.path).catch(() => { });
        }
    }
}

/**
 * Analyze documents or images for text extraction.
 */
export async function handleAnalyzeFile(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const { processAttachment } = await import('../utils/media.mjs');
        const attachmentResult = await processAttachment({
            path: req.file.path,
            mimetype: req.file.mimetype,
            filename: req.file.originalname,
            type: req.file.mimetype.includes('image') ? 'image' : 'document'
        });

        const resultText = attachmentResult.text;

        res.json({
            text: resultText,
            filename: req.file.originalname,
            mimetype: req.file.mimetype
        });
    } catch (error) {
        console.error('File analysis error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (req.file) {
            await fs.unlink(req.file.path).catch(() => { });
        }
    }
}
