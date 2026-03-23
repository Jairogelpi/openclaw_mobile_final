import express from 'express';
import { EmbeddingController } from '../controllers/embedding.controller.mjs';

const router = express.Router();

/**
 * Internal route for embedding generation.
 * Protected by common sense and (optional) internal token.
 */
router.post('/embed', EmbeddingController.handleEmbed);

export default router;
