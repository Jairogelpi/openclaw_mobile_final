import 'dotenv/config';
import fs from 'fs/promises';
import supabase from './config/supabase.mjs';
import logger from './utils/logger.mjs';
import groq from './services/groq.mjs';
import { generateEmbedding, cosineSimilarity } from './services/local_ai.mjs';

const parseLLMJson = (text) => {
    try {
        const cleaned = text.replace(/```json | ```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        console.warn('⚠️ [LLM-JSON] Fallback parsing failed for:', text.slice(0, 100));
        throw e;
    }
};

const sanitizeInput = (text, maxLength = 2000) => {
    if (typeof text !== 'string') return '';
    // Prevent prompt injection by neutralizing potential command delimiters
    // and stripping non-printable characters, then capping length
    return text
        .replace(/[<>{}\\^\`]/g, '') // Eliminamos etiquetas estructurales pero MANTENEMOS [] para tags de media
        .substring(0, maxLength)
        .trim();
};
import { searchWeb } from './services/tavily.mjs';
import { decrypt } from './security.mjs';
import {
    reRankMemories,
    checkSemanticCache,
    saveToSemanticCache
} from './services/local_ai.mjs';
import { traverseGraph, hybridSearch } from './services/graph.service.mjs';
import { summarizeYouTubeVideo } from './services/skill_executor.mjs';
import { startRagTrace } from './services/rag_metrics.mjs';
import { getConfig } from './services/config.service.mjs';

/** Groq Helper para Reemplazar OpenRouter (401 Unauthorized Fix) */
async function groqChat(model, messages, options = {}) {
    try {
        const params = {
            model: model || 'llama-3.3-70b-versatile',
            messages: messages,
            temperature: options.temperature ?? 0.7,
            max_completion_tokens: 2048,
        };
        if (options.response_format) {
            params.response_format = options.response_format;
        }
        const response = await groq.chat.completions.create(params);
        return response.choices[0].message.content;
    } catch (e) {
        console.error("GroqChat Error:", e.message);
        throw e;
    }
}

/**
 * AGENTIC RAG ROUTER (2026) — Intelligent Query Classification + Optimal Retrieval
 */
function classifyQuery(query) {
    const q = query.toLowerCase();

    // Temporal patterns
    const temporalPatterns = /\b(ayer|hoy|anoche|semana|mes|año|cuándo|cuando|fecha|lunes|martes|miércoles|jueves|viernes|sábado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|última vez|hace \d+)\b/i;

    // Relational patterns
    const relationalPatterns = /\b(quién es|quien es|relación|familia|pareja|amigo|conoce|hermano|padre|madre|hijo|novia|novio|esposa|esposo|entre .+ y)\b/i;

    // Factual patterns (direct knowledge)
    const factualPatterns = /\b(dónde|donde|vive|trabaja|estudia|gusta|cumpleaños|profesión|edad|número|dirección)\b/i;

    // Named patterns (proper names starting with uppercase)
    const namePattern = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/;

    if (namePattern.test(query)) return 'naming'; // Prioridad: Si hay un nombre, busca por persona
    if (temporalPatterns.test(q)) return 'temporal';
    if (relationalPatterns.test(q)) return 'relational';
    if (factualPatterns.test(q)) return 'factual';
    return 'exploratory';
}

/**
 * RAG HÍBRIDO + GRAPHRAG + AGENTIC ROUTER (Estado del Arte 2026)
 */
async function getRelevantContext(clientId, userQuery, queryVector, trace = null) {
    try {
        const retrievalStart = Date.now();
        const queryType = classifyQuery(userQuery);
        console.log(`🎯 [Agentic Router] Query classified as: ${queryType.toUpperCase()}`);

        let hybridMemories = [];
        let graphKnowledge = [];

        // AGENTIC ROUTING: Select optimal strategy
        switch (queryType) {
            case 'factual':
                // Graph-only: fast, relationship-based lookup
                graphKnowledge = await traverseGraph(clientId, userQuery, queryVector, 10).catch(() => []);
                // Fallback to hybrid if graph is empty
                if (!graphKnowledge.length) {
                    hybridMemories = await hybridSearch(clientId, userQuery, queryVector, 10).catch(() => []);
                }
                break;

            case 'naming':
            case 'relational':
                // Graph-heavy + Hybrid fallback: multi-hop traversal + name focus
                graphKnowledge = await traverseGraph(clientId, userQuery, queryVector, 15).catch(() => []);
                hybridMemories = await hybridSearch(clientId, userQuery, queryVector, 10).catch(() => []);
                break;

            case 'temporal':
                // Hybrid-heavy: text search with temporal context
                hybridMemories = await hybridSearch(clientId, userQuery, queryVector, 15).catch(() => []);
                graphKnowledge = await traverseGraph(clientId, userQuery, queryVector, 5).catch(() => []);
                break;

            case 'exploratory':
            default:
                // Full fusion: both strategies in parallel
                const [hybridResult, graphResult] = await Promise.allSettled([
                    hybridSearch(clientId, userQuery, queryVector, 15),
                    traverseGraph(clientId, userQuery, queryVector, 8)
                ]);
                hybridMemories = hybridResult.status === 'fulfilled' ? hybridResult.value : [];
                graphKnowledge = graphResult.status === 'fulfilled' ? graphResult.value : [];
                break;
        }

        // 3. Fusionar y deduplicar
        const allCandidates = [...hybridMemories, ...graphKnowledge];
        if (!allCandidates.length) return "[CONFIANZA_CONTEXTO: NONE]\nNo hay recuerdos previos ni datos conocidos sobre este tema.";

        const seen = new Set();
        const uniqueCandidates = allCandidates.filter(c => {
            const key = (c.content || '').toLowerCase().slice(0, 100);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        console.log(`🧠[RAG] ${queryType}: ${hybridMemories.length} híbridos + ${graphKnowledge.length} grafo = ${uniqueCandidates.length} únicos`);

        // 4. SENDER NAME BOOSTING
        const nameRegex = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/g;
        const stopWords = new Set(['Que', 'Como', 'Cuando', 'Donde', 'Quien', 'Por', 'Para', 'Con', 'Sin', 'Sobre', 'Hasta', 'Desde', 'Hola', 'Bueno', 'Todo', 'Algo', 'Nada', 'Muy', 'Pero', 'Porque', 'Esto', 'Eso', 'Dime', 'Necesito', 'Saber', 'Quiero', 'Cual']);
        const detectedNames = [...new Set([...userQuery.matchAll(nameRegex)].map(m => m[1]).filter(n => !stopWords.has(n) && n.length > 2))];

        if (detectedNames.length > 0) {
            for (const candidate of uniqueCandidates) {
                for (const name of detectedNames) {
                    const nameLower = name.toLowerCase();
                    if ((candidate.sender || '').toLowerCase().includes(nameLower) ||
                        (candidate.content || '').toLowerCase().includes(nameLower)) {
                        candidate.similarity = (candidate.similarity || 0) * 2.5;
                    }
                }
            }
        }

        // 5. Re-Ranking SELECTIVO
        const rankedKnowledge = await reRankMemories(userQuery, uniqueCandidates, queryVector);
        const top10 = rankedKnowledge.slice(0, 10);

        // 6. ANTI-ALUCINACIÓN
        const avgScore = top10.reduce((sum, k) => sum + (k.rerank_score || 0), 0) / (top10.length || 1);
        let confidenceLevel = avgScore > 0.4 && top10.length >= 3 ? 'HIGH' : (avgScore > 0.1 || top10.length >= 1 ? 'LOW' : 'NONE');

        if (trace) {
            trace.logRetrieval({
                hybridMemories, graphKnowledge, uniqueCandidates, top7: top10,
                confidenceLevel, avgScore, queryType,
                elapsedMs: Date.now() - retrievalStart
            });
        }

        // 7. CONTEXT BLOCK WITH TEMPORAL DIMENSION
        const { data: soulData } = await supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single();
        const currentContext = soulData?.soul_json?.key_facts ? JSON.stringify(soulData.soul_json.key_facts) : "Desconocido.";

        const contextBlock = top10.map(k => {
            const prefix = k.source === 'GRAPH' || k.source === 'GRAPH_V3'
                ? `🕸️ GRAFO[Hop ${k.hop}][${k.timestamp || ''}]`
                : `📝 MEMORIA[Score: ${(k.rerank_score || k.similarity)?.toFixed(3) || '?'}]`;
            return `- ${prefix}: ${k.content} `;
        }).join('\n');

        return `[CONFIANZA_CONTEXTO: ${confidenceLevel}][TIPO_QUERY: ${queryType}]\n\n[HECHOS ACTUALES (SILO TEMPORAL)]:\n${currentContext}\n\n[MEMORIAS RECUPERADAS]:\n${contextBlock}`;
    } catch (e) {
        console.error("[RAG] Error en pipeline Agentic+GraphRAG:", e.message);
        return "[CONFIANZA_CONTEXTO: NONE]\nNo se pudieron recuperar recuerdos.";
    }
}

/**
 * EL CEREBRO CENTRAL OMNICANAL
 */
export async function processMessage(incomingEvent) {
    const { clientId, clientSlug, channel, senderId, text, isSentByMe } = incomingEvent;
    console.log(`🧠[Core Engine] Recibido de ${channel}: "${text.substring(0, 30)}..."(clientId: ${clientId})`);

    try {
        if (isSentByMe) {
            console.log(`✍️[Core Engine] Analizando estilo de mensaje enviado.`);
            return null;
        }

        const senderLabel = incomingEvent.metadata?.isGroup
            ? `[Grupo] ${incomingEvent.metadata.pushName} `
            : incomingEvent.metadata?.pushName || senderId;

        console.log(`🧠[Core Engine] Procesando mensaje de ${senderLabel}...`);

        // SANTIZACIÓN DE INPUT (Seguridad Phase 11)
        const safeText = sanitizeInput(text);

        // 0. EMBEDDING LOCAL
        const queryVector = await generateEmbedding(safeText, true);

        // 📊 RAG METRICS: Start trace
        const trace = startRagTrace(clientId, safeText);

        // 1.5. INTENT GATING (Optimization God-Mode)
        const lowerText = safeText.toLowerCase();
        const trivialRegex = /^(ok|hola|bueno|vale|gracias|jaja|xd|good|hi|hello|thx|thanks)$/i;
        if (trivialRegex.test(lowerText) && lowerText.length < 10) {
            console.log(`⚡[Intent Gating] Mensaje trivial detectado. Saltando RAG profundo.`);
            const trivialReply = lowerText.includes('hola') ? "¡Hola! ¿En qué puedo ayudarte hoy?" : "¡Entendido!";
            trace.markCacheHit(); // Trivial = no RAG needed
            await trace.finish(trivialReply);
            return trivialReply;
        }

        // 1.6. SEMANTIC CACHE (Respuesta Instantánea si ya se respondió algo similar)
        const cacheEnabled = await getConfig('semantic_cache_enabled');
        if (cacheEnabled) {
            const cachedReply = await checkSemanticCache(clientId, queryVector);
            if (cachedReply) {
                console.log(`⚡ [Semantic Cache] HIT. Devolviendo respuesta cacheada sin RAG pipeline.`);
                trace.markCacheHit();
                await trace.finish(cachedReply);
                return cachedReply;
            }
        }

        // 2. Recuperar la Identidad (DB-First)
        const { data: soulData, error: soulError } = await supabase
            .from('user_souls')
            .select('soul_json')
            .eq('client_id', clientId)
            .single();

        if (soulError || !soulData) {
            console.error(`❌ [Core Engine] Identidad no encontrada en DB para ${clientId}`);
            return "Lo siento, mi núcleo de memoria está inaccesible.";
        }

        const soulJson = soulData.soul_json || {};

        // --- 6-SILO BRAIN ARCHITECTURE (Markdown First) ---
        let soulMd = "", userMd = "", contextMd = "", agentMd = "";
        try {
            const fs = await import('fs/promises');
            const clientDir = `./clients/${clientSlug}`;
            soulMd = await fs.readFile(`${clientDir}/SOUL.md`, 'utf8').then(decrypt).catch(() => JSON.stringify(soulJson.soul_patch || soulJson));
            userMd = await fs.readFile(`${clientDir}/USER.md`, 'utf8').then(decrypt).catch(() => JSON.stringify(soulJson.profile || "{}"));
            contextMd = await fs.readFile(`${clientDir}/CONTEXT.md`, 'utf8').then(decrypt).catch(() => JSON.stringify(soulJson.key_facts || "{}"));

            // AGENT.md might not exist yet, fallback gracefully
            agentMd = await fs.readFile(`${clientDir}/AGENT.md`, 'utf8').then(decrypt).catch(() => "");
        } catch (e) {
            console.warn(`⚠️ [Core Engine] Error leyendo MDs para ${clientSlug}, usando fallback JSON.`);
        }

        const soul = soulMd || JSON.stringify(soulJson.soul_patch || soulJson); // The "How" (Identity/Style)
        const profile = userMd || JSON.stringify(soulJson.profile || "{}");      // The "Who" (Bio/Details)
        const context = contextMd || JSON.stringify(soulJson.key_facts || "{}");    // The "What/When" (Situation)
        const network = JSON.stringify(soulJson.network || "{}");      // The "With Whom" (Social Map)
        const goals = JSON.stringify(soulJson.goals || "{}");          // The "Why/Where" (Missions)
        const playbook = agentMd || JSON.stringify(soulJson.playbook || "{}");    // The "How-to" (Procedures)
        const mood = JSON.stringify(soulJson.mood || "{}");            // The "State" (Emotional Resonance)

        // 3. ADVANCED AGENTIC RAG V4: "EL INVESTIGADOR CÍBORG" (Fast + Smart Web)
        console.log(`🕵️ [Agentic RAG V4 Cíborg] Iniciando Investigación Reflexiva...`);
        let accumulatedContext = "";
        let iterations = 0;
        const maxIterations = await getConfig('max_investigation_hops'); // Dinámico desde Supabase
        let searchIsDone = false;
        let investigationLog = []; // Chain-of-Thought visible
        let agenticWebUsed = false;
        let agenticYTUsed = false;
        let agenticAllQueries = [];
        let previousQueryVectors = []; // D. QUERY DEDUP: Track all previous query vectors
        let soulWasUpdated = false; // 🔄 Optimización: Re-cargar alma si hay auto-mejoras
        const agenticStart = Date.now();

        while (iterations < maxIterations && !searchIsDone) {
            iterations++;
            const agenticPrompt = `Eres EL INVESTIGADOR CÍBORG de OpenClaw. Un agente de IA de élite hiper-rápido que rutea decisiones.

PREGUNTA ORIGINAL DEL USUARIO: "${text}"

TU BITÁCORA DE INVESTIGACIÓN (lo que ya has descubierto en saltos previos):
${investigationLog.length > 0 ? investigationLog.map((log, i) => `[Hop ${i + 1}] Busqué: "${log.query}" → Encontré: "${log.finding}"`).join('\n') : 'Vacía. Primera iteración.'}

CONTEXTO ACUMULADO HASTA AHORA:
${accumulatedContext || 'Vacío.'}

 INSTRUCCIONES DE RETRIEVAL Y DECISIÓN (OpenClaw V4):
1. BÚSQUEDA INTERNA (LOCAL): Si la pregunta es sobre el usuario, sus memórias, o relaciones, busca internamente. No asumas nada. Formula queries que ataquen GraphRAG directamente.
2. CONSULTAS TEMPORALES Y TEMÁTICAS: Si te preguntan "Qué hablé en enero?" o "De qué hablo más?", genera una sub-query orientada al grafo: "EVENTO_TEMPORAL enero" o "TEMA más frecuente".
3. WEB SEARCH (INTERNET): SOLO pon "use_web_search": true si te piden un dato del mundo exterior, reciente, de dominio público, noticias, o hechos que no pertenecen a la memoria personal (Ej. "Quién ganó el mundial de 2026?", "Clima en París"). 
   - ⛔ PROHIBIDO buscar en internet datos personales ("Quién es mi novia?", "Problemas de Juan").
4. Si ya tienes suficiente información para responder con altísima confianza, pon investigation_complete = true. No des saltos innecesarios.

SKILLS DISPONIBLES (Booleans):
- use_youtube_tool: Si el usuario pasa un link de YouTube en el texto.
- use_recall_media_tool: Si pide buscar una foto o audio antiguo.
- use_brain_sql_tool: SOLO para estadísticas puras matemáticas (ej. "Cuántos mensajes tengo").

TAREAS PARA ESTE SALTO:
Evalúa lo acumulado. Si es suficiente, termina. Si no, genera entre 1 y 2 queries MUY concisas para la siguiente ronda.

Responde ÚNICAMENTE en JSON ESTRICTO:
{
  "investigation_complete": boolean,
  "reasoning": "Breve cadena de pensamiento rápida",
  "missing_piece": "Qué falta (N/A si terminas)",
  "optimized_queries": ["sub_query_1", "sub_query_2"],
  "use_web_search": boolean,
  "web_search_query": "Búsqueda exacta para Google/Tavily si aplica",
  "use_youtube_tool": boolean,
  "youtube_url": "string o null",
  "use_recall_media_tool": boolean,
  "media_id": "string o null",
  "use_self_improvement_tool": boolean,
  "self_improvement_type": "axiom|directive|style|fact",
  "self_improvement_info": "Nueva regla",
  "use_brain_sql_tool": boolean,
  "sql_analysis_intent": "string o null",
  "contact_jid": "string o null",
  "confidence_score": 0.0 a 1.0 (usa 0.99 si estás listísimo y quieres ahorrar ciclos)
}`;

            try {
                // MODEL TIERING: 8B para el razonamiento Investigador (rápido y barato)
                trace.addLLMCall();
                const agenticRaw = await groqChat('llama-3.1-8b-instant', [
                    { role: 'system', content: agenticPrompt }
                ], { temperature: 0.1, response_format: { type: 'json_object' } });

                const decision = JSON.parse(agenticRaw);
                console.log(`🕵️ [Hop ${iterations}/${maxIterations}] Razón: ${decision.reasoning}`);

                // TRIVIAL EXIT: Si es la primera iteración y no es una pregunta, salimos
                if (decision.investigation_complete && iterations === 1 && !text.includes('?')) {
                    accumulatedContext = "[CONFIANZA: N/A] Charla trivial.";
                    searchIsDone = true;
                    break;
                }

                // INVESTIGATION COMPLETE: El detective tiene suficiente info
                if (decision.investigation_complete && accumulatedContext) {
                    console.log(`✅ [Investigador] Caso cerrado en ${iterations} saltos. Confianza: ${decision.confidence_score}`);
                    searchIsDone = true;
                    break;
                }

                // --- EJECUTAR SKILLS ANTES DE RAG (Prioridad) ---

                // WEB SEARCH SKILL (Tavily)
                if (decision.use_web_search && decision.web_search_query) {
                    console.log(`🌐 [Investigador] Saliendo a Internet (Tavily): "${decision.web_search_query}"`);
                    agenticWebUsed = true;
                    try {
                        const tavilySkill = await import('./skills/tavily_search.mjs');
                        const searchResults = await tavilySkill.default.execute(
                            { query: decision.web_search_query },
                            { clientId, clientSlug }
                        );
                        if (searchResults) {
                            accumulatedContext += `\n\n[INFO DE INTERNET EN TIEMPO REAL]:\n${searchResults}`;
                        } else {
                            accumulatedContext += `\n\n[INFO DE INTERNET]: Búsqueda fallida o vacía.`;
                        }
                    } catch (err) { console.warn(`[Web Search Skill] Fail: ${err.message}`); }

                    // Si ya buscamos en internet para un dato puro, probablemente terminemos,
                    // pero dejamos que el bucle evalúe el siguiente hop.
                }

                // EXECUTE LOCAL RAG SUB-QUERIES (Multi-Hop Search)
                // Usamos las queries si no fue puramente una petición web
                const queries = decision.optimized_queries && decision.optimized_queries.length > 0
                    ? decision.optimized_queries
                    : (!decision.use_web_search ? [text] : []);

                agenticAllQueries.push(...queries);

                const results = await Promise.all(queries.map(async (q) => {
                    const vec = await generateEmbedding(q, true);

                    // D. QUERY DEDUP: Skip queries too similar to previous ones
                    const isDuplicate = previousQueryVectors.some(prevVec => {
                        const sim = cosineSimilarity(vec, prevVec);
                        return sim > 0.85;
                    });
                    if (isDuplicate) {
                        console.log(`♻️ [Dedup] Sub-query "${q.substring(0, 40)}..." es duplicada (>0.85 sim). Saltando.`);
                        return null; // Skip — marked as null for dedup detection
                    }
                    previousQueryVectors.push(vec);

                    return await getRelevantContext(clientId, q, vec, trace);
                }));

                // SMART EARLY-STOP: Si TODAS las sub-queries fueron deduplicadas, no hay info nueva posible
                const validResults = results.filter(r => r !== null);
                if (validResults.length === 0 && iterations > 1) {
                    console.log(`🛑 [Investigador] Todas las sub-queries deduplicadas. No hay info nueva. Cerrando.`);
                    searchIsDone = true;
                    break;
                }

                const newFindings = validResults.join("\n---\n");
                accumulatedContext += "\n" + newFindings;

                // Registrar en la bitácora de investigación (Chain-of-Thought)
                investigationLog.push({
                    query: queries.join(' | '),
                    finding: newFindings.substring(0, 200) + '...',
                    strategy: decision.chaining_strategy || 'DIRECT',
                    missing: decision.missing_piece || 'N/A'
                });

                // YOUTUBE SKILL
                if (decision.use_youtube_tool && decision.youtube_url) {
                    console.log(`📺 [Investigador] Activando Skill: YouTube Watcher...`);
                    agenticYTUsed = true;
                    try {
                        const { summarizeYouTubeVideo } = await import('./skills/youtube-watcher/index.mjs');
                        const videoTranscript = await summarizeYouTubeVideo(decision.youtube_url);
                        if (videoTranscript) accumulatedContext += `\n\n[VIDEO TRANSCRIPT]:\n${videoTranscript}`;
                    } catch (err) { console.warn(`[YouTube Skill] Fail: ${err.message}`); }
                }

                // RECALL MEDIA SKILL (Lazy Loading)
                if (decision.use_recall_media_tool && decision.media_id) {
                    const targetJid = decision.contact_jid || senderId;
                    console.log(`🖼️ [Investigador] Activando Skill: Recall Media para ${decision.media_id}...`);
                    try {
                        const recallSkill = await import('./skills/recall_media.mjs');
                        const mediaResult = await recallSkill.default.execute(
                            { remoteJid: targetJid, messageId: decision.media_id },
                            { clientId, clientSlug }
                        );
                        if (mediaResult) accumulatedContext += `\n\n[ANÁLISIS DE MULTIMEDIA HISTÓRICA]:\n${mediaResult}`;
                    } catch (err) { console.warn(`[Recall Media Skill] Fail: ${err.message}`); }
                }

                // SELF IMPROVEMENT SKILL (Auto-Evolution)
                if (decision.use_self_improvement_tool && decision.self_improvement_info) {
                    console.log(`🧠 [Investigador] Activando Skill: Self Improvement...`);
                    try {
                        const improvementSkill = await import('./skills/self_improvement.mjs');
                        const improveResult = await improvementSkill.default.execute(
                            { correction_type: decision.self_improvement_type, new_info: decision.self_improvement_info, reasoning: decision.reasoning },
                            { clientId, clientSlug }
                        );
                        if (improveResult) {
                            accumulatedContext += `\n\n[SISTEMA DE AUTO-MEJORA]:\n${improveResult}`;
                            soulWasUpdated = true; // ACTIVAMOS RE-CARGA
                        }
                    } catch (err) { console.warn(`[Self Improvement Skill] Fail: ${err.message}`); }
                }

                // BRAIN SQL SKILL (Analytical Counting)
                if (decision.use_brain_sql_tool && decision.sql_analysis_intent) {
                    console.log(`📊 [Investigador] Activando Skill: Brain SQL...`);
                    try {
                        const sqlSkill = await import('./skills/brain_sql.mjs');
                        const sqlResult = await sqlSkill.default.execute(
                            { analysis_intent: decision.sql_analysis_intent, remoteJid: remoteId },
                            { clientId }
                        );
                        if (sqlResult) accumulatedContext += `\n\n[ANÁLISIS SQL]:\n${sqlResult}`;
                    } catch (err) { console.warn(`[Brain SQL Skill] Fail: ${err.message}`); }
                }

                // AUTO-STOP: Si la confianza es altísima, detenemos la investigación
                const confThreshold = await getConfig('rag_confidence_threshold');
                if (decision.confidence_score > confThreshold) {
                    console.log(`🎯 [Investigador] Confianza extrema (${decision.confidence_score}). Cerrando investigación.`);
                    searchIsDone = true;
                }
            } catch (err) { console.error(`[Search Logic] Error critical: ${err.message}`); }
        }

        // 2. SOCIAL DISCOVERY logic (Manual check for 2 entities in query)
        const nameRegex = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/g;
        const namesFound = [...new Set([...text.matchAll(nameRegex)].map(m => m[1]))];
        if (namesFound.length >= 2) {
            console.log(`🔗 [Investigador] Detectada posible conexión entre: ${namesFound.join(' y ')}`);
            try {
                const { data: common } = await supabase.rpc('find_common_entities', {
                    p_client_id: clientId, person_a: namesFound[0], person_b: namesFound[1]
                });
                if (common && common.length > 0) {
                    accumulatedContext += `\n\n[CONEXIONES COMUNES ENCONTRADAS]:\n${JSON.stringify(common)}`;
                }
            } catch (err) { console.warn(`[Social Discovery] RPC Fail: ${err.message}`); }
        }

        console.log(`🕵️ [Investigador] Investigación completada en ${iterations} saltos. Cadena: ${investigationLog.map(l => l.strategy).join(' → ')}`);

        // 📊 RAG METRICS: Log agentic loop
        trace.logAgentic({
            iterations, webSearch: agenticWebUsed, youtubeSkill: agenticYTUsed,
            queries: agenticAllQueries, elapsedMs: Date.now() - agenticStart
        });

        // 🔄 RE-FETCH SOUL SI HUBO MEJORA (Evitar respuesta con datos viejos)
        if (soulWasUpdated) {
            console.log(`🔄 [Core Engine] Re-cargando identidad actualizada tras auto-mejora...`);
            const { data: updatedSoul } = await supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single();
            if (updatedSoul) soulData.soul_json = updatedSoul.soul_json;
        }

        // 4. CONTEXT ATOMIZATION (Beyond-God-Tier Cost Cut)
        console.log(`🧪 [Architect RAG] Atomizando contexto (Ahorro de Tokens)...`);
        let distilledKnowledge = "";
        const atomStart = Date.now();

        // ANTI-HALLUCINATION GATE: Si la confianza es NONE, inyectar guardia estricta
        const hasNoContext = (accumulatedContext.includes('[CONFIANZA_CONTEXTO: NONE]') && !accumulatedContext.includes('[CONFIANZA_CONTEXTO: LOW]')) || (accumulatedContext.trim() === '' || accumulatedContext.includes('Charla trivial'));
        const antiHallucinationDirective = hasNoContext
            ? '\n\n⛔ [DIRECTIVA ANTI-ALUCINACIÓN]: NO tienes datos sobre este tema en tus recuerdos. Di que no lo sabes o menciona que tu memoria está incompleta sobre este punto específico. JAMÁS inventes datos.'
            : '';

        // Inyectar la cadena de investigación del detective para trazabilidad
        const investigationChain = investigationLog.length > 0
            ? '\n[BITÁCORA DEL INVESTIGADOR]:\n' + investigationLog.map((l, i) => `  Hop ${i + 1} (${l.strategy}): Busqué "${l.query}" → ${l.finding}`).join('\n')
            : '';
        try {
            // MODEL TIERING: 8B para destilación de hechos puros
            trace.addLLMCall();
            distilledKnowledge = await groqChat('llama-3.1-8b-instant', [
                { role: 'system', content: `Eres un Atomizador de Contexto. Extrae ÚNICAMENTE los "Átomos de Hecho" más relevantes del contexto provisto como una lista de viñetas muy cortas. Omite todo el texto de relleno. Formato: "- Hecho 1\n- Hecho 2". Si el contexto está vacío, responde "Sin hechos."` },
                { role: 'user', content: `CONTEXTO:\n${accumulatedContext}` }
            ], { temperature: 0.1 });
        } catch (e) {
            distilledKnowledge = accumulatedContext;
        }
        // 📊 RAG METRICS: Log atomization
        trace.logAtomization({
            charsBefore: accumulatedContext.length,
            charsAfter: distilledKnowledge.length,
            elapsedMs: Date.now() - atomStart
        });

        // 5. GENERACIÓN FINAL
        // A. Obtener ejemplos de estilo (Mirroring Dinámico)
        let userStyleExamples = "";
        try {
            // 1. Prioridad: Búsqueda Semántica de Estilo (¿Cómo responde el usuario a temas similares?)
            const { data: semanticExamples, error: rpcError } = await supabase.rpc('match_user_style', {
                query_text: text,
                query_embedding: queryVector,
                match_count: 3,
                p_client_id: clientId
            });

            if (semanticExamples?.length > 0) {
                userStyleExamples = "EJEMPLOS SEMÁNTICOS (Así hablaste de temas similares):\n" +
                    semanticExamples.map(e => `[Contexto Similar]: "${e.content}"`).join('\n');
            } else {
                // 2. Fallback: Últimos 5 mensajes reales (Estilo general reciente)
                const { data: sentMsgs } = await supabase
                    .from('raw_messages')
                    .select('content')
                    .eq('client_id', clientId)
                    .eq('sender_role', 'user_sent')
                    .order('created_at', { ascending: false })
                    .limit(5);

                if (sentMsgs?.length > 0) {
                    userStyleExamples = "EJEMPLOS RECIENTES (Tu estilo general hoy):\n" +
                        sentMsgs.map(m => `"${m.content}"`).join('\n');
                }
            }
        } catch (e) {
            console.warn(`⚠️ [Core Engine] Error en mirroring dinámico:`, e.message);
        }

        const parsedSoul = JSON.parse(soul);
        const styleInfo = parsedSoul.style_profile ? `
        ESTILO DE ESCRITURA:
        - Tono: ${parsedSoul.style_profile.tone || 'Natural'}
        - Emojis frecuentes: ${parsedSoul.style_profile.common_emojis?.join(' ') || 'Ninguno'}
        - Vocabulario: ${parsedSoul.style_profile.slang_and_vocabulary?.join(', ') || 'Estándar'}
        - Puntuación: ${parsedSoul.style_profile.punctuation_style || 'Normal'}
        - Longitud típica: ${parsedSoul.style_profile.message_length || 'Variable'}
        - Formato y Mayúsculas: ${parsedSoul.style_profile.casing_and_formatting || 'Normal'}
        ` : "";

        const axionas = parsedSoul.axiomas_filosoficos?.join('\n- ') || "No detectados.";
        const matrices = parsedSoul.matrices_decision?.join('\n- ') || "No detectadas.";
        const directives = parsedSoul.personal_directives?.join('\n- ') || "No hay directivas específicas.";
        const psych = parsedSoul.psychological_profile ? JSON.stringify(parsedSoul.psychological_profile) : "No analizado.";

        const systemPrompt = `
        === 🧠 CEREBRO DIGITAL: CLONACIÓN DE NIVEL 5 ===
        
        [SILO 1: SOUL - IDENTIDAD Y VOZ]
        ${soul}
        
        [SILO 2: PROFILE - BIOGRAFÍA]
        ${profile}
        
        [SILO 3: CONTEXT - SITUACIÓN ACTUAL]
        ${context}
        
        [SILO 4: NETWORK - RELACIONES VIP]
        ${network}
        
        [SILO 5: GOALS - MISIONES Y PROYECTOS]
        ${goals}
        
        [SILO 6: PLAYBOOK - MANUAL OPERATIVO]
        ${playbook}
        
        [SILO 7: MOOD - RESONANCIA EMOCIONAL]
        ${mood}
        
        === DIRECTIVAS Y AXIOMAS (PRIORIDAD ALTA) ===
        - ${directives}
        - AXIOMAS: ${axionas}
        - MATRICES: ${matrices}
        - PERFIL PSICOLÓGICO: ${psych}
        
        === REGLAS DE ORO ===
        1. MANTÉN EL PERSONAJE: Responde con el estilo, tono y emojis que verás en los ejemplos. No seas una IA.
        2. BREVEDAD HUMANA: Si el dueño es corto y seco, HAZ LO MISMO.
        3. CONTEXTO SOCIAL: Si detectas que hablas con alguien del [NETWORK], usa los matices de esa relación.
        4. PROACTIVIDAD: Si el mensaje se alinea con tus [GOALS], sé proactivo.
        5. PROCEDIMIENTOS: Sigue el [PLAYBOOK] para tareas operativas (agendar, filtrar, etc).
        6. RESONANCIA EMOCIONAL: Modula tu energía y empatía según el [MOOD]. Si el usuario está estresado, sé breve y servicial; si está eufórico, comparte la energía. Imita su vibración actual.
        7. EVIDENCIA MULTIMODAL: Tus recuerdos incluyen análisis de imágenes (fotos, esquemas, facturas) y audios. Trátalos como hechos presenciados por ti.
        
        === CONTEXTO DINÁMICO (MEMORIA EPISÓDICA) ===
        ${distilledKnowledge}
        
        === ESPEJO SEMÁNTICO (TU VOZ REAL) ===
        ${userStyleExamples || "Imita el estilo del SOUL."}${antiHallucinationDirective}${investigationChain}`;

        // 5. BUCLE DE REFLEXIÓN (DRAFT -> CRITIQUE -> REFINE)
        // SPEED OPTIMIZATION: Solo ejecutar la reflexión pesada para preguntas complejas
        const reflectionMinChars = await getConfig('reflection_min_chars');
        const reflectionEnabled = await getConfig('reflection_enabled');
        const needsDeepReflection = reflectionEnabled && (text.includes('?') || text.length > reflectionMinChars);

        if (!needsDeepReflection) {
            console.log(`⚡ [Reflection Skip] Mensaje casual detectado. Generando respuesta directa sin auditoría.`);
            trace.addLLMCall();
            const directReply = await groqChat('llama-3.3-70b-versatile', [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ], { temperature: 0.3 });

            if (directReply) {
                await saveToSemanticCache(clientId, queryVector, text, directReply);
                await supabase.from('raw_messages').insert([{
                    client_id: clientId, sender_role: 'assistant', content: directReply,
                    remote_id: senderId, metadata: { reflection_attempts: 0, reflection_approved: true, fast_path: true }
                }]);
                trace.logReflection({ attempts: 0, score: 10, conflictDetected: false, conflictDetails: null, elapsedMs: 0 });
                await trace.finish(directReply);
                console.log(`✨ [Core Engine] Respuesta rápida entregada (Fast Path).`);
                return directReply;
            }
        }

        console.log(`🧠 [Reflection Loop] Iniciando ciclo de identidad espejo profunda...`);

        let aiReply = "";
        let isApproved = false;
        let attempts = 0;
        let lastAuditScore = 0;
        let lastConflict = false;
        let lastConflictDetails = null;
        const reflectionStart = Date.now();
        let history = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];

        while (!isApproved && attempts < 2) {
            attempts++;
            console.log(`✍️ [Reflection] Intento ${attempts}: Generando borrador...`);

            // MODEL TIERING: 70B para la respuesta FINAL (Máxima calidad e identidad)
            trace.addLLMCall();
            aiReply = await groqChat('llama-3.3-70b-versatile', history, { temperature: 0.3 });

            // CRÍTICA INTERNA - Enfocada en Identidad y Valores
            const critiquePrompt = `Eres el Auditor de Identidad de OpenClaw. Tu objetivo es el "Espejo Semántico Perfecto" y la "Coherencia Axiológica".
                    
                    PERFIL DE ESTILO REQUERIDO:
                    ${styleInfo}
                    
                    EJEMPLOS REALES DEL DUEÑO:
                    ${userStyleExamples}
                    
                    MENSAJE DEL USUARIO: "${text}"
                    RESPUESTA A EVALUAR: "${aiReply}"
                    
                    VALORES Y AXIOMAS DEL DUEÑO:
                    ${axionas}
        
                    DIRECTIVAS DEL DUEÑO (¡CRÍTICO!):
                    ${directives}
                    
                    TAREA 1: Evalúa la respuesta (0-10):
                    1. TONO: ¿Coincide con la personalidad?
                    2. FORMATO: ¿Mayúsculas/puntuación correctas?
                    3. EMOJIS: ¿Cantidad adecuada?
                    4. FLUIDEZ: ¿Suena a humano?
                    
                    TAREA 2: DETECCIÓN DE CONFLICTO COGNITIVO (¡CRÍTICO!)
                    Analiza profundamente si el MENSAJE DEL USUARIO o tu generación implican algo que va en contra DIRECTA de los "Valores y Axiomas del Dueño".
                    - Si hay un choque filosófico, define "conflict_detected: true" y explica en "conflict_details" qué axioma se está rompiendo.
                    
                    REGLA DE ORO: Si la respuesta parece de IA genérica, CALIFICA 0.
                    
                    Responde JSON: { 
                      "approved": boolean, 
                      "score": number, 
                      "critique": "string", 
                      "suggestions": "string",
                      "conflict_detected": boolean,
                      "conflict_details": "string"
                    }`;

            let audit = { approved: false, score: 0, conflict_detected: false };
            let retryCount = 0;
            const MAX_AUDIT_RETRIES = 2;

            while (!audit.approved && retryCount <= MAX_AUDIT_RETRIES) {
                try {
                    trace.addLLMCall();
                    const auditRaw = await groqChat('llama-3.3-70b-versatile', [
                        { role: 'system', content: critiquePrompt }
                    ], {
                        temperature: 0.1 + (retryCount * 0.2),
                        response_format: { type: 'json_object' }
                    });

                    audit = parseLLMJson(auditRaw);
                    lastAuditScore = audit.score || 0;
                    lastConflict = audit.conflict_detected || false;
                    lastConflictDetails = audit.conflict_details || null;

                    if (audit.conflict_detected) {
                        console.log(`🚨 [Cognitive Conflict] ¡Contradicción Axiológica Detectada!`);
                        aiReply = `⚙️ [Modo Autoconsciencia OpenClaw]\nHe detectado un conflicto fundamental con tus valores guardados.\n\n⚠️ Conflicto detectado: ${audit.conflict_details}\n\n¿Ha evolucionado tu forma de pensar sobre este tema? (Dime para actualizar mi núcleo de identidad).`;
                        isApproved = true;
                        break;
                    }

                    if (audit.approved || audit.score >= 8) {
                        console.log(`✅ [Reflection] Auditoría aprobada (${audit.score}/10) en intento ${retryCount + 1}.`);
                        isApproved = true;
                        break;
                    } else {
                        console.warn(`🛑 [Reflection] Auditoría RECHAZADA (${audit.score}/10). Sugerencia: ${audit.suggestions}`);
                        retryCount++;

                        if (retryCount <= MAX_AUDIT_RETRIES) {
                            history = [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: text },
                                { role: 'assistant', content: aiReply },
                                { role: 'system', content: `CRÍTICA DEL AUDITOR: ${audit.critique}. SUGERENCIAS: ${audit.suggestions}. CORRIGE Y REINTENTA.` }
                            ];
                            trace.addLLMCall();
                            aiReply = await groqChat('llama-3.3-70b-versatile', history, {
                                temperature: 0.3 + (retryCount * 0.1)
                            });
                        }
                    }
                } catch (e) {
                    console.error('❌ [Reflection] Error en auditoría:', e.message);
                    isApproved = true;
                    break;
                }
            }
            if (isApproved) break;
        }

        // Final check to ensure aiReply is not empty
        if (!aiReply) {
            console.warn(`⚠️ [Reflection] aiReply está vacío después del bucle de reflexión. Usando un mensaje por defecto.`);
            aiReply = "Lo siento, no pude generar una respuesta coherente en este momento. Por favor, intenta de nuevo.";
        }

        // 📊 RAG METRICS: Log reflection results
        trace.logReflection({
            attempts, score: lastAuditScore,
            conflictDetected: lastConflict, conflictDetails: lastConflictDetails,
            elapsedMs: Date.now() - reflectionStart
        });

        await saveToSemanticCache(clientId, queryVector, text, aiReply);
        await supabase.from('raw_messages').insert([{
            client_id: clientId,
            sender_role: 'assistant',
            content: aiReply,
            remote_id: senderId,
            metadata: {
                reflection_attempts: attempts,
                reflection_approved: isApproved
            }
        }]);

        // 📊 RAG METRICS: Finalize and persist trace
        await trace.finish(aiReply);

        console.log(`✨ [Core Engine] Respuesta entregada con éxito.`);
        return aiReply;

    } catch (error) {
        console.error(`❌ [Core Engine] Crash:`, error.message);
        return null;
    }
}
