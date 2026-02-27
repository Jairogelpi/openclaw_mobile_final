import 'dotenv/config';
import { createClient as createRedisClient } from 'redis';
import supabase from './config/supabase.mjs';
import groq from './services/groq.mjs';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);
import { encrypt, decrypt } from './security.mjs';
import crypto from 'node:crypto';
import { generateEmbedding, cosineSimilarity } from './services/local_ai.mjs';

// No local initializations needed anymore as they are in config/services

// Guarda un Nodo en Supremo y retorna su ID
async function upsertKnowledgeNode(clientId, entityName, entityType, description) {
    // Verificar si existe para no duplicar
    const { data: existing } = await supabase
        .from('knowledge_nodes')
        .select('id')
        .eq('client_id', clientId)
        .eq('entity_name', entityName)
        .single();

    if (existing) return existing.id;

    // Generar el vector del nodo
    const embedding = await generateEmbedding(entityName + " " + (description || ""));

    const { data: inserted, error } = await supabase.from('knowledge_nodes').insert({
        client_id: clientId,
        entity_name: entityName,
        entity_type: entityType,
        description: description,
        embedding: embedding
    }).select('id').single();

    if (error) {
        console.error('❌ [Graph] Error insertando nodo:', error.message);
        return null;
    }
    return inserted.id;
}

// Crea una relación entre dos nodos
async function upsertKnowledgeEdge(clientId, sourceId, targetId, relationType) {
    if (!sourceId || !targetId) return;

    // Evitar relaciones circulares simples o duplicados idénticos en el mismo sentido
    const { data: existing } = await supabase
        .from('knowledge_edges')
        .select('id')
        .eq('source_node', sourceId)
        .eq('target_node', targetId)
        .eq('relation_type', relationType)
        .single();

    if (existing) return;

    await supabase.from('knowledge_edges').insert({
        client_id: clientId,
        source_node: sourceId,
        target_node: targetId,
        relation_type: relationType
    });
}

// === AUTONOMOUS KNOWLEDGE DISTILLATION (AUTO-SOUL) ===
async function autonomousDistillation(clientId, clientSlug, messages) {
    if (!messages?.length) return;

    console.log(`🍯 [Auto-Soul] Destilando conocimiento de ${messages.length} mensajes para ${clientSlug}...`);

    try {
        // 1. Obtener SOUL actual
        const { data: soulRow } = await supabase
            .from('user_souls')
            .select('soul_json')
            .eq('client_id', clientId)
            .single();

        const currentSoul = soulRow?.soul_json || {};

        // 2. Extraer hechos y tripletes con LLM (70b para máxima precisión)
        const textBlock = messages.map(m => `${m.sender_role}: ${m.content}`).join('\n');

        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{
                role: 'system',
                content: `Eres un extractor de conocimiento experto de OpenClaw. Tu misión es extraer hechos sobre el USUARIO y relaciones para su Grafo de Conocimiento.
                
                SOUL ACTUAL DEL USUARIO:
                ${JSON.stringify(currentSoul)}
                
                CONVERSACIÓN RECIENTE:
                ${textBlock}
                
                INSTRUCCIONES:
                1. "soul_patch": Identifica nuevos rasgos, preferencias, alergias, pasatiempos o hechos fijos del usuario. No repitas lo que ya está en el SOUL. Devuelve un JSON con CAMPOS NUEVOS o ACTUALIZADOS.
                2. "triplets": Identifica relaciones semánticas importantes. Formato: [Sujeto, Predicado, Objeto]. 
                   Sujeto SIEMPRE debe ser "Usuario" si el hecho es sobre el dueño de la cuenta. 
                   Ejemplo: ["Usuario", "GUSTA_DE", "Café"], ["Usuario", "HIJO_DE", "Pedro"].
                
                Devuelve SOLO un JSON con este formato:
                {
                  "soul_patch": { "campo": "valor" },
                  "triplets": [ ["S", "P", "O"], ... ]
                }`
            }],
            response_format: { type: 'json_object' },
            temperature: 0.1
        });

        const result = JSON.parse(response.choices[0].message.content);

        // 3. Aplicar Parche al SOUL
        if (result.soul_patch && Object.keys(result.soul_patch).length > 0) {
            const updatedSoul = { ...currentSoul, ...result.soul_patch };

            // A. Guardar en DB
            await supabase
                .from('user_souls')
                .update({ soul_json: updatedSoul })
                .eq('client_id', clientId);

            // B. Sincronizar con SOUL.md (Cifrado)
            const soulPath = path.join('./clients', clientSlug, 'SOUL.md');
            const soulText = JSON.stringify(updatedSoul, null, 2);
            await fs.writeFile(soulPath, encrypt(soulText));

            console.log(`✨ [Auto-Soul] Soul actualizado:`, Object.keys(result.soul_patch));
        }

        // 4. Upsert en el Grafo
        if (result.triplets && result.triplets.length > 0) {
            for (const [s, p, o] of result.triplets) {
                const sId = await upsertKnowledgeNode(clientId, s, 'ENTITY', '');
                const oId = await upsertKnowledgeNode(clientId, o, 'ENTITY', '');
                await upsertKnowledgeEdge(clientId, sId, oId, p);
            }
            console.log(`🕸️ [Auto-Soul] ${result.triplets.length} tripletes añadidos al grafo.`);
        }

    } catch (e) {
        console.error('❌ [Auto-Soul] Error en destilación:', e.message);
    }
}

