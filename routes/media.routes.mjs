import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import { processAttachment, transcribeAudioFile } from '../services/media_pipeline.service.mjs';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

/**
 * @route POST /api/media/transcribe
 * @desc Transcribe audio files using Whisper (local or via service)
 */
router.post('/transcribe', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) throw new Error('No audio file provided');
        if (req.file.size === 0) throw new Error('Audio file is empty');

        console.log(`[Transcription] Processing file: ${req.file.originalname} (${req.file.size} bytes)`);
        const text = await transcribeAudioFile(req.file.path, { timeoutMs: 120000 });

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
});

/**
 * @route POST /api/media/analyze-file
 * @desc Analyze documents or images for text extraction
 */
router.post('/analyze-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

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
});

export default router;
