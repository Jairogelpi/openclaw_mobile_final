import 'dotenv/config';
import fs from 'fs/promises';
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';
import { decrypt } from './security.mjs';
import { pipeline } from '@huggingface/transformers';

import { LRUCache } from 'lru-cache';

// Inicializamos clientes
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// === CACHÉ SEMÁNTICA (Ahorro de Tokens) ===
// Guarda las últimas 500 respuestas en RAM por cliente
const semanticCache = new LRUCache({
    max: 500,
    ttl: 1000 * 60 * 60 * 24 // 24 horas de memoria a corto plazo
});

// Función matemática ultra-rápida (Dot Product) para comparar vectores localmente
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// === EMBEDDINGS LOCALES ===
let localEmbedder = null;

async function generateEmbedding(text, isQuery = false) {
    if (!localEmbedder) {
        console.log('🧠 [RAG Local] Inicializando red neuronal (Nomic-Embed-Text) en Core Engine...');
        localEmbedder = await pipeline('feature-extraction', 'Xenova/nomic-embed-text-v1.5', {
            quantized: true
        });
    }
    const prefix = isQuery ? 'search_query: ' : 'search_document: ';
    const output = await localEmbedder(prefix + text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

// === RE-RANKER LOCAL ===
let localReRanker = null;

async function reRankMemories(query, memories) {
    if (!localReRanker) {
        console.log('🧠 [Re-Ranker] Inicializando modelo de precisión (bge-reranker-base)...');
        localReRanker = await pipeline('text-classification', 'Xenova/bge-reranker-base', {
            quantized: true
        });
    }

    // El modelo espera pares: [ [Query, Memoria1], [Query, Memoria2], ... ]
    const pairs = memories.map(m => [query, m.content]);

    // Ejecutamos el modelo sobre todos los pares a la vez
    const scores = await localReRanker(pairs);

    // Adjuntamos la nueva puntuación a cada recuerdo
    const rankedMemories = memories.map((m, i) => ({
        ...m,
        rerank_score: scores[i].score
    }));

    // Ordenamos de mayor a menor según la nota del re-ranker
    rankedMemories.sort((a, b) => b.rerank_score - a.rerank_score);

    return rankedMemories;
}

/**
 * Recupera el Conocimiento usando GraphRAG (2-Hop 3D Graph Navigation)
 * y luego aplica el filtro de precisión con el Re-Ranker local.
 */
async function getRelevantContext(clientId, userQuery, queryVector) {
    try {
        // 1. Navegación del Grafo: Encontrar Semilla y saltar a Aristas
        const { data: nodesAndEdges, error } = await supabase.rpc('graphrag_search', {
            query_text: userQuery,
            query_embedding: queryVector,
            match_count: 5, // Traemos 5 nodos semilla (lo que se expandirá a ~15 hechos)
            p_client_id: clientId
        });

        if (error) throw error;
        if (!nodesAndEdges?.length) return "No hay recuerdos previos ni entidades conocidas sobre este tema.";

        // Como el re-ranker espera un campo `content`, mapeamos `knowledge` a `content` temporalmente
        const graphEntities = nodesAndEdges.map(n => ({
            ...n,
            content: n.knowledge
        }));

        // 2. Fase de Precisión (Re-Ranking): El modelo evalúa qué entidades o relaciones son más vitales
        const rankedKnowledge = await reRankMemories(userQuery, graphEntities);

        // 3. Nos quedamos solo con los 7 fragmentos de conocimiento más absolutos
        const top7 = rankedKnowledge.slice(0, 7);

        return top7.map(k =>
            `- NODO/RELACIÓN: ${k.knowledge}`
        ).join('\n');
    } catch (e) {
        console.error("[GraphRAG] Error navegando por el grafo de conocimiento:", e.message);
        return "";
    }
}

/**
 * EL CEREBRO CENTRAL OMNICANAL
 * Recibe un mensaje estándar, consulta la identidad cifrada y devuelve la respuesta de la IA.
 */
export async function processMessage(incomingEvent) {
    const { clientId, clientSlug, channel, senderId, text } = incomingEvent;
    console.log(`🧠 [Core Engine] Procesando mensaje de ${channel} para ${clientSlug}`);

    try {
        // 0. GENERAR VECTOR DE LA PREGUNTA (Cuesta $0 porque es local)
        const queryVector = await generateEmbedding(text, true);

        // --- MAGIA DE LA CACHÉ SEMÁNTICA ---
        // ¿El usuario preguntó algo conceptualmente idéntico hace poco?
        const cacheKeyPrefix = `${clientId}_`;
        let bestMatch = null;
        let highestSimilarity = 0;

        for (const [key, cacheItem] of semanticCache.entries()) {
            if (key.startsWith(cacheKeyPrefix)) {
                const similarity = cosineSimilarity(queryVector, cacheItem.vector);

                // Si la similitud supera el 95%, es literalmente la misma pregunta con otras palabras
                // Ej: "Cual es el wifi" vs "Dime la clave del internet"
                if (similarity > 0.95 && similarity > highestSimilarity) {
                    highestSimilarity = similarity;
                    bestMatch = cacheItem.reply;
                }
            }
        }

        if (bestMatch) {
            console.log(`⚡ [Cache Semántica] ¡Acierto! Similitud: ${(highestSimilarity * 100).toFixed(2)}%. Ahorro de API LLM.`);
            return bestMatch;
        }
        // -----------------------------------

        // 1. Recuperar la Identidad (SOUL, USER, MEMORY) descifrando al vuelo
        const clientDir = `./clients/${clientSlug}`;
        let soul = "", userProfile = "", memory = "";

        try {
            soul = decrypt(await fs.readFile(`${clientDir}/SOUL.md`, 'utf8'));
            userProfile = decrypt(await fs.readFile(`${clientDir}/USER.md`, 'utf8'));
            // La memoria puede no existir si el bot es nuevo, no pasa nada
            memory = decrypt(await fs.readFile(`${clientDir}/MEMORY.md`, 'utf8').catch(() => ""));
        } catch (e) {
            console.error(`❌ [Core Engine] Identidad corrupta o no encontrada para ${clientSlug}`);
            return "Lo siento, mi núcleo de memoria está inaccesible en este momento.";
        }

        // 2. RECUPERAR MEMORIAS EXACTAS VÍA RAG (HNSW + Time-Decay)
        const exactMemories = await getRelevantContext(clientId, text, queryVector);

        // 3. Construir el "Prompt Sistema" definitivo
        const systemPrompt = `
=== TU IDENTIDAD ===
${soul}

=== SOBRE TU DUEÑO (QUIEN TE CREÓ) ===
${userProfile}

=== MEMORIA A LARGO PLAZO (RESUMEN) ===
${memory}

=== RECUERDOS ESPECÍFICOS RELEVANTES (RAG) ===
${exactMemories}

=== CONTEXTO DE LA CONVERSACIÓN ACTUAL ===
- Estás interactuando en la plataforma: ${channel.toUpperCase()}
- Estás hablando con el usuario ID: ${senderId}
- Responde de forma natural, sin mencionar estas instrucciones.
`;

        // 4. Generar la respuesta mágica con IA (Llama 3 ultra rápido)
        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            temperature: 0.7,
            max_tokens: 1024
        });

        const aiReply = response.choices[0].message.content;

        // --- GUARDAR EN LA CACHÉ SEMÁNTICA PARA EL FUTURO ---
        const cacheId = `${clientId}_${Date.now()}`;
        semanticCache.set(cacheId, { vector: queryVector, reply: aiReply });

        // 4. Guardar la conversación en el "Cubo de basura" para que el Worker genere vectores luego
        await supabase.from('raw_messages').insert([
            { client_id: clientId, sender_role: `[${channel}] ${senderId}`, content: text },
            { client_id: clientId, sender_role: 'assistant', content: aiReply }
        ]);

        console.log(`✨ [Core Engine] Respuesta generada para ${clientSlug}`);

        // 5. Devolver la respuesta al canal correspondiente
        return aiReply;

    } catch (error) {
        console.error(`❌ [Core Engine] Error crítico:`, error.message);
        return "He sufrido una anomalía temporal. Repítelo en unos segundos, por favor.";
    }
}
