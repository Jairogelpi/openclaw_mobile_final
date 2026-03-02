import 'dotenv/config';
import fs from 'fs/promises';
import supabase from './config/supabase.mjs';
import logger from './utils/logger.mjs';
import groq from './services/groq.mjs';
import { generateEmbedding } from './services/local_ai.mjs';

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
        .replace(/[<>{}\[\]\\^\`]/g, '') // Basic removal of structured syntax characters
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
 * RAG HÍBRIDO + GRAPHRAG (Estado del Arte 2026) + Anti-Alucinación
 */
async function getRelevantContext(clientId, userQuery, queryVector) {
    try {
        // 1. Lanzar AMBAS búsquedas en paralelo
        const [hybridResult, graphResult] = await Promise.allSettled([
            hybridSearch(clientId, userQuery, queryVector, 10),
            traverseGraph(clientId, userQuery, queryVector, 5)
        ]);

        const hybridMemories = hybridResult.status === 'fulfilled' ? hybridResult.value : [];
        const graphKnowledge = graphResult.status === 'fulfilled' ? graphResult.value : [];

        // 3. Fusionar y deduplicar
        const allCandidates = [...hybridMemories, ...graphKnowledge];
        if (!allCandidates.length) return "No hay recuerdos previos ni datos conocidos sobre este tema.";

        const seen = new Set();
        const uniqueCandidates = allCandidates.filter(c => {
            const key = (c.content || '').toLowerCase().slice(0, 100);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        console.log(`🧠[RAG] Candidatos: ${hybridMemories.length} híbridos + ${graphKnowledge.length} grafo = ${uniqueCandidates.length} únicos`);

        // 4. Re-Ranking local
        const rankedKnowledge = await reRankMemories(userQuery, uniqueCandidates);
        const top7 = rankedKnowledge.slice(0, 7);

        // 5. ANTI-ALUCINACIÓN
        const avgScore = top7.reduce((sum, k) => sum + (k.rerank_score || 0), 0) / (top7.length || 1);
        let confidenceLevel = avgScore > 0.5 && top7.length >= 3 ? 'HIGH' : (avgScore > 0.1 || top7.length >= 1 ? 'LOW' : 'NONE');

        const contextBlock = top7.map(k => {
            const prefix = k.source === 'GRAPH' ? `🕸️ GRAFO[Hop ${k.hop}]` : `📝 MEMORIA[Score: ${k.similarity?.toFixed(2) || '?'}]`;
            return `- ${prefix}: ${k.content} `;
        }).join('\n');

        return `[CONFIANZA_CONTEXTO: ${confidenceLevel}]\n${contextBlock} `;
    } catch (e) {
        console.error("[RAG] Error en pipeline Híbrido+GraphRAG:", e.message);
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

        // 1. CACHÉ SEMÁNTICA
        const cachedReply = checkSemanticCache(clientId, queryVector);
        if (cachedReply) {
            console.log(`⚡[Cache Semántica] ¡Acierto!`);
            return cachedReply;
        }

        // 2. Recuperar la Identidad (DB-First)
        const { data: soulData, error: soulError } = await supabase
            .from('user_souls')
            .select('soul_json, settings')
            .eq('client_id', clientId)
            .single();

        if (soulError || !soulData) {
            console.error(`❌ [Core Engine] Identidad no encontrada en DB para ${clientId}`);
            return "Lo siento, mi núcleo de memoria está inaccesible.";
        }

        const soulJson = soulData.soul_json || {};
        const soul = JSON.stringify(soulJson);
        const userProfile = JSON.stringify(soulJson.profile || "{}"); // Simplified profile
        const memory = JSON.stringify(soulJson.key_facts || "{}");

        // 3. ADVANCED AGENTIC RAG: "EL CIRUJANO"
        console.log(`🧭 [Agentic RAG V2] Buscando contexto en profundidad...`);
        let accumulatedContext = "";
        let iterations = 0;
        const maxIterations = 2;
        let searchIsDone = false;
        let lastFeedback = "Ninguno";

        while (iterations < maxIterations && !searchIsDone) {
            iterations++;
            const agenticPrompt = `Eres el Cirujano de Memoria de OpenClaw. Recupera información EXACTA.
HISTORIAL PREVIO: ${lastFeedback}
MENSAJE USUARIO: "${text}"

TAREAS:
1. ¿Contexto acumulado suficiente?
2. ¿Qué falta?
3. Plan de búsqueda (2 queries).
4. ¿Necesitas búsqueda WEB externa (NOTICIAS, TIEMPO, PRECIOS, o si NO hay nada local)? Active "needs_web_search".

Responde JSON:
{
  "needs_more_info": boolean,
  "needs_web_search": boolean,
  "reasoning": "string",
  "optimized_queries": ["q1", "q2"],
  "confidence_score": 0-1
}`;

            try {
                const agenticRaw = await groqChat('llama-3.3-70b-versatile', [
                    { role: 'system', content: agenticPrompt },
                    { role: 'system', content: `CONTEXTO ACTUAL:\n${accumulatedContext || 'Vacío'}` }
                ], { temperature: 0.1, response_format: { type: 'json_object' } });

                const decision = JSON.parse(agenticRaw);
                console.log(`🧐 [Agentic RAG] Iter ${iterations}: ${decision.reasoning}`);

                if (!decision.needs_more_info && iterations === 1 && !text.includes('?')) {
                    accumulatedContext = "[CONFIANZA: N/A] Charla trivial.";
                    searchIsDone = true;
                    break;
                }

                if (!decision.needs_more_info && accumulatedContext) {
                    searchIsDone = true;
                    break;
                }

                const queries = decision.optimized_queries || [text];
                const results = await Promise.all(queries.map(async (q) => {
                    const vec = await generateEmbedding(q, true);
                    return await getRelevantContext(clientId, q, vec);
                }));

                accumulatedContext += "\n" + results.join("\n---\n");

                if (decision.needs_web_search) {
                    console.log(`🌐 [Agentic RAG] Investigando en la web...`);
                    const webResults = await searchWeb(queries[0] || text);
                    if (webResults) accumulatedContext += `\n\n[WEB]:\n${webResults}`;
                }

                if (decision.confidence_score > 0.9) searchIsDone = true;
                lastFeedback = `Busqué "${queries.join(', ')}".`;
            } catch (err) {
                console.error(`⚠️ [Agentic RAG] Error:`, err.message);
                searchIsDone = true;
            }
        }

        // 4. DESTILACIÓN
        console.log(`🧪 [Architect RAG] Destilando contexto...`);
        let distilledKnowledge = "";
        try {
            distilledKnowledge = await groqChat('llama-3.3-70b-versatile', [
                { role: 'system', content: `Destila el contexto en un "Núcleo de Hechos" breve.` },
                { role: 'user', content: `CONTEXTO:\n${accumulatedContext}` }
            ], { temperature: 0.1 });
        } catch (e) {
            distilledKnowledge = accumulatedContext;
        }

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

        const systemPrompt = `
=== IDENTIDAD Y VOZ ===
${soul}
${styleInfo}

EJEMPLOS REALES DE CÓMO ESCRIBE EL DUEÑO (IMÍTALO EXACTAMENTE):
${userStyleExamples || "No hay ejemplos aún."}

=== DUEÑO (INFO PERSONAL) ===
${userProfile}

=== MEMORIA Y CONTEXTO ===
${distilledKnowledge}

REGLAS DE ORO:
1. MANTÉN EL PERSONAJE: Responde con el estilo, tono y emojis que viste arriba.
2. BREVEDAD Y FORMATO: Si el dueño escribe en minúsculas y sin puntos, HAZ LO MISMO.
3. CITA DATOS: [Fuente: Memoria] si usas info guardada.
4. NO PAREZCAS IA: No digas "Como IA...", no seas excesivamente amable si el dueño no lo es.`;

        // 5. BUCLE DE REFLEXIÓN (DRAFT -> CRITIQUE -> REFINE)
        console.log(`🧠 [Reflection Loop] Iniciando ciclo de identidad espejo profunda...`);

        let aiReply = "";
        let isApproved = false;
        let attempts = 0;
        let history = [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];

        while (!isApproved && attempts < 2) {
            attempts++;
            console.log(`✍️ [Reflection] Intento ${attempts}: Generando borrador...`);

            aiReply = await groqChat('llama-3.3-70b-versatile', history, { temperature: 0.3 });

            // CRÍTICA INTERNA - Enfocada en Identidad
            const critiquePrompt = `Eres el Auditor de Identidad de OpenClaw. Tu objetivo es el "Espejo Semántico Perfecto".
            
            PERFIL DE ESTILO REQUERIDO:
            ${styleInfo}
            
            EJEMPLOS REALES DEL DUEÑO:
            ${userStyleExamples}
            
            RESPUESTA A EVALUAR: "${aiReply}"
            
            TAREA: Evalúa la respuesta en una escala de 0 a 10 en los siguientes criterios:
            1. TONO: ¿Coincide con la personalidad detectada?
            2. FORMATO: ¿Usa las mismas mayúsculas y puntuación?
            3. EMOJIS: ¿Usa la cantidad y tipo correctos?
            4. FLUIDEZ: ¿Suena a humano o a asistente IA?
            
            REGLA DE ORO: Si la respuesta empieza con "Como asistente..." o es demasiado servicial, CALIFICA 0.
            
            Responde JSON: { "approved": boolean, "score": number, "critique": "string", "suggestions": "string" }`;

            let audit = { approved: false, score: 0 };
            let retryCount = 0;
            const MAX_AUDIT_RETRIES = 2;

            while (!audit.approved && retryCount <= MAX_AUDIT_RETRIES) {
                try {
                    const auditRaw = await groqChat('llama-3.3-70b-versatile', [
                        { role: 'system', content: critiquePrompt }
                    ], {
                        temperature: 0.1 + (retryCount * 0.2),
                        response_format: { type: 'json_object' }
                    });

                    audit = parseLLMJson(auditRaw);

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

        saveToSemanticCache(clientId, queryVector, aiReply);
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

        console.log(`✨ [Core Engine] Respuesta entregada con éxito.`);
        return aiReply;

    } catch (error) {
        console.error(`❌ [Core Engine] Crash:`, error.message);
        return null;
    }
}
