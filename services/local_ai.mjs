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
 * Re-clasifica memorias usando similitud coseno REAL contra el vector de la query.
 * OPTIMIZADO: Usa el score RRF existente como base y solo genera embeddings
 * para candidatos de grafo que no tienen uno (cap de 10 máximo).
 * @param {string} query - Texto original de la consulta
 * @param {Array} memories - Candidatos del hybrid+graph search
 * @param {number[]} queryVector - Vector pre-computado de la query (opcional)
 * @returns {Promise<Array>}
 */
export async function reRankMemories(query, memories, queryVector = null) {
    if (!memories || memories.length === 0) return [];

    // Generar el vector de la query si no se proporcionó
    const qVec = queryVector || await generateEmbedding(query, true);

    let onTheFlyCount = 0;
    const MAX_ON_THE_FLY = 10; // Cap para evitar bloqueo de CPU

    // Computar similitud coseno REAL para cada candidato
    const scored = await Promise.all(memories.map(async (m) => {
        let score = m.similarity || 0; // Base: score RRF de PostgreSQL

        // Si la memoria tiene embedding guardado, usarlo para re-rank preciso
        if (m.embedding && Array.isArray(m.embedding)) {
            score = cosineSimilarity(qVec, m.embedding);
        } else if (m.content && onTheFlyCount < MAX_ON_THE_FLY) {
            // Solo generar embedding en caliente para un número limitado de candidatos
            try {
                onTheFlyCount++;
                const memVec = await generateEmbedding(m.content);
                score = cosineSimilarity(qVec, memVec);
            } catch (e) {
                // Mantener score original si falla
            }
        }
        // Si ya superamos el cap, mantener el score RRF original (ya normalizado)

        return { ...m, rerank_score: score };
    }));

    // Ordenar por score real descendente
    scored.sort((a, b) => b.rerank_score - a.rerank_score);
    return scored;
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
 * @param {string} query 
 * @param {string} reply 
 */
export async function saveToSemanticCache(clientId, vector, query, reply) {
    if (!redisClient) return;

    try {
        const cacheKey = `semcache:${clientId}`;
        const rawCache = await redisClient.get(cacheKey);
        let cacheEntries = rawCache ? JSON.parse(rawCache) : [];

        // Añadir nuevo ítem al principio para búsqueda LIFO
        cacheEntries.unshift({ vector, query, reply, timestamp: Date.now() });

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
 * Invalida la caché semántica de un cliente cuando se ingieren nuevos recuerdos.
 * Esto evita que respuestas "No tengo información" queden cacheadas permanentemente.
 */
export async function invalidateSemanticCache(clientId) {
    if (!redisClient) return;
    try {
        const cacheKey = `semcache:${clientId}`;
        await redisClient.del(cacheKey);
        console.log(`🗑️ [Semantic Cache] Caché invalidada para ${clientId} (nuevos recuerdos ingresados).`);
    } catch (e) {
        console.warn('⚠️ [Semantic Cache] Error invalidando:', e.message);
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
