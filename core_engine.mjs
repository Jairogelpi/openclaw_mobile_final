import 'dotenv/config';
import fs from 'fs/promises';
import supabase from './config/supabase.mjs';
import groq from './services/groq.mjs';
import { decrypt } from './security.mjs';
import {
    generateEmbedding,
    reRankMemories,
    checkSemanticCache,
    saveToSemanticCache
} from './services/local_ai.mjs';
import { traverseGraph, hybridSearch } from './services/graph.service.mjs';

/**
 * RAG HÍBRIDO + GRAPHRAG (Estado del Arte 2026) + Anti-Alucinación
 */
async function getRelevantContext(clientId, userQuery, queryVector) {
    try {
        // 1. Lanzar AMBAS búsquedas en paralelo (latencia = max de las dos, no la suma)
        const [hybridResult, graphResult] = await Promise.allSettled([
            hybridSearch(clientId, userQuery, queryVector, 10),
            traverseGraph(clientId, userQuery, queryVector, 5)
        ]);

        // 2. Recoger resultados
        const hybridMemories = hybridResult.status === 'fulfilled'
            ? hybridResult.value
            : [];

        const graphKnowledge = graphResult.status === 'fulfilled'
            ? graphResult.value
            : [];

        if (hybridResult.status === 'rejected') console.warn('[RAG] Híbrido falló:', hybridResult.reason?.message);
        if (graphResult.status === 'rejected') console.warn('[RAG] GraphRAG falló:', graphResult.reason?.message);

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

        console.log(`🧠 [RAG] Candidatos: ${hybridMemories.length} híbridos + ${graphKnowledge.length} grafo = ${uniqueCandidates.length} únicos`);

        // 4. Re-Ranking local
        const rankedKnowledge = await reRankMemories(userQuery, uniqueCandidates);

        // 5. Top 7 fragmentos fusionados
        const top7 = rankedKnowledge.slice(0, 7);

        // 6. ANTI-ALUCINACIÓN
        const avgScore = top7.reduce((sum, k) => sum + (k.rerank_score || 0), 0) / (top7.length || 1);
        let confidenceLevel;
        if (avgScore > 0.5 && top7.length >= 3) {
            confidenceLevel = 'HIGH';
        } else if (avgScore > 0.1 || top7.length >= 1) {
            confidenceLevel = 'LOW';
        } else {
            confidenceLevel = 'NONE';
        }

        const contextBlock = top7.map(k => {
            if (k.source === 'GRAPH') {
                return `- 🕸️ GRAFO [Hop ${k.hop}]: ${k.content}`;
            }
            return `- 📝 MEMORIA [Score: ${k.similarity?.toFixed(2) || '?'}]: ${k.content}`;
        }).join('\n');

        return `[CONFIANZA_CONTEXTO: ${confidenceLevel}]\n${contextBlock}`;
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
    console.log(`🧠 [Core Engine] Procesando mensaje de ${channel} para ${clientSlug}${isSentByMe ? ' (Auto-Enviado)' : ''}`);

    try {
        if (isSentByMe) {
            console.log(`✍️ [Core Engine] Registrando mensaje enviado por el usuario para análisis de estilo.`);
            await supabase.from('raw_messages').insert([{
                client_id: clientId,
                sender_role: 'user_sent',
                content: text,
                remote_id: senderId,
                created_at: incomingEvent.metadata?.timestamp || new Date().toISOString()
            }]);
            return null;
        }

        // 0. EMBEDDING LOCAL
        const queryVector = await generateEmbedding(text, true);

        // 1. CACHÉ SEMÁNTICA
        const cachedReply = checkSemanticCache(clientId, queryVector);
        if (cachedReply) {
            console.log(`⚡ [Cache Semántica] ¡Acierto! Ahorro de API LLM.`);
            return cachedReply;
        }

        // 2. Recuperar la Identidad
        const clientDir = `./clients/${clientSlug}`;
        let soul = "", userProfile = "", memory = "";

        try {
            soul = decrypt(await fs.readFile(`${clientDir}/SOUL.md`, 'utf8'));
            userProfile = decrypt(await fs.readFile(`${clientDir}/USER.md`, 'utf8'));
            memory = decrypt(await fs.readFile(`${clientDir}/MEMORY.md`, 'utf8').catch(() => ""));
        } catch (e) {
            console.error(`❌ [Core Engine] Identidad corrupta o no encontrada para ${clientSlug}`);
            return "Lo siento, mi núcleo de memoria está inaccesible en este momento.";
        }

        // 3. RAG HÍBRIDO + GRAPHRAG
        const exactMemories = await getRelevantContext(clientId, text, queryVector);

        // 4. Prompt Sistema
        const systemPrompt = `
=== TU IDENTIDAD ===
${soul}

=== SOBRE TU DUEÑO ===
${userProfile}

=== MEMORIA A LARGO PLAZO ===
${memory}

=== RECUERDOS RELEVANTES (RAG) ===
${exactMemories}

=== CONTEXTO ===
- Plataforma: ${channel.toUpperCase()}
- Usuario ID: ${senderId}

=== REGLAS ANTI-ALUCINACIÓN ===
1. SOLO usa información explícita.
2. Si [CONFIANZA_CONTEXTO] es "NONE", di: "No tengo esa información en mis registros. ¿Podrías darme más contexto?"
3. Si [CONFIANZA_CONTEXTO] es "LOW", advierte: "Basándome en lo que recuerdo..."
4. NUNCA inventes datos.
5. Si no sabes algo, di "no lo sé".
`;

        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            temperature: 0.3,
            max_tokens: 1024
        });

        const aiReply = response.choices[0].message.content;

        // GUARDAR EN CACHÉ SEMÁNTICA
        saveToSemanticCache(clientId, queryVector, aiReply);

        // Guardar la conversación
        const senderLabel = incomingEvent.metadata?.isGroup
            ? `[Grupo] ${incomingEvent.metadata.pushName}`
            : incomingEvent.metadata?.pushName || senderId;

        await supabase.from('raw_messages').insert([
            {
                client_id: clientId,
                sender_role: senderLabel,
                content: text,
                remote_id: senderId,
                metadata: incomingEvent.metadata,
                created_at: incomingEvent.metadata?.timestamp || new Date().toISOString()
            },
            {
                client_id: clientId,
                sender_role: 'assistant',
                content: aiReply,
                remote_id: senderId
            }
        ]);

        console.log(`✨ [Core Engine] Respuesta generada para ${clientSlug}`);
        return aiReply;

    } catch (error) {
        console.error(`❌ [Core Engine] Error crítico:`, error.message);
        await supabase.from('system_logs').insert({
            level: 'ERROR',
            message: `Core Engine Crash: ${error.message} - Sender: ${senderId}`,
            client_id: clientId
        }).catch(() => { });
        return null;
    }
}

