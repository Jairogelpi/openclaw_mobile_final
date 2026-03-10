import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import redisClient from '../config/redis.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let embedderWorker = null;
let embedderTimeout = null;
const EMBEDDER_TTL_MS = Number(process.env.OPENCLAW_EMBEDDER_TTL_MS || (60 * 60 * 1000));
const EMBEDDER_KEEP_WARM = String(process.env.OPENCLAW_EMBEDDER_KEEP_WARM || 'true').toLowerCase() === 'true';
const WARMUP_CACHE_MS = 5 * 60 * 1000;
const WARMUP_TEXT = 'hola';
let messageIdCounter = 0;
const pendingRequests = new Map();
let lastWarmupAt = 0;
let warmupPromise = null;
const EMBEDDING_CACHE_MAX = Number(process.env.OPENCLAW_EMBEDDING_CACHE_MAX || 2000);
const embeddingCache = new Map();
const embeddingInFlight = new Map();
const embeddingRuntimeStats = {
    embedding_cache_hits: 0,
    embedding_cache_misses: 0,
    deferred_embedding_count: 0
};

function getCachedEmbedding(cacheKey) {
    if (!embeddingCache.has(cacheKey)) return null;
    const cached = embeddingCache.get(cacheKey);
    embeddingCache.delete(cacheKey);
    embeddingCache.set(cacheKey, cached);
    embeddingRuntimeStats.embedding_cache_hits += 1;
    return Array.isArray(cached) ? [...cached] : null;
}

function saveCachedEmbedding(cacheKey, vector) {
    if (!cacheKey || !Array.isArray(vector)) return;
    if (embeddingCache.has(cacheKey)) embeddingCache.delete(cacheKey);
    embeddingCache.set(cacheKey, [...vector]);
    while (embeddingCache.size > EMBEDDING_CACHE_MAX) {
        const oldestKey = embeddingCache.keys().next().value;
        if (!oldestKey) break;
        embeddingCache.delete(oldestKey);
    }
}

function failPendingRequests(error) {
    for (const [id, resolver] of pendingRequests.entries()) {
        resolver.reject(error instanceof Error ? error : new Error(String(error || 'Embedding worker failed')));
        pendingRequests.delete(id);
    }
}

function initWorker() {
    if (!embedderWorker) {
        console.log('🧠 [AI Service] Inicializando red neuronal en hilo dedicado (Worker Thread)...');
        embedderWorker = new Worker(path.join(__dirname, 'ai_worker.mjs'));

        embedderWorker.on('message', (msg) => {
            const resolver = pendingRequests.get(msg.id);
            if (resolver) {
                if (msg.error) resolver.reject(new Error(msg.error));
                else resolver.resolve(msg.vector || msg);
                pendingRequests.delete(msg.id);
            }
        });

        embedderWorker.on('error', (err) => {
            console.error('❌ [AI Worker] Error en hilo de embeddings:', err);
            failPendingRequests(err);
            embedderWorker = null;
        });

        embedderWorker.on('exit', (code) => {
            if (code !== 0) console.warn(`⚠️ [AI Worker] Hilo cerrado con código ${code}`);
            if (code !== 0) {
                failPendingRequests(new Error(`Embedding worker exited with code ${code}`));
            }
            embedderWorker = null;
        });
    }
}

// Función para liberar la RAM
function unloadEmbedder() {
    if (EMBEDDER_KEEP_WARM) return;
    if (embedderWorker) {
        console.log('💤 [AI Service] Descargando modelo de embeddings de la RAM por inactividad (Lazy Unload)...');
        embedderWorker.postMessage({ action: 'unload', id: ++messageIdCounter });
        // Optionally terminate the worker thread completely after unload
        setTimeout(() => {
            if (embedderWorker) {
                embedderWorker.terminate();
                embedderWorker = null;
            }
        }, 1000);
    }
}

