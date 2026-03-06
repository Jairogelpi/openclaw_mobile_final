import 'dotenv/config';
import fs from 'fs/promises';
import supabase from './config/supabase.mjs';
import logger from './utils/logger.mjs';
import groq from './services/groq.mjs';
import { generateEmbedding, cosineSimilarity } from './services/local_ai.mjs';

const parseLLMJson = (text, fallback = {}) => {
    try {
        // Tratar de parsear quitando tags de código si los hay
        const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        // Intento severo: extraer el primer bloque {...}
        try {
            const match = text.match(/\{[\s\S]*?\}/);
            if (match) {
                return JSON.parse(match[0]);
            }
        } catch (e2) { }
        console.warn(`⚠️ [LLM-JSON] Fallback parsing failed. Returning default object. Text preview: ${text.slice(0, 100)}`);
        return fallback;
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
import { buildRagQueryPlan, runEvidenceFirstRag } from './services/evidence_rag.service.mjs';

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
        const response = await Promise.race([
            groq.chat.completions.create(params),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Groq API Timeout (20s)')), 20000))
        ]);
        return response.choices[0].message.content;
    } catch (e) {
        console.error("GroqChat Error:", e.message);
        throw e;
    }
}

async function persistAssistantReply({ clientId, senderId, channel, content, metadata = {} }) {
    if (!content) return;
    await supabase.from('raw_messages').insert([{
        client_id: clientId,
        sender_role: 'assistant',
        content,
        remote_id: senderId,
        processed: true,
        metadata: {
            channel: channel || 'whatsapp',
            generated_by: 'core_engine',
            exclude_from_memory: true,
            ...metadata
        }
    }]);
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
                // Full fusion: both strategies sequentially to avoid ONNX/DB concurrency overloads
                try { hybridMemories = await hybridSearch(clientId, userQuery, queryVector, 15); } catch (e) { hybridMemories = []; }
                try { graphKnowledge = await traverseGraph(clientId, userQuery, queryVector, 8); } catch (e) { graphKnowledge = []; }
                break;
        }

        // 3. Fusionar y deduplicar (PRIORIZANDO RECUERDOS REALES)
        // Ponemos los híbridos primero para que tengan prioridad en la deduplicación y en el slice de la ventana de contexto
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

        let rankedKnowledge = [];
        if (uniqueCandidates.length > 0) {
            // MEJORA: Priorización temporal + SESGO DE FUENTE (Híbridos > Grafo)
            uniqueCandidates.sort((a, b) => {
                const dateA = new Date(a.timestamp || a.metadata?.dateStart || 0);
                const dateB = new Date(b.timestamp || b.metadata?.dateStart || 0);

                // Si la fecha es igual o la diferencia es pequeña, priorizar HÍBRIDO (Conversación real)
                if (Math.abs(dateB - dateA) < 1000) {
                    if (a.source === 'HYBRID' && b.source !== 'HYBRID') return -1;
                    if (b.source === 'HYBRID' && a.source !== 'HYBRID') return 1;
                }

                return dateB - dateA; // Más recientes arriba
            });
            try {
                // Preparamos un prompt ultra-corto para que el LLM elija los mejores
                const isTimeSensitive = queryType === 'temporal' || userQuery.toLowerCase().includes('ayer') || userQuery.toLowerCase().includes('hoy');
                const currentDate = new Date().toISOString().split('T')[0];
                const pruningPrompt = `Hoy es ${currentDate}.
Analiza estos recuerdos y selecciona SOLO los IDs de los ${isTimeSensitive ? '20' : '10'} que respondan mejor a: "${userQuery}".
${isTimeSensitive ? 'IMPORTANTE: Esta es una consulta TEMPORAL. Prioriza los recuerdos que ocurrieron en la fecha solicitada relativa a hoy.' : ''}

Recuerdos:
${uniqueCandidates.slice(0, 80).map((c, idx) => {
                    const timestamp = c.timestamp || c.metadata?.dateStart || 'N/A';
                    const sourceLabel = c.source === 'HYBRID' ? '[CHARLA]' : '[GRAFO]';
                    return `##ID:${idx}## [${timestamp}] ${sourceLabel} ${c.content.substring(0, 200).replace(/\n/g, ' ')}`;
                }).join('\n')}