// === DISTILL + GRAPHRAG VECTORIZE + INBOX SUMMARIES ===
async function distillAndVectorize(clientId) {
    // Obtener slug del cliente para rutas de archivos
    const { data: client } = await supabase.from('clients').select('slug').eq('id', clientId).single();
    if (!client) return;
    const clientSlug = client.slug;

    console.log(`\n🧠 [Memory Worker] Procesando memoria e inbox para: ${clientSlug}`);

    try {
        // 1. Obtener mensajes sin procesar
        const { data: messages } = await supabase
            .from('raw_messages')
            .select('*') // Necesitamos remote_id y sender_role ahora
            .eq('client_id', clientId)
            .order('created_at', { ascending: true });

        if (!messages?.length) {
            console.log(`🏝️ Sin mensajes pendientes para ${clientId}.`);
            return;
        }

        // --- PARTE A: RESÚMENES PARA EL INBOX ---
        // Agrupamos por conversación (remote_id)
        const conversations = {};
        messages.forEach(m => {
            if (!conversations[m.remote_id]) {
                conversations[m.remote_id] = {
                    messages: [],
                    lastSender: m.sender_role,
                    lastText: m.content,
                    avatarUrl: m.metadata?.avatarUrl || null // Extraer avatar del primer mensaje
                };
            }
            conversations[m.remote_id].messages.push(`${m.sender_role}: ${m.content}`);
            conversations[m.remote_id].lastSender = m.sender_role;
            conversations[m.remote_id].lastText = m.content;
            if (m.metadata?.avatarUrl) {
                conversations[m.remote_id].avatarUrl = m.metadata.avatarUrl; // Actualizar con el más reciente
            }
        });

        for (const [remoteId, conv] of Object.entries(conversations)) {
            console.log(`📝 [Inbox] Generando resumen premium para: ${remoteId}`);

            try {
                const summaryResponse = await groq.chat.completions.create({
                    model: 'llama-3.1-70b-versatile', // Upgrade for better nuance
                    messages: [
                        {
                            role: 'system',
                            content: `Eres un sintetizador de inteligencia de alto nivel. 
Tu tarea es capturar la ESENCIA de una conversación en un "Blink Summary" de máximo 12 palabras.
Debe sonar sofisticado, minimalista y boutique. No uses frases genéricas como "El usuario pregunta sobre...". 
Ve directo al grano con elegancia.`
                        },
                        { role: 'user', content: `CONVERSACIÓN:\n${conv.messages.join('\n')}` }
                    ]
                });

                const summary = summaryResponse.choices[0].message.content.trim().replace(/^"|"$/g, '');
                const isGroup = remoteId.includes('@g.us');

                // Upsert en inbox_summaries
                await supabase.from('inbox_summaries').upsert({
                    client_id: clientId,
                    conversation_id: remoteId,
                    summary: summary,
                    last_message_text: conv.lastText,
                    contact_name: isGroup ? null : (conv.lastSender.startsWith('[Grupo]') ? null : conv.lastSender),
                    group_name: isGroup ? conv.lastSender.replace('[Grupo] ', '') : null,
                    avatar_url: conv.avatarUrl, // Nueva columna
                    is_unread: true,
                    last_updated: new Date().toISOString()
                }, { onConflict: 'client_id, conversation_id' });
            } catch (e) {
                console.warn(`⚠️ [Inbox] No se pudo generar el resumen para ${remoteId}:`, e.message);
            }
        }

        // --- PARTE B: GRAPHRAG (TRIplets) ---
        const rawContent = messages.map(m => `${m.sender_role}: ${m.content}`).join('\n');
        console.log(`🔍 [GraphRAG] Extrayendo hechos lógicos...`);

        // 2. Extracción de Triplets Avanzada (GraphRAG + Emotional Context + Style Learning)
        let triplets = [];
        try {
            const response = await groq.chat.completions.create({
                model: 'llama-3.1-70b-versatile',
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content: `Eres un analista de inteligencia y experto en perfiles psicológicos. 
Tu misión es extraer el 100% del valor de una conversación para construir un "Gráfico del Alma" del usuario.
Analiza tanto lo que recibe como lo que ENVÍA (sender_role: 'user_sent').

OBJETIVOS DE EXTRACCIÓN:
1. Hechos: (Triplets estándar Sujeto->Relación->Objeto).
2. Perfil de Estilo: ¿Cómo habla el usuario con esta persona? (Ej. 'El usuario es bromista con X', 'El usuario es formal con Y').
3. Jerga y Muletillas: Detecta palabras o expresiones que el usuario usa con frecuencia.
4. Preferencias y Emociones: Lo que le gusta, le disgusta o siente.

Formato JSON:
{
  "triplets": [
    {
      "source": "Sujeto",
      "source_type": "PERSONA|ESTILO_COMUNICACION|PREFERENCIA|EMOCION",
      "target": "Objeto",
      "target_type": "ENTITY|STYLE|CONCEPT",
      "relation": "GUSTA_DE|HABLA_CON_ESTILO|USA_JERGA|SIENTE_QUE",
      "context": "Detalle profundo del hallazgo"
    }
  ]
}`
                    },
                    { role: 'user', content: `CONVERSACIÓN:\n${rawContent}` }
                ]
            });

            const graphData = JSON.parse(response.choices[0].message.content);
            triplets = graphData.triplets || [];
            console.log(`🕸️ [GraphRAG] Extraídos ${triplets.length} triplets.`);
        } catch (e) {
            console.warn(`⚠️ [GraphRAG] Saltando módulo RAG por error de API o LLM:`, e.message);
        }

        // 3. Inserción de Triplets
        for (const t of triplets) {
            await upsertKnowledgeNode(clientId, t.source, t.source_type, "Entidad extraída.");
            await upsertKnowledgeNode(clientId, t.target, t.target_type, t.context || "Entidad extraída.");
            await supabase.from('knowledge_edges').insert({
                client_id: clientId,
                source_node: t.source,
                relation_type: t.relation,
                target_node: t.target,
                context: t.context
            }).catch(() => { });
        }

        // --- PARTE C: CHUNKING ADAPTATIVO + METADATA ENRIQUECIDA ---
        // Detect topic boundaries via cosine similarity between consecutive messages
        const SIMILARITY_THRESHOLD = 0.65; // Below this = new topic
        const MAX_CHUNK_SIZE = 8;           // Hard cap on chunk size

        const convGroups = {};
        messages.forEach(m => {
            if (!convGroups[m.remote_id]) convGroups[m.remote_id] = [];
            convGroups[m.remote_id].push(m);
        });

        let totalChunks = 0;
        let skipped = 0;

        for (const [remoteId, convMsgs] of Object.entries(convGroups)) {
            convMsgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

            const isGroup = remoteId.includes('@g.us');

            // Embed all messages in parallel for topic detection
            const msgEmbeddings = await Promise.all(
                convMsgs.map(m => generateEmbedding(`${m.sender_role}: ${m.content}`))
            );

            // Build adaptive chunks by detecting topic boundaries
            const chunks = [];
            let currentChunk = [0]; // indices into convMsgs

            for (let i = 1; i < convMsgs.length; i++) {
                const sim = cosineSimilarity(msgEmbeddings[i - 1], msgEmbeddings[i]);

                if (sim < SIMILARITY_THRESHOLD || currentChunk.length >= MAX_CHUNK_SIZE) {
                    // Topic boundary detected or max size reached → finalize chunk
                    chunks.push(currentChunk.map(idx => convMsgs[idx]));
                    currentChunk = [i];
                } else {
                    currentChunk.push(i);
                }
            }
            // Finalize last chunk
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.map(idx => convMsgs[idx]));
            }

            console.log(`🔬 [Adaptive] ${remoteId.slice(0, 12)}...: ${convMsgs.length} msgs → ${chunks.length} chunks`);

            // Replace the old windows variable with chunks
            const windows = chunks;

            // Batch process: build all chunk data first, then embed + insert in parallel
            const BATCH_SIZE = 5;
            const pendingChunks = [];

            for (const windowMsgs of windows) {
                const chunkText = windowMsgs.map(m => `${m.sender_role}: ${m.content}`).join('\n');
                const contentHash = crypto.createHash('sha256')
                    .update(`${clientId}:chunk:${chunkText}`)
                    .digest('hex');

                const { data: existing } = await supabase
                    .from('user_memories')
                    .select('id')
                    .eq('client_id', clientId)
                    .eq('content_hash', contentHash)
                    .limit(1);

                if (existing?.length > 0) {
                    skipped++;
                    continue;
                }

                const participants = [...new Set(windowMsgs.map(m => m.sender_role))];
                pendingChunks.push({
                    chunkText,
                    contentHash,
                    participants,
                    dateStart: windowMsgs[0].created_at,
                    dateEnd: windowMsgs[windowMsgs.length - 1].created_at,
                    chunkSize: windowMsgs.length,
                    remoteId,
                    isGroup,
                });
            }

            // Embed + insert in parallel batches
            for (let b = 0; b < pendingChunks.length; b += BATCH_SIZE) {
                const batch = pendingChunks.slice(b, b + BATCH_SIZE);
                await Promise.all(batch.map(async (chunk) => {
                    const embedding = await generateEmbedding(chunk.chunkText);
                    await supabase.from('user_memories').insert({
                        client_id: clientId,
                        content: chunk.chunkText,
                        sender: chunk.participants.join(', '),
                        embedding: embedding,
                        content_hash: chunk.contentHash,
                        metadata: {
                            remoteId: chunk.remoteId,
                            isGroup: chunk.isGroup,
                            dateStart: chunk.dateStart,
                            dateEnd: chunk.dateEnd,
                            participants: chunk.participants,
                            chunkSize: chunk.chunkSize,
                        }
                    });
                    totalChunks++;
                }));
            }
        }

        console.log(`📡 [Chunking] ${totalChunks} chunks creados de ${messages.length} mensajes (${skipped} dedup skips).`);

        // 4. AMNESIA: Borrar mensajes procesados
        await supabase.from('raw_messages').delete().in('id', messages.map(m => m.id));

        // 5. AUTO-SOUL: Destilar conocimiento fijos y relaciones
        await autonomousDistillation(clientId, clientSlug, messages);

        console.log(`✅ [Memory Worker] Procesamiento completo para ${clientSlug}.`);
    } catch (err) {
        console.error(`❌ Error general procesando cliente ${clientId}:`, err.message);
    }
}



