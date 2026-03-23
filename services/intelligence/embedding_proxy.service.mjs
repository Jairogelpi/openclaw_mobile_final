import axios from 'axios';

/**
 * Proxy service to delegate embedding generation to a central server.
 * Saves RAM by avoiding loading the ONNX model in every client container.
 */
export class EmbeddingProxyService {
    static async generateEmbedding(text, isQuery = false) {
        const url = process.env.OPENCLAW_CENTRAL_EMBEDDING_URL;
        if (!url) return null;

        try {
            const response = await axios.post(`${url}/embed`, {
                text,
                isQuery
            }, { timeout: 5000 });

            return response.data.vector;
        } catch (err) {
            console.warn(`[EmbeddingProxy] Central server failed: ${err.message}. Falling back to local.`);
            return null;
        }
    }
}