Responde SOLO con una lista de IDs separados por coma (ej: 0, 3, 5).`;

                const selectedIdsStr = await groqChat('llama-3.1-8b-instant', [
                    { role: 'system', content: 'Eres un filtro de relevancia experto en contextos sociales y temporales. Los IDs están en formato ##ID:X##.' },
                    { role: 'user', content: pruningPrompt }
                ], { temperature: 0.1 });

                const selectedIds = (selectedIdsStr || '').match(/##ID:(\d+)##/g)?.map(m => parseInt(m.match(/\d+/)[0])) || (selectedIdsStr || '').match(/\d+/g)?.map(Number) || [];
                console.log(`🤖 [Pruning] LLM eligió IDs: ${selectedIds.join(', ')}`);
                rankedKnowledge = selectedIds
                    .filter(id => uniqueCandidates[id])
                    .map(id => uniqueCandidates[id]);

                // MEJORA: Siempre incluir híbridos recientes si es temporal
                if (isTimeSensitive) {
                    const topHybrids = uniqueCandidates
                        .filter(c => c.source === 'HYBRID' && c.timestamp && !rankedKnowledge.includes(c))
                        .slice(0, 15);
                    rankedKnowledge = [...topHybrids, ...rankedKnowledge];
                }

                // Si el LLM no devolvió nada útil, usamos el fallback de score original
                if (rankedKnowledge.length === 0) {
                    rankedKnowledge = uniqueCandidates.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
                }
            } catch (e) {
                console.warn(`⚠️ [Pruning] Falló el refinamiento LLM, usando fallback de DB.`);
                rankedKnowledge = uniqueCandidates.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
            }
        }

        const topN = rankedKnowledge.slice(0, 30); // Aumentado a 30 para maximizar inteligencia

        // 6. ANTI-ALUCINACIÓN (Criterio de confianza simplificado)
        let confidenceLevel = topN.length >= 3 ? 'HIGH' : (topN.length >= 1 ? 'LOW' : 'NONE');

        if (trace) {
            trace.logRetrieval({
                hybridMemories, graphKnowledge, uniqueCandidates, topN,
                confidenceLevel, queryType,
                elapsedMs: Date.now() - retrievalStart
            });
        }

        // 7. CONTEXT BLOCK WITH TEMPORAL DIMENSION
        const { data: soulData } = await supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single();
        const currentContext = soulData?.soul_json?.key_facts ? JSON.stringify(soulData.soul_json.key_facts) : "Desconocido.";

        const contextBlock = topN.map(k => {
            const dateStr = k.timestamp || k.metadata?.dateStart || '';
            const prefix = dateStr ? `[${dateStr}]` : '[INFO_GENÉRICA]';
            return `${prefix} ${k.content} `;
        }).join('\n');

        return `[CONFIANZA_CONTEXTO: ${confidenceLevel}][TIPO_QUERY: ${queryType}]\n\n[HECHOS ACTUALES]:\n${currentContext}\n\n[RECUERDOS]:\n${contextBlock}`;
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
        // 🤖 SELF-CHAT AI: Si el usuario escribe en su propio chat, es una consulta al asistente
        const isSelfChatQuery = isSentByMe && incomingEvent.metadata?.isSelfChat;
        if (isSentByMe && !isSelfChatQuery) {
            console.log(`✍️[Core Engine] Analizando estilo de mensaje enviado.`);
            return null;
        }
        if (isSelfChatQuery) {
            console.log(`🤖 [Self-Chat AI] Consulta del usuario al asistente IA: "${text.substring(0, 50)}..."`);
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

        // 1.6. MODO RAG + SEMANTIC CACHE SEGURO
        const ragMode = String(await getConfig('rag_mode') || 'legacy');
        const cacheEnabled = await getConfig('semantic_cache_enabled');
        trace.setMode?.(ragMode);

        if (ragMode === 'evidence_first') {
            const plan = await buildRagQueryPlan(clientId, safeText, trace);
            trace.setQueryPlan?.(plan);

            const cacheEligible = Boolean(
                cacheEnabled &&
                !plan.need_exact_entity_match &&
                !plan.temporal_window &&
                !plan.relation_filter &&
                !plan.entities?.length &&
                plan.intent === 'exploratory'
            );

            if (cacheEligible) {
                const cachedReply = await checkSemanticCache(clientId, queryVector);
                if (cachedReply) {
                    console.log(`⚡ [Semantic Cache] HIT seguro en modo evidence_first.`);
                    trace.markCacheHit();
                    trace.setAnswerVerdict?.({
                        verdict: 'cached',
                        citationCoverage: 1,
                        supportedClaims: []
                    });
                    await trace.finish(cachedReply);
                    return cachedReply;
                }
            }

            const evidenceResult = await runEvidenceFirstRag({
                clientId,
                queryText: safeText,
                queryVector,
                trace,
                precomputedPlan: plan
            });

            if (cacheEnabled && evidenceResult.cacheEligible && evidenceResult.verdict === 'answer') {
                await saveToSemanticCache(clientId, queryVector, safeText, evidenceResult.reply);
            }

            await persistAssistantReply({
                clientId,
                senderId,
                channel,
                content: evidenceResult.reply,
                metadata: {
                    fast_path: true,
                    rag_mode: 'evidence_first',
                    answer_verdict: evidenceResult.verdict,
                    citation_coverage: evidenceResult.citationCoverage,
                    query_plan: evidenceResult.plan,
                    citations: (evidenceResult.verification?.supportedClaims || []).map(claim => ({
                        text: claim.text,
                        citations: claim.citations
                    }))
                }
            });

            await trace.finish(evidenceResult.reply);
            console.log(`✨ [Core Engine] Respuesta evidence_first entregada (${evidenceResult.verdict}).`);
            return evidenceResult.reply;
        }

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

        // 🔥 SPEED OVERRIDE: Forzamos 3 saltos máximos para permitir que la IA decida cuándo parar
        // 🔥 SPEED OVERRIDE: Forzamos 2 saltos máximos para permitir que la IA decida cuándo parar
        // El salto único ya recupera ~80-100 nodos de grafo + memoria híbrida, lo cual es inmenso.
        const maxIterations = 2; // Reducido: Balance óptimo entre velocidad e inteligencia

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
            console.log(`🕵️ [Hop ${iterations}/${maxIterations}] Buscando información...`);

            // Si ya tenemos información relevante de alta confianza, paramos rápido
            if (accumulatedContext.includes('[CONFIANZA_CONTEXTO: HIGH]') && iterations > 1) {
                console.log(`✅ [Investigador] Info de alta confianza encontrada. Parando búsqueda anticipadamente.`);
                searchIsDone = true;
                break;
            }

            const agenticPrompt = `Eres EL INVESTIGADOR CÍBORG de OpenClaw. Tu misión es la CONECTIVIDAD TOTAL.
            
