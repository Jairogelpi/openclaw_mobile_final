import supabase from '../config/supabase.mjs';
import redisClient from '../config/redis.mjs';
import groq from '../services/groq.mjs';
import { cosineSimilarity } from '../utils/math.mjs';

// Cache para Smart Reply (10 mins)
const smartReplyCache = new Map();
setInterval(() => smartReplyCache.clear(), 10 * 60 * 1000);

// Cache para estilos de escritura (1 hora)
const contactPersonaCache = new Map();
setInterval(() => contactPersonaCache.clear(), 60 * 60 * 1000);

// Basic Rate Limiting
const rateLimits = new Map();
function checkRateLimit(clientId) {
    const now = Date.now();
    const records = rateLimits.get(clientId) || [];
    const validRecords = records.filter(t => now - t < 60000); // last minute
    if (validRecords.length >= 10) return false;
    validRecords.push(now);
    rateLimits.set(clientId, validRecords);
    return true;
}

export async function getInboxSummaries(req, res) {
    try {
        const clientId = req.user.clientId;
        const { data, error } = await supabase
            .from('inbox_summaries')
            .select('*')
            .eq('client_id', clientId)
            .order('last_updated', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

export async function getInboxHistory(req, res) {
    try {
        const clientId = req.user.clientId;
        const { remoteId } = req.params;

        // Consultamos user_memories filtrando por el remoteId en el JSONB de metadata
        const { data, error } = await supabase
            .from('user_memories')
            .select('content, sender, created_at')
            .eq('client_id', clientId)
            .contains('metadata', { remoteId: remoteId })
            .order('created_at', { ascending: true })
            .limit(30);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

export async function generateSmartReply(req, res) {
    try {
        const clientId = req.user.clientId;

        // Rate limit: 10 req/min per user
        if (!checkRateLimit(clientId)) {
            return res.status(429).json({ error: 'Rate limit exceeded. Max 10 requests per minute.' });
        }

        const { remoteId, lastMessage } = req.body;

        console.log(`🧠 [Smart Reply] Pipeline completo para ${remoteId}`);

        // ══════════════════════════════════════════════
        // 0. SEMANTIC CACHE CHECK
        // ══════════════════════════════════════════════
        const { pipeline: transformersPipeline } = await import('@huggingface/transformers');
        let localEmbedder = global.__smartReplyEmbedder;
        if (!localEmbedder) {
            console.log('🧠 [Smart Reply] Inicializando embedder...');
            localEmbedder = await transformersPipeline('feature-extraction', 'Xenova/nomic-embed-text-v1.5', { quantized: true });
            global.__smartReplyEmbedder = localEmbedder;
        }
        const embedQuery = async (text) => {
            const output = await localEmbedder('search_query: ' + text, { pooling: 'mean', normalize: true });
            return Array.from(output.data);
        };

        const queryVector = await embedQuery(lastMessage);
        const cachePrefix = `${clientId}:${remoteId}`;

        // Scan cache for semantically similar queries
        for (const [key, cached] of smartReplyCache.entries()) {
            if (key.startsWith(cachePrefix) && cached.vector) {
                const sim = cosineSimilarity(queryVector, cached.vector);
                if (sim > 0.92) {
                    console.log(`⚡ [Cache HIT] Similitud ${sim.toFixed(3)} — respuesta instantánea`);
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                    });
                    // Stream cached response word by word (fast)
                    const words = cached.draft.split(' ');
                    for (const word of words) {
                        res.write(`data: ${JSON.stringify({ token: word + ' ' })}\n\n`);
                    }
                    res.write(`data: [DONE]\n\n`);
                    res.end();
                    return;
                }
            }
        }

        // ══════════════════════════════════════════════
        // 0b. INTENT CLASSIFICATION (zero-latency, regex-based)
        // ══════════════════════════════════════════════
        const msgLower = lastMessage.toLowerCase().trim();
        const INTENT_PATTERNS = {
            GREETING: /^(hola|hey|buenas?|qué tal|q tal|holi|wena|ey|hi|hello|buenos días|buenas tardes|buenas noches|saludos)\b/i,
            ACKNOWLEDGMENT: /^(ok|vale|va|sí|si|claro|perfecto|genial|dale|listo|bien|bueno|entendido|de acuerdo|jaja|jeje|😂|👍|🙌|👌|💪)\s*[.!]?$/i,
            QUESTION: /\?|cómo|cuándo|dónde|por qué|qué|quién|cuál|cuántos?|puedes?|sabes?|tienes?/i,
            EMOTIONAL: /❤|😢|😊|🥺|😡|te quiero|te extraño|te amo|lo siento|perdón|gracias|ánimo|fuerza|🙏|💔|😭|🥰/i,
            REQUEST: /manda|envía|pasa|hazme|necesito|quiero|podrías|puedes|ayuda|urgente/i,
        };

        let messageIntent = 'GENERAL';
        for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
            if (pattern.test(msgLower)) {
                messageIntent = intent;
                break;
            }
        }

        const isTrivalIntent = messageIntent === 'GREETING' || messageIntent === 'ACKNOWLEDGMENT';
        console.log(`🏷️ [Intent] "${lastMessage.slice(0, 30)}..." → ${messageIntent}${isTrivalIntent ? ' (FAST PATH)' : ''}`);

        // ══════════════════════════════════════════════
        // 1. PARALLEL INIT: Soul + Conversation History + Multi-Query
        // ══════════════════════════════════════════════
        // For trivial intents, skip multi-query (saves ~500ms + Groq tokens)
        const initPromises = [
            supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single(),
            supabase.from('user_memories')
                .select('content, sender, created_at')
                .eq('client_id', clientId)
                .contains('metadata', { remoteId: remoteId })
                .order('created_at', { ascending: false })
                .limit(10),
        ];

        // Only run multi-query for non-trivial intents
        if (!isTrivalIntent) {
            initPromises.push(
                groq.chat.completions.create({
                    model: 'llama-3.1-8b-instant',
                    messages: [{
                        role: 'system',
                        content: `Eres un experto en búsqueda semántica. Dado un mensaje de WhatsApp, genera exactamente 3 reformulaciones que capturen diferentes aspectos semánticos del mensaje para buscar en una base de memoria.
REGLAS:
- Cada reformulación debe enfocarse en un ángulo diferente (intención, tema, emoción)
- Mantén el contexto en español
- Devuelve SOLO un JSON: {"queries": ["q1", "q2", "q3"]}`
                    }, {
                        role: 'user',
                        content: `Mensaje: "${lastMessage}"`
                    }],
                    response_format: { type: 'json_object' },
                    temperature: 0.3,
                    max_tokens: 200,
                })
            );
        }

        const initResults = await Promise.allSettled(initPromises);
        const [soulResult, historyResult] = initResults;
        const mqResult = initResults[2] || { status: 'skipped' };

        const soul = (soulResult.status === 'fulfilled' && soulResult.value.data?.soul_json) || {};

        const conversationHistory = (historyResult.status === 'fulfilled' && !historyResult.value.error)
            ? (historyResult.value.data || []).reverse()
            : [];
        console.log(`💬 [Context] ${conversationHistory.length} mensajes de historial`);

        // ══════════════════════════════════════════════
        // 1b. PERSONA PER CONTACT: Auto-detect style
        // ══════════════════════════════════════════════
        const personaKey = `${clientId}:${remoteId}`;
        let contactPersona = contactPersonaCache.get(personaKey) || null;

        if (!contactPersona && conversationHistory.length >= 3) {
            // Extract only user-sent messages to analyze THEIR style
            const userMsgs = conversationHistory
                .filter(m => m.sender === 'user' || m.sender === 'me' || m.sender === 'Mí mismo')
                .map(m => m.content)
                .slice(0, 15);

            if (userMsgs.length >= 3) {
                try {
                    const styleResp = await groq.chat.completions.create({
                        model: 'llama-3.1-8b-instant',
                        messages: [{
                            role: 'system',
                            content: `Analiza el estilo de escritura de esta persona en WhatsApp con este contacto específico.

Devuelve SOLO un JSON con estos campos:
{
  "formalidad": "muy_formal | formal | neutro | informal | muy_informal",
  "tono": "serio | profesional | amigable | bromista | cariñoso | seco",
  "largo_mensajes": "muy_corto | corto | medio | largo",
  "emojis": "nunca | raro | a_veces | frecuente | excesivo",
  "saludo_tipico": "ejemplo de cómo saluda",
  "muletillas": ["palabras o frases que repite"],
  "resumen": "una frase describiendo el estilo general"
}`
                        }, {
                            role: 'user',
                            content: `Mensajes del usuario con este contacto:\n${userMsgs.join('\n')}`
                        }],
                        response_format: { type: 'json_object' },
                        temperature: 0.1,
                        max_tokens: 250,
                    });

                    contactPersona = JSON.parse(styleResp.choices[0].message.content);
                    contactPersonaCache.set(personaKey, contactPersona);
                    console.log(`🎭 [Persona] ${remoteId.slice(0, 12)}...: ${contactPersona.resumen || contactPersona.tono}`);
                } catch (e) {
                    console.warn('[Persona] Fallback:', e.message);
                }
            }
        } else if (contactPersona) {
            console.log(`🎭 [Persona Cache] ${remoteId.slice(0, 12)}...: ${contactPersona.resumen || 'cached'}`);
        }

        let searchQueries = [lastMessage];
        if (mqResult.status === 'fulfilled') {
            try {
                const parsed = JSON.parse(mqResult.value.choices[0].message.content);
                if (parsed.queries?.length) searchQueries = [lastMessage, ...parsed.queries.slice(0, 3)];
            } catch (e) { /* fallback */ }
        }
        console.log(`🔍 [Multi-Query] ${searchQueries.length} queries`);

        // ══════════════════════════════════════════════
        // 2. EMBEDDING + PARALLEL SEARCH (Hybrid + GraphRAG)
        // ══════════════════════════════════════════════
        let localReRanker = global.__smartReplyReRanker;
        if (!localReRanker) {
            console.log('🧠 [Smart Reply] Inicializando re-ranker (BGE)...');
            localReRanker = await transformersPipeline('text-classification', 'Xenova/bge-reranker-base', { quantized: true });
            global.__smartReplyReRanker = localReRanker;
        }

        // Embed remaining queries (queryVector for original already computed in cache check)
        const otherVectors = await Promise.all(searchQueries.slice(1).map(q => embedQuery(q)));
        const queryVectors = [queryVector, ...otherVectors];

        // Launch Hybrid + GraphRAG in parallel for each query
        // For trivial intents: only 1 hybrid search, no GraphRAG (saves ~1s)
        const searchPromises = isTrivalIntent
            ? [supabase.rpc('hybrid_search_memories', {
                query_text: lastMessage,
                query_embedding: queryVector,
                match_count: 5,
                p_client_id: clientId,
            })]
            : queryVectors.flatMap((vec, i) => [
                supabase.rpc('hybrid_search_memories', {
                    query_text: searchQueries[i],
                    query_embedding: vec,
                    match_count: 8,
                    p_client_id: clientId,
                }),
                supabase.rpc('graphrag_traverse', {
                    query_text: searchQueries[i],
                    query_embedding: vec,
                    match_count: 5,
                    p_client_id: clientId,
                }),
            ]);

        const searchResults = await Promise.allSettled(searchPromises);

        let allMemories = [];
        let graphKnowledge = [];

        searchResults.forEach((result, idx) => {
            if (result.status !== 'fulfilled' || result.value.error || !result.value.data) return;
            const isGraph = idx % 2 === 1;
            if (isGraph) {
                graphKnowledge.push(...result.value.data.map(g => ({
                    content: g.knowledge, sender: g.entity_type,
                    similarity: null, hop: g.hop, source: 'GRAPH'
                })));
            } else {
                allMemories.push(...result.value.data.map(m => ({ ...m, source: 'HYBRID' })));
            }
        });

        console.log(`📡 [Search] ${allMemories.length} híbridos + ${graphKnowledge.length} grafo`);

        // ══════════════════════════════════════════════
        // 3. DEDUP + TIME-DECAY + CONTACT BOOST
        // ══════════════════════════════════════════════
        const now = new Date();
        const dedupMap = new Map();
        for (const mem of allMemories) {
            const key = (mem.content || '').toLowerCase().slice(0, 100);
            const existing = dedupMap.get(key);
            if (!existing || (mem.similarity || 0) > (existing.similarity || 0)) {
                dedupMap.set(key, mem);
            }
        }

        let uniqueMemories = Array.from(dedupMap.values()).map(mem => {
            const meta = mem.metadata || {};
            const isSameContact = meta.remoteId === remoteId;
            const contactBoost = isSameContact ? 1.3 : 1.0;
            const memDate = new Date(meta.dateEnd || meta.dateStart || mem.created_at || now);
            const daysAgo = Math.max(0, (now - memDate) / (1000 * 60 * 60 * 24));
            const decayFactor = Math.exp(-0.02 * daysAgo);
            const finalScore = (mem.similarity || 0) * decayFactor * contactBoost;
            return { ...mem, finalScore, daysAgo: Math.round(daysAgo), isSameContact };
        });

        uniqueMemories.sort((a, b) => b.finalScore - a.finalScore);

        // ══════════════════════════════════════════════
        // 4. RE-RANKER (BGE): Precision filter
        // ══════════════════════════════════════════════
        const candidates = uniqueMemories.slice(0, 15);
        let reranked = candidates;
        if (candidates.length > 0) {
            try {
                const pairs = candidates.map(m => [lastMessage, m.content]);
                const scores = await localReRanker(pairs);
                reranked = candidates.map((m, i) => ({
                    ...m,
                    rerankScore: scores[i].score,
                    combinedScore: m.finalScore * 0.4 + scores[i].score * 0.6,
                }));
                reranked.sort((a, b) => b.combinedScore - a.combinedScore);
                console.log(`🎯 [Re-Ranker] Top scores: [${reranked.slice(0, 5).map(m => m.rerankScore.toFixed(3)).join(', ')}]`);
            } catch (e) {
                console.warn('[Re-Ranker] Fallback:', e.message);
            }
        }

        const topMemories = reranked.slice(0, 7);

        // ══════════════════════════════════════════════
        // 4b. ANTI-HALLUCINATION: Confidence level
        // ══════════════════════════════════════════════
        const avgRerankScore = topMemories.reduce((sum, m) => sum + (m.rerankScore || 0), 0) / (topMemories.length || 1);
        let confidenceLevel;
        if (avgRerankScore > 0.5 && topMemories.length >= 3) {
            confidenceLevel = 'HIGH';
        } else if (avgRerankScore > 0.1 || topMemories.length >= 1) {
            confidenceLevel = 'LOW';
        } else {
            confidenceLevel = 'NONE';
        }
        console.log(`🛡️ [Anti-Alucinación] Confianza: ${confidenceLevel} (avg rerank: ${avgRerankScore.toFixed(3)}, ${topMemories.length} memorias)`);

        const graphSeen = new Set();
        const uniqueGraph = graphKnowledge.filter(g => {
            const key = (g.content || '').toLowerCase().slice(0, 80);
            if (graphSeen.has(key)) return false;
            graphSeen.add(key);
            return true;
        }).slice(0, 5);

        console.log(`🎯 [Final] ${topMemories.length} memorias + ${uniqueGraph.length} grafo`);

        // ══════════════════════════════════════════════
        // 5. BUILD CONTEXT + STREAM RESPONSE
        // ══════════════════════════════════════════════
        const memCtx = topMemories.length > 0
            ? topMemories.map(m => {
                const badge = m.isSameContact ? '🎯' : '📝';
                const age = m.daysAgo === 0 ? 'Hoy' : m.daysAgo === 1 ? 'Ayer' : `Hace ${m.daysAgo}d`;
                return `${badge} [${age} | Score: ${(m.combinedScore || m.finalScore).toFixed(3)}]: ${m.content}`;
            }).join('\n')
            : 'Sin memorias relevantes.';

        const graphCtx = uniqueGraph.length > 0
            ? uniqueGraph.map(g => `🕸️ [Grafo, Hop ${g.hop}]: ${g.content}`).join('\n')
            : '';

        const convFlow = conversationHistory.length > 0
            ? conversationHistory.map(m => `[${m.sender}]: ${m.content}`).join('\n')
            : 'Sin historial previo con este contacto.';

        // Anti-hallucination instruction based on confidence
        const confidenceInstruction = confidenceLevel === 'HIGH'
            ? 'Tienes datos sólidos. Responde con confianza usando el contexto RAG.'
            : confidenceLevel === 'LOW'
                ? 'Datos parciales. Responde con cautela. Si no estás seguro de algo, responde de forma natural sin inventar (ej. "déjame ver", "no me acuerdo bien").'
                : 'SIN DATOS RELEVANTES. NO inventes hechos ni detalles. Responde de forma genérica y natural como lo haría el usuario. Puedes decir cosas como "dame un momento", "luego te digo", o simplemente responder al tono del mensaje.';

        // Intent-specific strategy instruction
        const intentStrategies = {
            GREETING: 'Es un SALUDO. Responde de forma breve y cálida, como el usuario saludaría a este contacto. No necesitas contexto RAG.',
            ACKNOWLEDGMENT: 'Es un ACK/respuesta corta. Responde brevísimamente (1-3 palabras). Ej: "dale", "va", "perfecto".',
            QUESTION: 'Es una PREGUNTA. Usa todo el contexto disponible para dar una respuesta informativa y precisa.',
            EMOTIONAL: 'Es un mensaje EMOCIONAL. Responde con empatía y calidez, acorde al estilo del usuario.',
            REQUEST: 'Es una PETICIÓN. Responde de forma útil y directa.',
            GENERAL: 'Responde de forma natural acorde al flujo de la conversación.',
        };

        const prompt = `
        SISTEMA: Eres la "Sombra Digital" del usuario. Tu misión es redactar un mensaje de WhatsApp que él enviaría.
        
        [TIPO DE MENSAJE: ${messageIntent}]
        ${intentStrategies[messageIntent]}

        [NIVEL DE CONFIANZA DEL CONTEXTO: ${confidenceLevel}]
        ${confidenceInstruction}

        IDENTIDAD DEL USUARIO (SOUL):
        ${JSON.stringify(soul)}
        ${contactPersona ? `
        ESTILO CON ESTE CONTACTO (detectado automáticamente):
        - Formalidad: ${contactPersona.formalidad || 'desconocido'}
        - Tono: ${contactPersona.tono || 'desconocido'}
        - Largo de mensajes: ${contactPersona.largo_mensajes || 'desconocido'}
        - Uso de emojis: ${contactPersona.emojis || 'desconocido'}
        - Saludo típico: "${contactPersona.saludo_tipico || 'N/A'}"
        - Muletillas: ${(contactPersona.muletillas || []).join(', ') || 'ninguna'}
        ⚠️ IMPORTANTE: Adapta tu respuesta a ESTE estilo específico. No uses el estilo general del SOUL si contradice el estilo con este contacto.
        ` : ''}
        HISTORIAL RECIENTE CON ESTE CONTACTO:
        ${convFlow}
        
        RECUERDOS RELEVANTES (Re-Ranked por precisión):
        ${memCtx}
        ${graphCtx ? `\nCONOCIMIENTO RELACIONAL (Grafo del Alma):\n${graphCtx}` : ''}
        
        ÚLTIMO MENSAJE DEL CONTACTO (${remoteId}):
        "${lastMessage}"
        
        REGLAS DE ORO:
        1. Escribe en PRIMERA PERSONA como si fueras el usuario.
        2. Usa el estilo exacto del usuario según su SOUL y el historial.
        3. ${confidenceLevel === 'NONE' ? 'NO TIENES CONTEXTO. No inventes NADA. Responde genéricamente.' : 'Usa SOLO la información del RAG. Los recuerdos 🎯 son del MISMO contacto — priorízalos.'}
        4. Sé BREVE. Es WhatsApp.
        5. SOLO devuelve el texto del mensaje. Sin comentarios, sin comillas.
        `;

        // ══════════════════════════════════════════════
        // 5. STAGE 1: INTERNAL DRAFT (Fast 8b Model)
        // ══════════════════════════════════════════════
        console.log(`🧠 [Self-Refine] Etapa 1: Drafteo interno (8b)...`);
        const draftResponse = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'system', content: prompt }],
            temperature: 0.7,
            max_tokens: 300,
        });
        const internalDraft = draftResponse.choices[0].message.content;
        console.log(`📝 [Self-Refine] Draft: "${internalDraft.slice(0, 50)}..."`);

        // ══════════════════════════════════════════════
        // 6. STAGE 2: CRITIQUE & STREAMING REFINE (Powerful 70b Model)
        // ══════════════════════════════════════════════
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const refinementPrompt = `
        ERES UN REFINADOR DE ESTILO. Tu objetivo es tomar un borrador de IA y convertirlo en un mensaje de WhatsApp que el usuario REALMENTE enviaría.
        
        IDENTIDAD DEL USUARIO (SOUL):
        ${JSON.stringify(soul)}
        
        ESTILO ESPECÍFICO CON ESTE CONTACTO:
        ${contactPersona ? JSON.stringify(contactPersona) : 'No hay datos específicos, usa el SOUL general.'}
        
        ÚLTIMO HISTORIAL:
        ${convFlow.slice(-1000)}

        MENSAJE ORIGINAL DEL CONTACTO:
        "${lastMessage}"

        BORRADOR INICIAL (A REFINAR):
        "${internalDraft}"

        REGLAS DE REFINADO (CERO "AI-ISMS"):
        1. ELIMINA cualquier rastro de IA: "¡Claro!", "Espero que estés bien", "Entiendo que...", "Aquí tienes...", "Me alegra...".
        2. ELIMINA explicaciones innecesarias o disculpas.
        3. AJUSTA la longitud y formalidad al "ESTILO ESPECÍFICO CON ESTE CONTACTO".
        4. USA las muletillas y emojis indicados en el perfil de estilo.
        5. Si el borrador inicial parece robótico o demasiado largo, acórtalo y hazlo directo.
        6. SOLO devuelve el texto refinado. Sin comillas ni explicaciones.
        `;

        console.log(`✨ [Self-Refine] Etapa 2: Refinado y streaming (70b)...`);
        const stream = await groq.chat.completions.create({
            model: 'llama-3.1-70b-versatile',
            messages: [{ role: 'system', content: refinementPrompt }],
            temperature: 0.5, // Lower temperature for more consistent refinement
            max_tokens: 400,
            stream: true,
        });

        let fullDraft = '';
        for await (const chunk of stream) {
            const token = chunk.choices[0]?.delta?.content;
            if (token) {
                fullDraft += token;
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
            }
        }

        res.write(`data: [DONE]\n\n`);
        res.end();

        // Cache the full response for future similar queries
        smartReplyCache.set(`${cachePrefix}:${Date.now()}`, {
            vector: queryVector,
            draft: fullDraft,
        });
    } catch (err) {
        console.error('[Smart Reply Pipeline Error]', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }
    }
}
