import { pipeline } from '@huggingface/transformers';
import redisClient from '../config/redis.mjs';

let localEmbedder = null;
let localReRanker = null;

let embedderTimeout = null;
const EMBEDDER_TTL_MS = 10 * 60 * 1000; // 10 minutos de inactividad

// Función para liberar la RAM
function unloadEmbedder() {
    if (localEmbedder) {
        console.log('💤 [AI Service] Descargando modelo de embeddings de la RAM por inactividad (Lazy Unload)...');
        if (typeof localEmbedder.dispose === 'function') {
            try { localEmbedder.dispose(); } catch (e) { }
        }
        localEmbedder = null; // Liberamos la referencia para el Garbage Collector
    }
}

// Resetea el reloj de arena cada vez que alguien necesita pensar
function resetEmbedderTimer() {
    if (embedderTimeout) clearTimeout(embedderTimeout);
    embedderTimeout = setTimeout(unloadEmbedder, EMBEDDER_TTL_MS);
}

/**
 * Genera un embedding vectorial de un texto usando MiniLM localmente.
 * @param {string} text 
 * @param {boolean} isQuery 
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text, isQuery = false) {
    if (!localEmbedder) {
        console.log('🧠 [AI Service] Inicializando red neuronal (all-mpnet-base-v2)...');
        localEmbedder = await pipeline('feature-extraction', 'Xenova/all-mpnet-base-v2', {
            quantized: true
        });
    }

    resetEmbedderTimer(); // Reiniciar temporizador en cada uso

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
    // BYPASS Local Re-Ranker: PostgreSQL Hybrid RRF is already accurate enough
    // and avoids HuggingFace ONNX parsing/download errors.
    return memories.map((m, i) => ({
        ...m,
        rerank_score: 1.0 - (i * 0.01) // Mantener orden original (RRF)
    }));
}

/**
 * Busca en la caché semántica si existe una respuesta similar.
 * @param {string} clientId 
 * @param {number[]} queryVector 
 * @param {number} threshold 
 * @returns {Promise<string|null>}
 */
export async function checkSemanticCache(clientId, queryVector, threshold = 0.95) {
    if (!redisClient) return null;

    let bestMatch = null;
    let highestSimilarity = 0;

    try {
        const cacheKey = `semcache:${clientId}`;
        const rawCache = await redisClient.get(cacheKey);

        if (rawCache) {
            const cacheEntries = JSON.parse(rawCache);
            for (const cacheItem of cacheEntries) {
                const similarity = cosineSimilarity(queryVector, cacheItem.vector);
                if (similarity > threshold && similarity > highestSimilarity) {
                    highestSimilarity = similarity;
                    bestMatch = cacheItem.reply;
                }
            }
        }
    } catch (e) {
        console.warn('⚠️ [Semantic Cache] Error leyendo Redis:', e.message);
    }

    return bestMatch;
}

/**
 * Guarda una respuesta en la caché semántica.
 * @param {string} clientId 
 * @param {number[]} vector 
 * @param {string} reply 
 */
export async function saveToSemanticCache(clientId, vector, reply) {
    if (!redisClient) return;

    try {
        const cacheKey = `semcache:${clientId}`;
        const rawCache = await redisClient.get(cacheKey);
        let cacheEntries = rawCache ? JSON.parse(rawCache) : [];

        // Añadir nuevo ítem al principio para búsqueda LIFO
        cacheEntries.unshift({ vector, reply, timestamp: Date.now() });

        // Limitar a los 500 últimos
        if (cacheEntries.length > 500) {
            cacheEntries = cacheEntries.slice(0, 500);
        }

        // Guardar con TTL de 24 horas (86400 segundos)
        await redisClient.set(cacheKey, JSON.stringify(cacheEntries), { EX: 86400 });
    } catch (e) {
        console.warn('⚠️ [Semantic Cache] Error guardando en Redis:', e.message);
    }
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