PREGUNTA ORIGINAL: "${text}"

TU BITÁCORA:
${investigationLog.length > 0 ? investigationLog.map((log, i) => `[Hop ${i + 1}] Busqué: "${log.query}" → Encontré: "${log.finding}"`).join('\n') : 'Vacía.'}

CONTEXTO ACUMULADO:
${accumulatedContext || 'Vacío.'}

INSTRUCCIONES DE ÉLITE (V4.2):
1. DESCUBRIMIENTO DE IDENTIDAD: Si preguntan por una relación (madre, novia, etc.), busca por la ENTIDAD y la RELACIÓN.
2. CONCIENCIA TEMPORAL: Si la pregunta menciona tiempo (ayer, hoy, enero, etc.), INCLUYE el término temporal en tus queries (Ej: "Víctor ayer", "Reunión martes").
3. BÚSQUEDA CRUZADA: Si ya sabes un nombre (ej: "Mireya"), busca sus conexiones: "Mireya relación", "Mireya vínculo".
4. NO SUPONGAS: Si el grafo no tiene la respuesta tras 2 saltos, termina y admite que no tienes ese dato específico.
5. WEB SEARCH: Úsala para temas generales, noticias o validación de hechos públicos. Actívala poniendo "use_web_search: true".

Responde JSON:
{
  "investigation_complete": boolean,
  "reasoning": "Breve cadena de pensamiento",
  "optimized_queries": ["query_1", "query_2"],
  "use_web_search": boolean,
  "web_search_query": "Búsqueda optimizada para internet",
  "confidence_score": 0.0 a 1.0
}`;

            try {
                // MODEL TIERING: 8B para el razonamiento Investigador (rápido y barato)
                trace.addLLMCall();
                const agenticRaw = await groqChat('llama-3.1-8b-instant', [
                    { role: 'system', content: agenticPrompt }
                ], { temperature: 0.1, response_format: { type: 'json_object' } });

                const decision = parseLLMJson(agenticRaw, {
                    investigation_complete: false,
                    reasoning: 'Fallback reasoning due to JSON parse failure',
                    optimized_queries: [],
                    use_web_search: false,
                    web_search_query: '',
                    confidence_score: 0.1
                });
                console.log(`🕵️ [Hop ${iterations}/${maxIterations}] Razón: ${decision.reasoning}`);

                // TRIVIAL EXIT: Si es la primera iteración y no es una pregunta, salimos
                if (decision.investigation_complete && iterations === 1 && !text.includes('?')) {
                    accumulatedContext = "[CONFIANZA: N/A] Charla trivial.";
                    searchIsDone = true;
                    break;
                }

                // INVESTIGATION COMPLETE: El detective tiene suficiente info
                if (decision.investigation_complete && (accumulatedContext || decision.use_web_search)) {
                    console.log(`✅ [Investigador] Caso cerrado en ${iterations} saltos. Confianza: ${decision.confidence_score}`);
                    searchIsDone = true;
                    if (!decision.use_web_search) break;
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

                const results = [];
                for (const q of queries) {
                    const vec = await generateEmbedding(q, true);

                    // D. QUERY DEDUP: Skip queries too similar to previous ones
                    const isDuplicate = previousQueryVectors.some(prevVec => {
                        const sim = cosineSimilarity(vec, prevVec);
                        return sim > 0.85;
                    });
                    if (isDuplicate) {
                        console.log(`♻️ [Dedup] Sub-query "${q.substring(0, 40)}..." es duplicada (>0.85 sim). Saltando.`);
                        results.push(null); // Skip — marked as null for dedup detection
                        continue;
                    }
                    previousQueryVectors.push(vec);

                    const res = await getRelevantContext(clientId, q, vec, trace);
                    results.push(res);
                }

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

        // 🧠 PHASE 5: COGNITIVE SYNTHESIS (Self-Updating Soul)
        // Solo si hay contexto sustancial y no es una charla trivial.
        const autoSoulUpdateEnabled = await getConfig('rag_auto_soul_update_enabled');
        if (autoSoulUpdateEnabled && accumulatedContext && accumulatedContext.length > 200 && !searchIsDone) {
            console.log(`🧠 [Cognitive Synthesis] Analizando hallazgos para actualizar identidad permanente...`);
            const synthesisPrompt = `Eres el NÚCLEO DE SÍNTESIS de OpenClaw. Tu misión es detectar hechos de IDENTIDAD CLAVE que deban ser recordados permanentemente en el Soul.