// === MAIN: REDIS EVENT LISTENER ===
async function main() {
    console.log('🚀 Worker de Memoria en Tiempo Real ONLINE');

    // 1. Suscribirse a eventos de expiración de llaves Redis
    const redisListener = createRedisClient();
    await redisListener.connect();

    // Redis requires a dedicated connection for subscriptions
    const redisSub = redisListener.duplicate();
    await redisSub.connect();

    await redisSub.subscribe('__keyevent@0__:expired', async (key) => {
        if (key.startsWith('idle:')) {
            const clientId = key.split('idle:')[1];
            console.log(`⚡ [RAG-Event] Inactividad detectada para: ${clientId}. Procesando ahora...`);
            await distillAndVectorize(clientId);
        }
    });

    console.log('👂 Escuchando eventos de expiración de Redis...');

    // 2. Ya no hay Docker. Scale-To-Zero se maneja internamente.

    // 3. Fallback: cada 30 min, procesar clientes que puedan haberse escapado
    setInterval(async () => {
        console.log('🔄 [Fallback] Barrido de seguridad...');
        const { data: clients } = await supabase
            .from('raw_messages')
            .select('client_id')
            .is('processed', false);

        const uniqueClients = [...new Set(clients?.map(c => c.client_id))];
        for (const clientId of uniqueClients) {
            await distillAndVectorize(clientId);
        }
    }, 30 * 60 * 1000);

    // ══════════════════════════════════════════════════════════
    // 4. MEMORY CONSOLIDATION — Every 6 hours, merge old chunks
    // ══════════════════════════════════════════════════════════
    async function consolidateMemories() {
        console.log('🧹 [Consolidation] Iniciando consolidación de memorias antiguas...');
        try {
            const DAYS_THRESHOLD = 30;
            const cutoffDate = new Date(Date.now() - DAYS_THRESHOLD * 24 * 60 * 60 * 1000).toISOString();

            // Get all clients with old memories
            const { data: oldMemories, error } = await supabase
                .from('user_memories')
                .select('id, client_id, content, metadata, created_at')
                .lt('created_at', cutoffDate)
                .is('metadata->>consolidated', null) // Not already consolidated
                .order('created_at', { ascending: true })
                .limit(500);

            if (error || !oldMemories?.length) {
                console.log(`🧹 [Consolidation] ${error ? 'Error: ' + error.message : 'No hay memorias antiguas para consolidar.'}`);
                return;
            }

            // Group by client_id + remoteId
            const groups = {};
            for (const mem of oldMemories) {
                const remoteId = mem.metadata?.remoteId || 'unknown';
                const key = `${mem.client_id}::${remoteId}`;
                if (!groups[key]) groups[key] = { clientId: mem.client_id, remoteId, memories: [] };
                groups[key].memories.push(mem);
            }

            let consolidated = 0;
            let deleted = 0;

            for (const [key, group] of Object.entries(groups)) {
                if (group.memories.length < 3) continue; // Not worth consolidating

                // Build a text block for summarization
                const fullText = group.memories
                    .map(m => m.content)
                    .join('\n---\n')
                    .slice(0, 6000); // Cap to avoid token limits

                try {
                    const summaryResponse = await groq.chat.completions.create({
                        model: 'llama-3.1-8b-instant',
                        messages: [{
                            role: 'system',
                            content: `Eres un sistema de consolidación de memoria. Dado un conjunto de fragmentos de conversación, genera un resumen conciso que capture:
1. Los temas principales discutidos
2. Hechos clave mencionados (nombres, fechas, planes)
3. El tono y estilo de la conversación
4. Cualquier decisión o acuerdo tomado

Formato: Resumen narrativo en 2-3 párrafos. Mantén el idioma original. NO añadas comentarios propios.`
                        }, {
                            role: 'user',
                            content: `Consolida estos ${group.memories.length} fragmentos de conversación con ${group.remoteId}:\n\n${fullText}`
                        }],
                        temperature: 0.2,
                        max_tokens: 500,
                    });

                    const summary = summaryResponse.choices[0].message.content;

                    // Generate embedding for the summary
                    const embedding = await generateEmbedding(summary);

                    // Insert consolidated memory
                    const dateStart = group.memories[0].created_at;
                    const dateEnd = group.memories[group.memories.length - 1].created_at;

                    await supabase.from('user_memories').insert({
                        client_id: group.clientId,
                        content: `[RESUMEN CONSOLIDADO — ${group.memories.length} fragmentos]\n${summary}`,
                        sender: 'system_consolidation',
                        embedding: embedding,
                        content_hash: crypto.createHash('sha256').update(`consolidated:${key}:${dateStart}:${dateEnd}`).digest('hex'),
                        metadata: {
                            remoteId: group.remoteId,
                            isGroup: group.remoteId.includes('@g.us'),
                            dateStart,
                            dateEnd,
                            consolidated: true,
                            originalCount: group.memories.length,
                            chunkSize: group.memories.length,
                        }
                    });

                    // Delete original old memories
                    const idsToDelete = group.memories.map(m => m.id);
                    await supabase.from('user_memories').delete().in('id', idsToDelete);

                    consolidated++;
                    deleted += idsToDelete.length;
                    console.log(`🧹 [Consolidation] ${group.remoteId.slice(0, 12)}...: ${idsToDelete.length} chunks → 1 resumen`);
                } catch (e) {
                    console.warn(`[Consolidation] Error procesando ${key}:`, e.message);
                }
            }

            console.log(`✅ [Consolidation] ${consolidated} grupos consolidados, ${deleted} chunks eliminados.`);
        } catch (err) {
            console.error('[Consolidation] Error general:', err.message);
        }
    }

    // Run consolidation every 6 hours
    setInterval(consolidateMemories, 6 * 60 * 60 * 1000);
    // Run once at startup after 2 minutes
    setTimeout(consolidateMemories, 2 * 60 * 1000);
}

main().catch(err => {
    console.error('💀 [Worker] Error fatal:', err.message);
    process.exit(1);
});
