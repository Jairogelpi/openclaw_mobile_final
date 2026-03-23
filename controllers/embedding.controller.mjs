import { generateEmbedding } from '../services/local_ai.mjs';

export const EmbeddingController = {
    /**
     * Handles embedding requests from other containers.
     */
    async handleEmbed(req, res) {
        const { text, isQuery } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });

        try {
            // This will call the LOCAL generateEmbedding in THIS instance
            // We must ensure this instance does NOT have OPENCLAW_CENTRAL_EMBEDDING_URL set to itself
            const vector = await generateEmbedding(text, isQuery);
            return res.json({ vector });
        } catch (err) {
            console.error('[EmbeddingServer] Error generating vector:', err.message);
            return res.status(500).json({ error: err.message });
        }
    }
};