CONTEXTO RECIENTE ENCONTRADO:
${accumulatedContext}

DATOS ACTUALES EN EL SOUL (key_facts):
${JSON.stringify(soulJson.key_facts || [])}

TAREA:
1. Identifica hechos de ALTA CONFIANZA sobre el usuario o sus relaciones (ej: "Mireya es la novia", "Su madre se llama X").
2. Si un hecho NO está en los key_facts actuales o contradice uno viejo, genera una actualización.
3. Sé extremadamente selectivo. Solo datos estructurales o hitos emocionales.

Responde JSON:
{
  "new_facts": [
    { "fact": "Descripción breve", "confidence": 0.0 to 1.0, "type": "identity|relationship|milestone" }
  ],
  "reasoning": "Por qué estos cambios son vitales"
}`;
            try {
                trace.addLLMCall();
                const synthesisRaw = await groqChat('llama-3.1-8b-instant', [
                    { role: 'system', content: synthesisPrompt }
                ], { temperature: 0.1, response_format: { type: 'json_object' } });

                const synthesis = parseLLMJson(synthesisRaw, { new_facts: [] });
                const highConfFacts = synthesis.new_facts.filter(f => f.confidence > 0.85);

                if (highConfFacts.length > 0) {
                    console.log(`✨ [Cognitive Synthesis] ${highConfFacts.length} nuevos hechos clave detectados.`);
                    const improvementSkill = await import('./skills/self_improvement.mjs');
                    for (const f of highConfFacts) {
                        await improvementSkill.default.execute(
                            { correction_type: 'fact', new_info: f.fact, reasoning: synthesis.reasoning },
                            { clientId, clientSlug }
                        );
                    }
                    soulWasUpdated = true;
                }
            } catch (err) { console.warn(`[Cognitive Synthesis] Falló: ${err.message}`); }
        }

        console.log(`🕵️ [Investigador] Investigación completada en ${iterations} saltos. Cadena: ${investigationLog.map(l => l.strategy).join(' → ')}`);

        // 📊 RAG METRICS: Log agentic loop
        trace.logAgentic({
            iterations, webSearch: agenticWebUsed, youtubeSkill: agenticYTUsed,
            queries: agenticAllQueries, elapsedMs: Date.now() - agenticStart
        });

        // 🔄 RE-FETCH SOUL SI HUVO MEJORA (Evitar respuesta con datos viejos)
        if (soulWasUpdated) {
            console.log(`🔄 [Core Engine] Re-cargando identidad actualizada tras auto-mejora...`);
            const { data: updatedSoul } = await supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single();
            if (updatedSoul) soulData.soul_json = updatedSoul.soul_json;
        }

        // 4. CONTEXT ATOMIZATION (BYPASSED FOR EXTREME SPEED & DATA RETENTION)
        console.log(`🧪 [Architect RAG] Atomización desactivada (Modo Velocidad Máxima)...`);
        let distilledKnowledge = accumulatedContext;
        console.log(`🧠 [DEBUG RAG] Contexto acumulado sample (first 1000ch): ${distilledKnowledge.substring(0, 1000)}...`);
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

        // 📊 RAG METRICS: Log atomization (Skipped)
        trace.logAtomization({ charsBefore: accumulatedContext.length, charsAfter: distilledKnowledge.length, elapsedMs: 0 });

        // 5. GENERACIÓN FINAL
        console.log("!!! TRACE 1: Before Style Mirroring");
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

        console.log("!!! TRACE 2: Before JSON.parse(soul)");
        let parsedSoul = {};
        try {
            parsedSoul = JSON.parse(soul);
        } catch (e) {
            parsedSoul = soulJson.soul_patch || soulJson || {};
        }
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

        console.log("!!! TRACE 3: Before System Prompt Generation");
        // 5. GENERACIÓN FINAL
        const isSelfChat = isSelfChatQuery; // Volvemos a la detección purista
        const brevityDirective = isSelfChat
            ? '\n- MODO ESPEJO: Responde como si fueras su propio clon digital. Sé breve, natural y directo. Si falta info, admítelo con naturalidad. PROHIBIDO decir "Soy una IA" o "No tengo acceso a tiempo real". Si no sabes algo de tu vida, di simplemente que no lo recuerdas ahora mismo.'
            : '\n- BREVEDAD: Responde de forma natural y concisa según el estilo del SOUL.';

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
        - ${directives}${brevityDirective}
        - AXIOMAS: ${axionas}
        - MATRICES: ${matrices}
        - PERFIL PSICOLÓGICO: ${psych}
        
        === REGLAS DE ORO ===
        1. MANTÉN EL PERSONAJE: Responde con el estilo, tono y emojis del SOUL.
        2. BREVEDAD HUMANA: Imita la longitud de los mensajes del dueño.
        3. CONTEXTO SOCIAL: Detecta con quién hablas y ajusta el trato.
        4. PROACTIVIDAD: Alinea respuestas con [GOALS].
        5. PROCEDIMIENTOS: Usa el [PLAYBOOK].
        6. RESONANCIA EMOCIONAL: Imita la vibración actual del usuario.
        7. EVIDENCIA MULTIMODAL: Tus recuerdos incluyen análisis de multimedia.
        
        === CONTEXTO DINÁMICO (MEMORIA EPISÓDICA) ===
        ${distilledKnowledge}
        
        === ESPEJO SEMÁNTICO (TU VOZ REAL) ===
        ${userStyleExamples || "Imita el estilo del SOUL."}${antiHallucinationDirective}`;

        // 5. BUCLE DE REFLEXIÓN
        const needsDeepReflection = false; // SPEED OVERRIDE

        if (!needsDeepReflection) {
            console.log(`⚡ [Reflection Skip] Generando respuesta directa.`);
            trace.addLLMCall();
            const directReply = await groqChat('llama-3.3-70b-versatile', [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ], { temperature: 0.3 });

            if (directReply) {
                await saveToSemanticCache(clientId, queryVector, text, directReply);
                await persistAssistantReply({
                    clientId,
                    senderId,
                    channel,
                    content: directReply,
                    metadata: {
                        reflection_attempts: 0,
                        reflection_approved: true,
                        fast_path: true,
                        rag_mode: 'legacy'
                    }
                });
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

                    audit = parseLLMJson(auditRaw, { approved: false, score: 0, conflict_detected: false, error: true });

                    if (audit.error) {
                        console.warn('⚠️ [Reflection] JSON roto, forzando reintento...');
                        retryCount++;
                        continue;
                    }

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
        await persistAssistantReply({
            clientId,
            senderId,
            channel,
            content: aiReply,
            metadata: {
                reflection_attempts: attempts,
                reflection_approved: isApproved,
                rag_mode: 'legacy'
            }
        });

        // 📊 RAG METRICS: Finalize and persist trace
        await trace.finish(aiReply);

        console.log(`✨ [Core Engine] Respuesta entregada con éxito.`);
        return aiReply;

    } catch (error) {
        console.error(`❌ [Core Engine] Crash:`, error.message);
        return null;
    }
}