// Resetea el reloj de arena cada vez que alguien necesita pensar
function resetEmbedderTimer() {
    if (EMBEDDER_KEEP_WARM) return;
    if (embedderTimeout) clearTimeout(embedderTimeout);
    embedderTimeout = setTimeout(unloadEmbedder, EMBEDDER_TTL_MS);
}

export async function warmupEmbedder(reason = 'startup', { force = false } = {}) {
    const now = Date.now();
    if (!force && warmupPromise) return warmupPromise;
    if (!force && (now - lastWarmupAt) < WARMUP_CACHE_MS) return null;

    warmupPromise = (async () => {
        try {
            console.log(`Warmup [AI Service] (${reason})...`);
            await generateEmbedding(WARMUP_TEXT, true);
            lastWarmupAt = Date.now();
            console.log('[AI Service] Warmup completado.');
        } catch (error) {
            console.warn(`[AI Service] Warmup skipped: ${error.message}`);
        } finally {
            warmupPromise = null;
        }
    })();

    return warmupPromise;
}

/**
 * Genera un embedding vectorial de un texto usando MiniLM en un Worker Thread.
 * @param {string} text 
 * @param {boolean} isQuery 
 * @returns {Promise<number[]>}
 */
export async function generateEmbedding(text, isQuery = false) {
    initWorker();
    resetEmbedderTimer(); // Reiniciar temporizador en cada uso

    const prefix = isQuery ? 'search_query: ' : 'search_document: ';
    const textToEmbed = prefix + text;
    const cached = getCachedEmbedding(textToEmbed);
    if (cached) return cached;
    embeddingRuntimeStats.embedding_cache_misses += 1;
    if (embeddingInFlight.has(textToEmbed)) {
        return embeddingInFlight.get(textToEmbed);
    }

    const requestPromise = new Promise((resolve, reject) => {
        const id = ++messageIdCounter;
        pendingRequests.set(id, { resolve, reject });

        // Timeout watchdog for the worker thread
        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                console.warn(`⏳ [AI Service] Timeout esperando embedding ${id} (Worker thread no responde en 60s)`);
                reject(new Error('Embedding generation timeout (Worker stalled)'));
            }
        }, 60000);

        // console.log(`[AI Service] Enviando request de embedding ${id}...`);
        embedderWorker.postMessage({ action: 'embed', id, text: textToEmbed });
    }).then(vector => {
        saveCachedEmbedding(textToEmbed, vector);
        return Array.isArray(vector) ? [...vector] : vector;
    }).finally(() => {
        embeddingInFlight.delete(textToEmbed);
    });

    embeddingInFlight.set(textToEmbed, requestPromise);
    return requestPromise;
}

export function trackDeferredEmbedding(delta = 1) {
    const numericDelta = Number(delta || 0);
    if (!Number.isFinite(numericDelta) || numericDelta === 0) return;
    embeddingRuntimeStats.deferred_embedding_count = Math.max(
        0,
        embeddingRuntimeStats.deferred_embedding_count + numericDelta
    );
}

export function getEmbeddingRuntimeStats() {
    return {
        embedding_cache_hits: embeddingRuntimeStats.embedding_cache_hits,
        embedding_cache_misses: embeddingRuntimeStats.embedding_cache_misses,
        deferred_embedding_count: embeddingRuntimeStats.deferred_embedding_count,
        cache_size: embeddingCache.size,
        in_flight: embeddingInFlight.size
    };
}

export function resetEmbeddingRuntimeStats() {
    embeddingRuntimeStats.embedding_cache_hits = 0;
    embeddingRuntimeStats.embedding_cache_misses = 0;
    embeddingRuntimeStats.deferred_embedding_count = 0;
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
    const MAX_ON_THE_FLY = 0; // DESACTIVADO: Evita el bloqueo de CPU/RAM en hardware limitado

    // Computar similitud coseno REAL para cada candidato de forma secuencial
    // (Ejecutar ONNX models en paralelo con Promise.all congela el proceso)
    const scored = [];
    for (const m of memories) {
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

        scored.push({ ...m, rerank_score: score });
    }

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
