import { pipeline } from '@huggingface/transformers';
import { LRUCache } from 'lru-cache';

// === CACHÉ SEMÁNTICA ===
const semanticCache = new LRUCache({
    max: 500,
    ttl: 1000 * 60 * 60 * 24 // 24 hours
});

let localEmbedder = null;
let localReRanker = null;

/**
 * Genera un embedding vectorial de un texto usando MiniLM localmente.
 * @param {string} text 
 * @param {boolean} isQuery 
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text, isQuery = false) {
    if (!localEmbedder) {
        console.log('🧠 [AI Service] Inicializando red neuronal (Nomic-Embed-Text-v1.5)...');
        localEmbedder = await pipeline('feature-extraction', 'Xenova/nomic-embed-text-v1.5', {
            quantized: true
        });
    }
    const prefix = isQuery ? 'search_query: ' : 'search_document: ';
    const output = await localEmbedder(prefix + text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

/**
 * Re-clasifica una lista de memorias según su relevancia con la consulta.
 * @param {string} query 
 * @param {Array} memories 
 * @returns {Promise<Array>}
 */
export async function reRankMemories(query, memories) {
    if (!memories || memories.length === 0) return [];

    if (!localReRanker) {
        console.log('🧠 [AI Service] Inicializando Re-Ranker (bge-reranker-base)...');
        localReRanker = await pipeline('text-classification', 'Xenova/bge-reranker-base', {
            quantized: true
        });
    }

    const pairs = memories.map(m => [query, m.content]);
    const scores = await localReRanker(pairs);

    const rankedMemories = memories.map((m, i) => ({
        ...m,
        rerank_score: scores[i].score
    }));

    rankedMemories.sort((a, b) => b.rerank_score - a.rerank_score);
    return rankedMemories;
}

/**
 * Busca en la caché semántica si existe una respuesta similar.
 * @param {string} clientId 
 * @param {number[]} queryVector 
 * @param {number} threshold 
 * @returns {string|null}
 */
export function checkSemanticCache(clientId, queryVector, threshold = 0.95) {
    const cacheKeyPrefix = `${clientId}_`;
    let bestMatch = null;
    let highestSimilarity = 0;

    for (const [key, cacheItem] of semanticCache.entries()) {
        if (key.startsWith(cacheKeyPrefix)) {
            const similarity = cosineSimilarity(queryVector, cacheItem.vector);
            if (similarity > threshold && similarity > highestSimilarity) {
                highestSimilarity = similarity;
                bestMatch = cacheItem.reply;
            }
        }
    }
    return bestMatch;
}

/**
 * Guarda una respuesta en la caché semántica.
 * @param {string} clientId 
 * @param {number[]} vector 
 * @param {string} reply 
 */
export function saveToSemanticCache(clientId, vector, reply) {
    const key = `${clientId}_${Date.now()}`;
    semanticCache.set(key, { vector, reply });
}

/**
 * Calcula la similitud de coseno entre dos vectores.
 */
export function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
}
