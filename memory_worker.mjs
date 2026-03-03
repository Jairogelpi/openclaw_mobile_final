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
import redisClient from './config/redis.mjs';
import { upsertKnowledgeNode, upsertKnowledgeEdge } from './services/graph.service.mjs';
import cron from 'node-cron';

const parseLLMJson = (text) => {
    try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        console.warn('⚠️ [LLM-JSON] Fallback parsing failed for:', text.slice(0, 100));
        throw e;
    }
};

const sanitizeInput = (text, maxLength = 2000) => {
    if (typeof text !== 'string') return '';
    return text
        .replace(/[<>{}\[\]\\^\`]/g, '')
        .substring(0, maxLength)
        .trim();
};

/**
 * Resetea el temporizador de inactividad para un cliente.
 */
async function triggerMemoryTimer(clientId) {
    if (!redisClient) return;
    try {
        await redisClient.set(`idle:${clientId}`, 'process', { EX: 60 });
        console.log(`[Timer] ⏳ Reloj reseteado para ${clientId}. Procesando en 60s de inactividad.`);
    } catch (e) {
        console.warn('[Timer] Error reseteando temporizador:', e.message);
    }
}

// No local initializations needed anymore as they are in config/services

// No longer needed: local upsertKnowledgeNode and upsertKnowledgeEdge removed to use services/graph.service.mjs

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

        // 2. Extraer hechos, tripletes y PERFIL DE ESTILO
        const textBlock = messages.map(m => `${m.sender_role}: ${m.content}`).join('\n');

        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{
                role: 'system',
                content: `Eres el Arquitecto Cognitivo OMNISCIENTE de un clúster de Inteligencia Artificial Avanzada. 
Misión: Extraer absolutamente TODOS los matices posibles de esta conversación para construir un "Cerebro Gemelo Digital" (Clone) hiper-realista del usuario.

SOUL ACTUAL (Contexto Base Acumulado):
${JSON.stringify(currentSoul)}

TRAZA DE CONVERSACIÓN (Mensajes recientes):
${textBlock}

PROTOCOLOS DE EXTRACCIÓN (NIVEL GOD-TIER):

1. "soul_patch": Actualiza o añade hechos duros, pero escanea estratos profundos:
   - Creencias fundamentales y Axiomas Filosóficos del usuario.
   - Matrices de decisión (¿Cómo procesa los problemas? ¿Se guía por lógica rígida o emoción irracional?).
   - Aversiones (pet peeves) y pasiones ocultas.
   - Puntos ciegos cognitivos o sesgos detectados observados en el texto.

2. "triplets": Arquitectura GraphRAG de Nivel 3. 
   - No extraigas solo hechos simples ("X es lugar"). 
   - Extrae matices viscerales: "Fulano [TIENE_TENSION_CON] Mengano". "Concepto_X [CAUSA_ESTRES_A] Usuario".

3. "style_profile": DECONSTRUCCIÓN LINGÜÍSTICO-PSICOLÓGICA. Analiza 'user_sent' con precisión milimétrica:
   - "core_humor_framework": Identifica sarcasmo, ironía, absurdo, humor negro, humor inocente, shitposting.
   - "syntactic_complexity": Valor (0.0 a 1.0) y descripción estructural.
   - "emotional_baseline_valence": Valencia emocional (-1.0 a 1.0) y Tono Dominante constante.
   - "formality_variance": Rango de formalidad y gatillos (qué temas le hacen hablar formal vs grosero).
   - "common_emojis": Uso táctico, irónico o literal de emojis (y cuáles son).
   - "slang_and_vocabulary": El lexicon único, barbarismos, localismos, jergas de nicho de internet o vida real.
   - "rhythm_and_pacing": Ráfagas, bloques monolíticos explicativos, tiempos de pausa.
   - "punctuation_signature": Manias puras (ausencia total de mayúsculas, elipsis dramáticas, exclamaciones hiperbólicas).
   - "conflict_resolution_style": Si hay discusiones, ¿es evasivo, confrontacional, diplomático, pasivo-agresivo?

Responde ÚNICA Y EXCLUSIVAMENTE con el siguiente objeto JSON estricto (combina el perfil completo actualizado con el nuevo conocimiento):
{
  "soul_patch": {
    "axiomas_filosoficos": ["..."],
    "matrices_decision": ["..."],
    "sesgos_cognitivos": ["..."],
    "hechos_y_preferencias_duras": ["..."]
  },
  "triplets": [
    ["Sujeto", "PREDICADO_RELACIONAL_COMPLEJO", "Objeto"]
  ],
  "style_profile": {
    "core_humor_framework": "",
    "conflict_resolution_style": "",
    "syntactic_complexity_score": 0.0,
    "emotional_baseline_valence": 0.0,
    "formality_variance": "",
    "common_emojis": [],
    "slang_and_vocabulary": [],
    "rhythm_and_pacing": "",
    "punctuation_signature": ""
  }
}`
            }],
            response_format: { type: 'json_object' },
            temperature: 0.1
        });

        const result = parseLLMJson(response.choices[0].message.content);

        // 3. Aplicar Parche al SOUL e Identidad
        if ((result.soul_patch && Object.keys(result.soul_patch).length > 0) || result.style_profile) {
            const updatedSoul = {
                ...currentSoul,
                ...result.soul_patch,
                style_profile: {
                    ...(currentSoul.style_profile || {}),
                    ...(result.style_profile || {})
                }
            };

            // A. Guardar en DB (Single Source of Truth)
            const { error: updateError } = await supabase
                .from('user_souls')
                .update({
                    soul_json: updatedSoul,
                    updated_at: new Date().toISOString()
                })
                .eq('client_id', clientId);

            if (updateError) throw new Error(`DB Update Failed: ${updateError.message}`);

            // B. Exportar a SOUL.md (Caché local / Auditoría)
            try {
                const clientDir = path.join('./clients', clientSlug);
                await fs.mkdir(clientDir, { recursive: true });
                const soulPath = path.join(clientDir, 'SOUL.md');
                const soulText = JSON.stringify(updatedSoul, null, 2);
                await fs.writeFile(soulPath, encrypt(soulText));
                console.log(`✨ [Auto-Soul] Exportado exitosamente a ${soulPath}`);
            } catch (fileErr) {
                console.warn(`⚠️ [Auto-Soul] Error exportando a archivo (DB está OK):`, fileErr.message);
            }

            console.log(`✨ [Auto-Soul] Memoria e Identidad (Estilo) actualizadas en DB para ${clientSlug}.`);
        }

        // 4. Upsert en el Grafo
        if (result.triplets && result.triplets.length > 0) {
            for (const [s, p, o] of result.triplets) {
                await upsertKnowledgeNode(clientId, s, 'ENTITY', '');
                await upsertKnowledgeNode(clientId, o, 'ENTITY', '');
                await upsertKnowledgeEdge(clientId, s, o, p);
            }
            console.log(`🕸️ [Auto-Soul] ${result.triplets.length} tripletes añadidos.`);
        }

    } catch (e) {
        console.error('❌ [Auto-Soul] Error en destilación:', e.message);
    }
}

// === DISTILL + GRAPHRAG VECTORIZE + INBOX SUMMARIES ===
async function distillAndVectorize(clientId) {
    // Obtener slug del cliente para rutas de archivos
    const { data: client } = await supabase.from('user_souls').select('slug').eq('client_id', clientId).single();
    if (!client) return;
    const clientSlug = client.slug;

    console.log(`\n🧠 [Memory Worker] Procesando memoria e inbox para: ${clientSlug}`);

    // 0. ADQUIRIR CANDADO ATÓMICO (Evita condiciones de carrera e hiperescalado de costes)
    // 0. BLOQUEO ATÓMICO (Phase 11: Idempotency)
    // Usamos RPC de Supabase para evitar que varios workers procesen al mismo cliente simultáneamente
    const { data: lockAcquired, error: lockErr } = await supabase.rpc('acquire_worker_lock', {
        p_client_id: clientId,
        p_expiry_minutes: 30
    });

    if (lockErr || !lockAcquired) {
        console.log(`[Worker] 🔒 Cliente ${clientId} bloqueado por otro proceso. Saltando.`);
        return;
    }

    try {
        console.log(`🧠 [Process] Despertando proceso para ${clientSlug}...`);

        // 1. Obtener mensajes sin procesar
        const { data: messages } = await supabase
            .from('raw_messages')
            .select('*')
            .eq('client_id', clientId)
            .eq('processed', false)
            .order('created_at', { ascending: true });

        if (!messages?.length) {
            console.log(`🏝️ Sin mensajes pendientes para ${clientId}.`);
            return;
        }

        // SANTIZACIÓN (Phase 11)
        messages.forEach(m => m.content = sanitizeInput(m.content));

        // --- PARTE A: RESÚMENES PARA EL INBOX ---
        // Agrupamos por conversación (remote_id)
        const conversations = {};
        messages.forEach(m => {
            if (!conversations[m.remote_id]) {
                const fallbackName = m.remote_id ? m.remote_id.split('@')[0] : 'Desconocido';
                const initialSender = (m.sender_role === 'Historial' || m.sender_role === 'user_sent')
                    ? (m.metadata?.pushName || fallbackName)
                    : m.sender_role;

                conversations[m.remote_id] = {
                    messages: [],
                    lastSender: initialSender,
                    lastText: m.content,
                    avatarUrl: m.metadata?.avatarUrl || null,
                    firstMessageTime: m.created_at,
                    lastMessageTime: m.created_at
                };
            }
            conversations[m.remote_id].messages.push(`${m.sender_role}: ${m.content}`);

            // Actualizar nombre realista si está disponible
            if (m.sender_role !== 'Historial' && m.sender_role !== 'user_sent') {
                conversations[m.remote_id].lastSender = m.sender_role;
            } else if (m.metadata?.pushName) {
                conversations[m.remote_id].lastSender = m.metadata.pushName;
            }

            conversations[m.remote_id].lastText = m.content;
            if (m.metadata?.avatarUrl) {
                conversations[m.remote_id].avatarUrl = m.metadata.avatarUrl; // Actualizar con el más reciente
            }
            conversations[m.remote_id].lastMessageTime = m.created_at;
        });

        for (const [remoteId, conv] of Object.entries(conversations)) {
            console.log(`📝 [Inbox] Generando resumen premium para: ${remoteId}`);

            try {
                const summaryResponse = await groq.chat.completions.create({
                    model: 'llama-3.1-8b-instant', // OPTIMIZACIÓN DE COSTES: 8B para resúmenes
                    messages: [
                        {
                            role: 'system',
                            content: `Eres un sintetizador ultra-preciso de OpenClaw. Analizas una conversación de WhatsApp y extraes un TITULAR descriptivo de MÁXIMO 10 PALABRAS.
REGLAS ESTRICTAS:
1. NUNCA uses frases como "El usuario...", "La conversación trata...", "El resumen es...".
2. ACTÚA COMO UN ASISTENTE EJECUTIVO que anota un recordatorio en una agenda.
3. EJEMPLOS BUENOS: "Confirmación de cita médica para el martes", "Coordinando pago de factura pendiente", "Intercambio de bromas informales".
4. DEVUELVE SOLO EL TEXTO DEL RESUMEN, SIN COMILLAS NI PREÁMBULOS.`
                        },
                        { role: 'user', content: `CONVERSACIÓN:\n${conv.messages.join('\n')}` }
                    ]
                });

                const summary = summaryResponse.choices[0].message.content.trim().replace(/^"|"$/g, '');
                const isGroup = remoteId.includes('@g.us');

                // Upsert en inbox_summaries
                const { error: upsertError } = await supabase.from('inbox_summaries').upsert({
                    client_id: clientId,
                    conversation_id: remoteId,
                    summary: summary,
                    last_message_text: conv.lastText,
                    contact_name: isGroup ? null : (conv.lastSender.startsWith('[Grupo]') ? null : conv.lastSender),
                    group_name: isGroup ? conv.lastSender.replace('[Grupo] ', '') : null,
                    avatar_url: conv.avatarUrl,
                    first_message_time: conv.firstMessageTime,
                    last_message_time: conv.lastMessageTime,
                    is_unread: true,
                    last_updated: new Date().toISOString()
                }, { onConflict: 'client_id, conversation_id' });

                if (upsertError) {
                    console.error(`❌ [Inbox] Error haciendo upsert para ${remoteId}:`, upsertError.message);
                } else {
                    console.log(`✅ [Inbox] Resumen guardado exitosamente para ${remoteId}`);
                }

                // --- PARTE A.2: EXTRACCIÓN DE PERFIL DE RELACIÓN (PERSONA) ---
                console.log(`🎭 [Persona] Extrayendo perfil de relación para: ${remoteId}`);
                try {
                    const personaResponse = await groq.chat.completions.create({
                        model: 'llama-3.1-8b-instant', // OPTIMIZACIÓN DE COSTES: 8B para personas
                        messages: [
                            {
                                role: 'system',
                                content: `Eres un motor algorítmico de perfilado psico-lingüístico.
Procesa esta traza de comunicación y extrae una radiografía analítica (JSON) de la relación.

REGLAS DE ORO:
1. SOLO JSON VÁLIDO. Cero texto auxiliar, cero excusas.
2. Basado 100% en evidencia matemática de la conversación (longitud de strings, varianza de tiempos, lexicon).

ESTRUCTURA OBLIGATORIA DEL JSON:
{
  "affinity_score": <1-100, float>,
  "formality_index": <1-100, float>,
  "lexical_diversity": "alta|media|baja",
  "average_latency_sec": <float o null>,
  "power_dynamic": "simetrica|usuario_dominante|contacto_dominante",
  "emotional_valence": <float entre -1.0 y 1.0>,
  "recurrent_patterns": ["patron1", "patron2"],
  "relationship_classification": "string_exacto",
  "technical_summary": "Análisis conciso de 15 palabras max."
}`
                            },
                            { role: 'user', content: `CONVERSACIÓN:\n${conv.messages.join('\n')}` }
                        ],
                        response_format: { type: 'json_object' }
                    });

                    const personaJson = parseLLMJson(personaResponse.choices[0].message.content);

                    const { error: personaError } = await supabase.from('contact_personas').upsert({
                        client_id: clientId,
                        remote_id: remoteId,
                        persona_json: personaJson,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'client_id, remote_id' });

                    if (personaError) {
                        console.error(`❌ [Persona] Error guardando perfil para ${remoteId}:`, personaError.message);
                    } else {
                        console.log(`✅ [Persona] Perfil guardado para ${remoteId} (${personaJson.relacion_detectada})`);
                    }
                } catch (e) {
                    console.warn(`⚠️ [Persona] Error extrayendo perfil para ${remoteId}:`, e.message);
                }

                // --- PARTE A.3: GRAPHRAG (Memoria Episódica Verdadera) ---
                console.log(`🔍 [GraphRAG] Extrayendo hechos lógicos para: ${remoteId}`);
                let triplets = [];
                try {
                    const contactIdentifier = isGroup ? `Grupo (${conv.lastSender.replace('[Grupo] ', '')})` : (conv.lastSender || remoteId);
                    const graphResponse = await groq.chat.completions.create({
                        model: 'llama-3.3-70b-versatile',
                        response_format: { type: 'json_object' },
                        messages: [
                            {
                                role: 'system',
                                content: `Eres un analista de inteligencia construyendo un Grafo de Conocimiento (GraphRAG).
Tu misión es extraer hechos fijos y permanentes de esta conversación.

REGLAS CRÍTICAS DE ENTIDADES:
- Si el hecho es sobre el dueño de la cuenta, el Sujeto debe ser SIEMPRE: "Usuario".
- Si el hecho es sobre la persona con la que habla, el Sujeto debe ser ESTRICTAMENTE: "${contactIdentifier}".
- No uses nombres genéricos como "Contacto", "El amigo", usa exactamente "${contactIdentifier}".

OBJETIVOS DE EXTRACCIÓN:
- Relaciones familiares (ej: hermano de, hijo de)
- Posesiones importantes (ej: tiene mascota, tiene coche)
- Eventos fijos (ej: se casó en 2020)
- Nombres propios (ej: su perro se llama Toby)

Formato JSON esperado:
{
  "triplets": [
    {
      "source": "Sujeto (Usuario o ${contactIdentifier})",
      "source_type": "PERSONA",
      "target": "Objeto (ej. Toby, Madrid, Fútbol)",
      "target_type": "ENTITY|CONCEPT|LOCATION",
      "relation": "TIENE_MASCOTA|RESIDE_EN|GUSTA_DE|PADRE_DE",
      "context": "Detalle breve del hecho"
    }
  ]
}`
                            },
                            { role: 'user', content: `CONVERSACIÓN:\n${conv.messages.join('\n')}` }
                        ]
                    });

                    const graphData = parseLLMJson(graphResponse.choices[0].message.content);
                    triplets = graphData.triplets || [];
                    console.log(`🕸️ [GraphRAG] Extraídos ${triplets.length} triplets para ${remoteId}.`);

                    // 3. Inserción Automática del Grafo para este contacto
                    for (const t of triplets) {
                        await upsertKnowledgeNode(clientId, t.source, t.source_type, "Entidad extraída.");
                        await upsertKnowledgeNode(clientId, t.target, t.target_type, t.context || "Entidad extraída.");
                        await supabase.from('knowledge_edges').insert({
                            client_id: clientId,
                            source_node: t.source,
                            relation_type: t.relation,
                            target_node: t.target,
                            context: t.context
                        });
                    }

                } catch (e) {
                    console.warn(`⚠️ [GraphRAG] Error o salto para ${remoteId}:`, e.message);
                }

            } catch (e) {
                console.warn(`⚠️ [Inbox] No se pudo generar el resumen para ${remoteId}:`, e.message);
            }
        }

        // --- PARTE B (LEGACY GLOBAL GRAPHRAG REMOVED) ---


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
                const timeDiffMs = new Date(convMsgs[i].created_at) - new Date(convMsgs[currentChunk[0]].created_at);
                const MAX_TIME_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

                if (sim < SIMILARITY_THRESHOLD || currentChunk.length >= MAX_CHUNK_SIZE || timeDiffMs > MAX_TIME_WINDOW_MS) {
                    // Topic boundary detected, max size reached, or time window exceeded → finalize chunk
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

                // GUARDRAIL: Evitar fragmentación de mensajes cortos sin valor (ej: "Ok", "Vale")
                const wordCount = chunkText.split(/\s+/).length;
                if (wordCount < 10 && windowMsgs.length < 2) {
                    skipped++;
                    continue;
                }

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

        // 4. AMNESIA: Marcar como procesado (Retención de 7 días activa)
        await supabase.from('raw_messages')
            .update({ processed: true })
            .in('id', messages.map(m => m.id));

        // 3. Destilación de Conocimiento e Identidad (Auto-Soul)
        await autonomousDistillation(clientId, clientSlug, messages);

        console.log(`✅ [Memory Worker] Procesamiento completo para ${clientSlug}.`);
    } catch (err) {
        console.error(`❌ [Process] Error para ${clientId}:`, err.message);
    } finally {
        // LIBERAR BLOQUEO
        const { error: releaseErr } = await supabase.rpc('release_worker_lock', { target_client_id: clientId });
        if (releaseErr) {
            console.error(`[Worker] Error releasing lock for ${clientId}:`, releaseErr.message);
        }
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

    // Run once at startup after 30 seconds
    setTimeout(consolidateMemories, 30 * 1000);
    setTimeout(cleanupRawMessages, 60 * 1000);

    // ══════════════════════════════════════════════════════════
    // 6. FORMAL SCHEDULING (node-cron)
    // ══════════════════════════════════════════════════════════

    // Fallback: cada 30 min, procesar clientes que puedan haberse escapado
    cron.schedule('*/30 * * * *', async () => {
        console.log('🔄 [Cron: Fallback] Barrido de seguridad...');
        const { data: clients } = await supabase
            .from('raw_messages')
            .select('client_id')
            .eq('processed', false); // Added .eq('processed', false) for correctness

        const uniqueClients = [...new Set(clients?.map(c => c.client_id))];
        for (const clientId of uniqueClients) {
            await distillAndVectorize(clientId);
        }
    });

    // Memory Consolidation: Cada 3 horas
    cron.schedule('0 */3 * * *', async () => {
        await consolidateMemories();
    });

    // Raw Messages Cleanup: Cada 6 horas
    cron.schedule('0 */6 * * *', async () => {
        await cleanupRawMessages();
    });

    // 4. LIMPIEZA DE UPLOADS (Diario a las 04:00 AM)
    cron.schedule('0 4 * * *', async () => {
        console.log('🧹 [Cleanup] Iniciando limpieza de archivos temporales en uploads/...');
        try {
            const uploadsDir = './uploads';
            const files = await fs.readdir(uploadsDir);
            const now = Date.now();
            const MAX_AGE = 24 * 60 * 60 * 1000; // 24 horas

            for (const file of files) {
                if (file === '.placeholder') continue;
                const filePath = path.join(uploadsDir, file);
                const stats = await fs.stat(filePath);
                if (now - stats.mtimeMs > MAX_AGE) {
                    await fs.unlink(filePath);
                    console.log(`- Eliminado: ${file}`);
                }
            }
            console.log('✅ [Cleanup] Limpieza completada.');
        } catch (err) {
            console.error('❌ [Cleanup] Error en limpieza:', err.message);
        }
    });

    // 5. HEALTH CHECK (Cada 1 hora)
    cron.schedule('0 * * * *', () => {
        const mem = process.memoryUsage();
        console.log(`💓 [Health] Worker vivo. Memoria: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.rss / 1024 / 1024)}MB RSS`);
    });

    console.log('📅 [Scheduler] Tareas programadas: Fallback (30m), Consolidación (3h), Purga (6h), Limpieza (4am), Health (1h).');
}

// ══════════════════════════════════════════════════════════
// 4. MEMORY CONSOLIDATION — Every 6 hours, merge old chunks
// ══════════════════════════════════════════════════════════
async function consolidateMemories() {
    console.log('🧹 [Consolidation] Iniciando consolidación de memorias antiguas...');
    try {
        const DAYS_THRESHOLD = 14; // ← Antes: 30 días. Ahora más agresivo.
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

// ═══════════════════════════════════════════════════════════
// 5. RAW MESSAGES CLEANUP — Purge processed msgs older than 7 days
// ═══════════════════════════════════════════════════════════
async function cleanupRawMessages() {
    console.log('🗑️ [Cleanup] Purgando raw_messages procesados (+7 días)...');
    try {
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { count, error } = await supabase
            .from('raw_messages')
            .delete({ count: 'exact' })
            .eq('processed', true)
            .lt('created_at', cutoff);

        if (error) {
            console.error('[Cleanup] Error:', error.message);
        } else {
            console.log(`✅ [Cleanup] ${count || 0} mensajes antiguos eliminados.`);
        }
    } catch (e) {
        console.error('[Cleanup] Error general:', e.message);
    }
}

main().catch(err => {
    console.error('💀 [Worker] Error fatal:', err.message);
    process.exit(1);
});

export { distillAndVectorize };
