import 'dotenv/config';
import { createClient as createRedisClient } from 'redis';
import supabase from './config/supabase.mjs';
import groq from './services/groq.mjs';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);
import { encrypt, decrypt } from './security.mjs';
import crypto from 'node:crypto';
import { generateEmbedding, cosineSimilarity, invalidateSemanticCache } from './services/local_ai.mjs';
import redisClient from './config/redis.mjs';
import { upsertKnowledgeNode, upsertKnowledgeEdge } from './services/graph.service.mjs';
import { detectAndSaveCommunities } from './services/community.service.mjs';
import { resolveIdentity } from "./skills/whatsapp_contacts.mjs";
import { discoverWhatsAppGroup } from './skills/whatsapp_groups.mjs';
import { processAttachment } from "./utils/media.mjs";
import {
    deriveOwnerNameFromSlug,
    dominantExternalSpeaker,
    fallbackNameFromRemoteId,
    isMemoryEligibleRawMessage,
    looksLikeWhatsAppRemoteId,
    normalizeComparableText,
    pickBestHumanName,
    renderConversationLine,
    resolveStoredSpeakerName
} from './utils/message_guard.mjs';
import {
    extractSpeakersFromLines,
    validateGroundedGraph
} from './utils/knowledge_guard.mjs';
import cron from 'node-cron';

const ENABLE_DREAM_CYCLE = String(process.env.OPENCLAW_ENABLE_DREAM_CYCLE || '').toLowerCase() === 'true';

// === HYPER-ROBUST HELPERS ===
function cleanJSON(text) {
    if (!text) return null;
    try {
        let cleaned = text.replace(/```json|```/g, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
            cleaned = cleaned.substring(start, end + 1);
        }
        // Basic healing for common trailing comma issues or missing braces
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            // Attempt secondary healing
            const healed = cleaned.replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(healed);
        }
    } catch (e) {
        console.warn('⚠️ [cleanJSON] Fallback failed:', e.message, 'TEXT:', text.substring(0, 100));
        return null;
    }
}

const parseLLMJson = (text) => {
    try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        return null;
    }
}

const sanitizeInput = (text, maxLength = 2000) => {
    if (typeof text !== 'string') return '';
    return text.replace(/[<>{}\\^\`]/g, '').substring(0, maxLength).trim();
};

/**
 * 2026 Grounded Extraction: Semántica Cuádruple + Temporal + Thematic (GraphRAG Level 4)
 */
async function processConversationDepth(clientId, remoteId, userName, contactName, messages, senderRole, chunkText, timestamp) {
    return processConversationDepthStrict(clientId, remoteId, userName, contactName, messages, {
        isGroup: String(remoteId || '').endsWith('@g.us'),
        speakers: extractSpeakersFromLines(messages || [])
    });
    try {
        const prompt = `### INSTRUCCIONES DE HIPER-EXTRACCIÓN CÍBORYG (GraphRAG Nivel 5) ###
CONTEXTO: Conversación entre "${userName}" (tú/usuario) y "${contactName}" (identidad remota).
OBJETIVO: Crear una red neuronal de máxima densidad donde TODO esté conectado.

REGLAS DE IDENTIDAD (PROHIBIDO GENÉRICOS):
1. **IDENTIDADES DE NODO**: Prohibido usar "Usuario", "Contacto", "Él", "Persona", "Interlocutor" o "Anónimo". 
   - SIEMPRE usa "${userName}" y "${contactName}".
   - Si se menciona a alguien sin nombre, usa su rol descriptivo (ej: "Primo de Víctor", "Vendedor de Amazon") o su ID (${remoteId}). Pero NUNCA "Contacto".
   - **PROHIBIDO** extraer formatos multimedia ("Audio", "Imagen", "Video", "Foto", "Voz", "Documento") como entidades. Ignora los prefijos del sistema y enfócate sólo en la INFORMACIÓN narrada.
2. **ENTIDADES TÁCITAS**: Extrae miedos, metas, rasgos (ej: "Resiliente", "Obsesivo").

REGLAS DE CONECTIVIDAD (DENSIDAD EXTREMA):
3. **RELACIONES OBLIGATORIAS**: CADA entidad extraída DEBE estar conectADA al menos con otra. No se permiten nodos huérfanos.
4. **MATRIZ DE CONEXIÓN**: Si en un mismo párrafo se mencionan tres cosas (A, B y C), intenta conectarlas todas entre sí (A->B, B->C, A->C) si existe una relación lógica o contextual.
5. **RELACIONES ESTANDARIZADAS**: [CREENCIA], [CONFLICTO], [EXPERIENCIA], [PROMESA], [SECRETO], [RUTINA], [GUSTO], [ODIO], [DEPENDENCIA], [INFLUENCIA], [AMISTAD], [FAMILIA], [TRABAJO], [AMOR], [RELACIONADO_CON].

=== EJEMPLO DE DENSIDAD MÁXIMA ===
User: "${userName}: El 12 de mayo Víctor me dijo que Rust es difícil. Me dio ansiedad."
EXTRAE ESTO:
{
  "entities": [
    {"name": "${userName}", "type": "PERSONA", "desc": "Sujeto principal.", "traits": ["Vulnerable a la ansiedad técnica"]},
    {"name": "Víctor", "type": "PERSONA", "desc": "Amigo técnico.", "traits": ["Opinológico"]},
    {"name": "12 de mayo", "type": "EVENTO_TEMPORAL", "desc": "Fecha del incidente.", "traits": []},
    {"name": "Rust", "type": "TEMA", "desc": "Lenguaje de programación.", "traits": []}
  ],
  "relationships": [
    {"source": "${userName}", "target": "Víctor", "type": "[AMISTAD]", "weight": 0.8, "sentiment": "NEUTRO", "context": "Conversación técnica."},
    {"source": "${userName}", "target": "Rust", "type": "[MIEDO]", "weight": 0.9, "sentiment": "ANSIOSO", "context": "Ansiedad por dificultad."},
    {"source": "Víctor", "target": "Rust", "type": "[CREENCIA]", "weight": 0.9, "sentiment": "NEGATIVO", "context": "Él dice que es difícil."},
    {"source": "12 de mayo", "target": "${userName}", "type": "[EXPERIENCIA]", "weight": 1.0, "sentiment": "ANSIOSO", "context": "Día del evento traumático."},
    {"source": "12 de mayo", "target": "Rust", "type": "[RELACIONADO_CON]", "weight": 0.7, "sentiment": "NEUTRO", "context": "Fecha vinculada al tema."},
    {"source": "Víctor", "target": "12 de mayo", "type": "[EXPERIENCIA]", "weight": 0.5, "sentiment": "NEUTRO", "context": "Participación en el evento."}
  ]
}
================================

Analiza y responde ÚNICAMENTE en JSON ESTRICTO.`;

        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'system', content: prompt }, { role: 'user', content: messages.join('\n') }],
            response_format: { type: 'json_object' },
            temperature: 0.0
        });

        const quads = parseLLMJson(response.choices[0].message.content);
        if (!quads) return;

        let explicit = 0;
        let implicit = 0;

        for (const ent of (quads.entities || [])) {
            const description = `${ent.desc || ''} ${ent.traits?.length ? `[Traits: ${ent.traits.join(', ')}]` : ''} `.trim();
            await upsertKnowledgeNode(clientId, ent.name, ent.type || 'ENTITY', description);
            explicit++;
        }
        for (const rel of (quads.relationships || [])) {
            const enrichedType = rel.sentiment ? `${rel.type} (${rel.sentiment})` : rel.type;
            const finalWeight = rel.weight ? Math.min(10, Math.max(1, Math.round(rel.weight * 10))) : 1; // Normalize to 1-10 scale for the DB if they return 0-1
            await upsertKnowledgeEdge(clientId, rel.source, rel.target, enrichedType, finalWeight, rel.context);
            implicit++;
        }

        console.log(`🕸️[Hyper-Graph Level 4] ${explicit} entidades + ${implicit} relaciones detectadas.`);
    } catch (e) {
        console.warn(`[GraphRAG] Error en Hyper-Extractor: ${e.message}`);
    }
}

function buildGroundedExtractionPrompt(userName, contactName, remoteId, { isGroup = false, speakers = [] } = {}) {
    const scope = isGroup
        ? `Chat grupal "${contactName}" con participantes visibles: ${speakers.join(', ') || userName}.`
        : `Chat privado entre "${userName}" y "${contactName}".`;

    return `Eres un extractor de hechos observables para un grafo de memoria personal.

CONTEXTO:
- ${scope}
- Titular del sistema: "${userName}".
- Identificador remoto: "${remoteId}".

OBJETIVO:
- Extraer SOLO hechos explicitamente observables en el texto.
- Si no hay evidencia literal suficiente, devuelve arrays vacios.

REGLAS DURAS:
1. Nunca inventes rasgos, miedos, metas, emociones, secretos ni relaciones implicitas.
2. Nunca conectes entidades solo por co-ocurrencia.
3. Nunca uses nodos genericos como "Usuario", "Contacto", "Persona", "Interlocutor" o "Anonimo".
4. Nunca extraigas formatos de media, placeholders ni mensajes del sistema como entidades.
5. En grupos, no atribuyas lo que dice un participante al grupo ni a otro participante.
6. Cada entidad y cada relacion DEBE llevar un campo "evidence" con un fragmento literal del texto.
7. Si una relacion no queda sostenida por una cita textual, no la devuelvas.
8. No crees nodos de fecha suelta salvo que el texto describa un evento con nombre propio.

TIPOS DE ENTIDAD PERMITIDOS:
- PERSONA, ORGANIZACION, LUGAR, PROYECTO, TEMA, EVENTO, GRUPO, OBJETO, ENTITY

TIPOS DE RELACION PERMITIDOS:
- [RELACIONADO_CON], [HABLA_DE], [CONOCE_A], [FAMILIA_DE], [PAREJA_DE], [AMISTAD],
  [TRABAJA_EN], [VIVE_EN], [ESTUDIA_EN], [USA], [POSEE], [PLANEA], [PREFIERE],
  [EVITA], [EVENTO_CON]

FORMATO JSON ESTRICTO:
{
  "entities": [
    { "name": "string", "type": "PERSONA|ORGANIZACION|LUGAR|PROYECTO|TEMA|EVENTO|GRUPO|OBJETO|ENTITY", "desc": "string corto", "evidence": "cita literal" }
  ],
  "relationships": [
    { "source": "string", "target": "string", "type": "[RELACIONADO_CON]", "weight": 1-10, "context": "string corto", "evidence": "cita literal" }
  ]
}`;
}

async function processConversationDepthStrict(clientId, remoteId, userName, contactName, lines, options = {}) {
    try {
        const chunkText = (lines || []).join('\n');
        if (!chunkText) return;

        const prompt = buildGroundedExtractionPrompt(userName, contactName, remoteId, options);
        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: chunkText }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.0
        });

        const extractedGraph = parseLLMJson(response.choices[0].message.content);
        if (!extractedGraph) return;

        const groundedGraph = validateGroundedGraph({
            entities: extractedGraph.entities,
            relationships: extractedGraph.relationships,
            chunkText,
            ownerName: userName,
            contactName,
            remoteId,
            isGroup: options.isGroup,
            speakers: options.speakers
        });

        let entityCount = 0;
        let relationshipCount = 0;

        for (const entity of groundedGraph.entities) {
            const nodeId = await upsertKnowledgeNode(clientId, entity.name, entity.type || 'ENTITY', entity.desc || '');
            if (nodeId) entityCount++;
        }

        for (const relationship of groundedGraph.relationships) {
            const saved = await upsertKnowledgeEdge(
                clientId,
                relationship.source,
                relationship.target,
                relationship.type,
                relationship.weight,
                relationship.context
            );
            if (saved) relationshipCount++;
        }

        console.log(`[Grounded Graph] ${entityCount} entidades + ${relationshipCount} relaciones validadas.`);
    } catch (e) {
        console.warn(`[GraphRAG] Error en extractor grounded: ${e.message}`);
    }
}

async function resolveOwnerName(clientId, soulData) {
    const soulName = pickBestHumanName(soulData?.soul_json?.nombre);
    if (soulName) return soulName;

    try {
        const { data: clientRow } = await supabase
            .from('clients')
            .select('name')
            .eq('user_id', clientId)
            .maybeSingle();

        const clientName = pickBestHumanName(clientRow?.name);
        if (clientName) return clientName;
    } catch (e) { }

    return deriveOwnerNameFromSlug(soulData?.slug) || 'Titular';
}

async function resolveConversationName(clientId, remoteId, messages) {
    const metadataLabels = [
        ...messages.map(message => message.metadata?.conversationName),
        ...messages.map(message => message.metadata?.pushName)
    ].filter(value => value && !looksLikeWhatsAppRemoteId(value));

    const metadataName = pickBestHumanName(...metadataLabels);
    if (metadataName) return metadataName;

    if (String(remoteId || '').endsWith('@g.us')) {
        try {
            const groupMeta = await discoverWhatsAppGroup(clientId, remoteId);
            const groupName = pickBestHumanName(groupMeta?.subject);
            if (groupName) return groupName;
        } catch (e) { }
    }

    try {
        const identity = await resolveIdentity(clientId, remoteId, metadataName);
        const resolved = pickBestHumanName(identity?.name, metadataName);
        if (resolved) return resolved;
    } catch (e) { }

    return fallbackNameFromRemoteId(remoteId) || remoteId;
}

function buildConversationLines(messages, ownerName, contactName) {
    return messages
        .map(message => renderConversationLine(message, ownerName, contactName))
        .filter(Boolean);
}

function selectOwnerAuthoredMessages(messages, ownerName) {
    const ownerKey = normalizeComparableText(ownerName);
    return (messages || []).filter(message => {
        const speaker = resolveStoredSpeakerName(message, ownerName, null);
        return normalizeComparableText(speaker) === ownerKey;
    });
}

// === AUTONOMOUS KNOWLEDGE DISTILLATION (AUTO-SOUL) ===
async function autonomousDistillation(clientId, clientSlug, messages, ownerName) {
    if (!messages?.length) return;
    try {
        const { data: soulRow } = await supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single();
        const currentSoul = soulRow?.soul_json || {};
        const ownerMessages = selectOwnerAuthoredMessages(messages, ownerName);
        if (!ownerMessages.length) return;

        const renderedConversation = buildConversationLines(ownerMessages, ownerName, null).join('\n');
        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{
                role: 'system',
                content: `Update Soul JSON using only explicit self-reported facts written by "${ownerName}". Ignore claims made by other speakers, quoted text and assumptions. If a field is not explicit in these self messages, do not add it. Return only the fields that should change.\nCURRENT SOUL: ${JSON.stringify(currentSoul)}\nSELF MESSAGES:\n${renderedConversation}`
            }],
            response_format: { type: 'json_object' }
        });
        const result = cleanJSON(response.choices[0].message.content);
        if (result) {
            const updatedSoul = { ...currentSoul, ...result };
            await supabase.from('user_souls').update({ soul_json: updatedSoul }).eq('client_id', clientId);
            await upsertKnowledgeNode(clientId, pickBestHumanName(updatedSoul.nombre, ownerName) || ownerName, 'PERSONA', `[ALMA] ${updatedSoul.bio || ''} `);

            // --- SYNC PHYSICAL MD FILES ---
            try {
                const fs = await import('fs/promises');
                const { encrypt } = await import('./security.mjs');
                const clientDir = `./clients/${clientSlug}`;

                await fs.mkdir(clientDir, { recursive: true });

                const soulMd = `# Identidad\nEres ${updatedSoul.nombre || 'OpenClaw'}. ${updatedSoul.tono || ''}\n\n# Situación: ${updatedSoul.perfil?.ocupacion?.situacion || 'N/A'}\n\n# Directrices\n${(updatedSoul.perfil?.directrices || []).map(d => `- ${d}`).join('\n')}`;
                await fs.writeFile(`${clientDir}/SOUL.md`, encrypt(soulMd));

                const userMd = `# Perfil\n- Usuario: ${updatedSoul.nombre || 'Usuario'}\n- Edad: ${updatedSoul.edad || 'N/A'}\n- Trabajo: ${updatedSoul.perfil?.ocupacion?.detalle || 'N/A'}\n- Herramientas: ${(updatedSoul.perfil?.herramientas || []).join(', ')}\n- Horario pico: ${updatedSoul.perfil?.disponibilidad?.horario_pico || 'N/A'}`;
                await fs.writeFile(`${clientDir}/USER.md`, encrypt(userMd));

                const contextMd = `# Contexto Actual\n- Última actualización: ${new Date().toLocaleDateString()}\n- Tempos: Atualizado vía Memory Worker Distillation.`;
                await fs.writeFile(`${clientDir}/CONTEXT.md`, encrypt(contextMd));

                const agentMd = `# Directrices de Agente (Axiomas e Instrucciones Core)\n- Núcleo Evolutivo sincronizado el ${new Date().toLocaleTimeString()}.\n${(updatedSoul.personal_directives || []).map(d => `- [DIRECTIVA]: ${d}`).join('\n')}\n${(updatedSoul.axiomas_filosoficos || []).map(a => `- [AXIOMA]: ${a}`).join('\n')}`;
                await fs.writeFile(`${clientDir}/AGENT.md`, encrypt(agentMd));

                console.log(`📝 [Auto-Soul] Archivos MD sincronizados para ${clientSlug}`);
            } catch (fsErr) {
                console.warn(`[Auto-Soul] Error escribiendo MDs: ${fsErr.message}`);
            }
        }
    } catch (e) {
        console.error('[Auto-Soul] Error:', e.message);
    }
}

// Helper to fix malformed JSON from LLM
function repairJson(str) {
    try {
        // Try simple cleanup
        let clean = str.trim();
        if (clean.includes('```json')) {
            clean = clean.split('```json')[1].split('```')[0].trim();
        } else if (clean.includes('```')) {
            clean = clean.split('```')[1].split('```')[0].trim();
        }

        // Fix common unclosed JSON issues
        if (clean.endsWith('}') === false) {
            // Attempt to count braces and close them
            const openBraces = (clean.match(/\{/g) || []).length;
            const closeBraces = (clean.match(/\}/g) || []).length;
            const openBrackets = (clean.match(/\[/g) || []).length;
            const closeBrackets = (clean.match(/\]/g) || []).length;

            for (let i = 0; i < (openBrackets - closeBrackets); i++) clean += ']';
            for (let i = 0; i < (openBraces - closeBraces); i++) clean += '}';
        }

        return JSON.parse(clean);
    } catch (e) {
        console.warn('[RepairJSON] Failed to repair:', e.message);
        return { entities: [], relationships: [] };
    }
}

async function saveGraphData(clientId, graphData) {
    for (const ent of (graphData.entities || [])) {
        await upsertKnowledgeNode(clientId, ent.name, ent.type || 'ENTITY', ent.desc || '');
    }
    for (const rel of (graphData.relationships || [])) {
        const weight = rel.weight ? Math.min(10, Math.max(1, Math.round(rel.weight * 10))) : 1;
        await upsertKnowledgeEdge(clientId, rel.source, rel.target, rel.type, weight, rel.context || '');
    }
}

/**
 * Main Logic for Distillation and Vectorization
 */
// === MAIN PROCESS: DISTILL + VECTORIZE + INBOX ===
export async function distillAndVectorize(clientId) {
    const { data: soulData } = await supabase.from('user_souls').select('slug, soul_json').eq('client_id', clientId).single();
    if (!soulData) return;
    const clientSlug = soulData.slug;
    const ownerName = await resolveOwnerName(clientId, soulData);

    // Acquire lock (Temporarily disabled for Antigravity debugging)
    /*
    const { data: soul2 } = await supabase.from('user_souls').select('is_processing').eq('client_id', clientId).single();
    if (soul2?.is_processing) {
        console.log(`[Worker] 🔒 Cliente ${clientId} bloqueado. Saltando.`);
        return;
    }
    await supabase.from('user_souls').update({ is_processing: true, worker_status: '🧠 Procesando...' }).eq('client_id', clientId);
    */

    try {
        let totalProcessedThisRun = 0;
        let hasMore = true;
        const LIMIT = 200;

        while (hasMore && totalProcessedThisRun < 1000) {
            const { data: messages } = await supabase.from('raw_messages').select('*').eq('client_id', clientId).eq('processed', false).order('created_at', { ascending: true }).limit(LIMIT);

            if (!messages?.length) {
                hasMore = false;
                break;
            }

            console.log(`🧠[Process] Lote de ${messages.length} mensajes(Acumulado: ${totalProcessedThisRun}) para ${clientSlug} `);

            const eligibleMessages = [];

            for (const message of messages) {
                message.content = sanitizeInput(message.content);
                if (!isMemoryEligibleRawMessage(message)) continue;
                eligibleMessages.push(message);
            }

            // --- Multimedia Pre-processing ---
            for (const m of eligibleMessages) {
                const attachments = m.metadata?.attachments || [];
                if (attachments.length > 0) {
                    console.log(`[Worker] 📎 Procesando ${attachments.length} adjuntos para mensaje ${m.id}`);
                    for (const att of attachments) {
                        try {
                            const result = await processAttachment(att);
                            if (result?.text) {
                                m.content = `${m.content} \n${result.text}`.trim();
                                // Persist text description back to raw_messages so we don't re-process media next time
                                await supabase.from('raw_messages').update({ content: m.content }).eq('id', m.id);
                            }
                        } catch (mediaErr) {
                            console.warn(`[Worker] ❌ Error procesando multimedia en ${m.id}: ${mediaErr.message}`);
                        }
                    }
                }
            }

            const conversations = {};
            eligibleMessages.forEach(m => {
                if (!conversations[m.remote_id]) {
                    conversations[m.remote_id] = { raw: [], firstMessageTime: m.created_at };
                }
                conversations[m.remote_id].raw.push(m);
            });

            for (const [remoteId, conv] of Object.entries(conversations)) {
                const contactName = await resolveConversationName(clientId, remoteId, conv.raw);
                const userName = ownerName;
                const isGroupConversation = String(remoteId || '').endsWith('@g.us');

                const CHUNK_SIZE = 50;
                const msgCount = conv.raw.length;

                // Preparar todos los chunks
                const allChunks = [];
                for (let i = 0; i < msgCount; i += CHUNK_SIZE) {
                    allChunks.push({
                        chunk: conv.raw.slice(i, i + CHUNK_SIZE),
                        startIndex: i
                    });
                }

                // Procesar en lotes paralelos (concurrencia de 10) para no saturar APIs
                const CONCURRENCY_LIMIT = 10;
                for (let b = 0; b < allChunks.length; b += CONCURRENCY_LIMIT) {
                    const batchChunks = allChunks.slice(b, b + CONCURRENCY_LIMIT);

                    await Promise.all(batchChunks.map(async ({ chunk, startIndex: i }) => {
                        const chunkRemoteId = remoteId;
                        const chunkUserName = userName;
                        const chunkContactName = contactName;
                        const chunkLines = buildConversationLines(chunk, chunkUserName, chunkContactName);
                        const chunkSpeakers = extractSpeakersFromLines(chunkLines);
                        const chunkText = chunkLines.join('\n');

                        if (!chunkText) {
                            console.log(`[Worker] ⏩ [Conv: ${chunkRemoteId}] Chunk ${i / CHUNK_SIZE} saltado (solo contenía media sin transcribir).`);
                            return;
                        }

                        try {
                            // 1. GraphRAG Extraction (entities & relations)
                            console.log(`[Worker] 🕸️ [Conv: ${chunkRemoteId}] Extrayendo grafo para chunk ${i / CHUNK_SIZE}...`);
                            await processConversationDepthStrict(clientId, chunkRemoteId, chunkUserName, chunkContactName, chunkLines, {
                                isGroup: isGroupConversation,
                                speakers: chunkSpeakers
                            });

                            // 2. Cognitive Depth (Soul Update & Insights) - MOVED OUTSIDE CHUNK LOOP OR CONSOLIDATED
                            // For massive re-processing, we will do this once per conversation group in the next block to save LLM calls

                        } catch (chunkErr) {
                            console.error(`[Worker] ❌ [Conv: ${chunkRemoteId}] Error en chunk ${i / CHUNK_SIZE}:`, chunkErr.message);
                            // No lanzamos error para permitir que el resto de la tanda se procese
                        }

                        try {
                            const chunkHeader = `[Fragmento Conversacional(Holograma)][Contacto: ${chunkContactName}][ID: ${chunkRemoteId}][Fecha: ${chunk[0]?.created_at || '?'}]\n`;
                            const enrichedText = chunkHeader + chunkText;
                            const holographicEmbedding = await generateEmbedding(enrichedText);
                            await supabase.from('user_memories').insert({
                                client_id: clientId,
                                content: enrichedText,
                                sender: dominantExternalSpeaker(chunk, chunkUserName, chunkContactName),
                                embedding: holographicEmbedding,
                                metadata: {
                                    remoteId: chunkRemoteId,
                                    contactName: chunkContactName,
                                    holographic: true,
                                    chunkIndex: i / CHUNK_SIZE,
                                    date: chunk[0]?.created_at,
                                    speakers: [...new Set(chunkLines.map(line => line.split(':')[0]).filter(Boolean))]
                                }
                            });
                        } catch (embErr) { }
                    }));
                }

                // 2. Consolidated Cognitive Depth (Once per conversation per batch)
                try {
                    console.log(`[Worker] 🧠 [Conv: ${contactName}] Actualizando profundidad cognitiva consolidada (${msgCount} msgs)...`);
                    const fullConversationLines = buildConversationLines(conv.raw, userName, contactName);
                    await processConversationDepthStrict(clientId, remoteId, userName, contactName, fullConversationLines, {
                        isGroup: isGroupConversation,
                        speakers: extractSpeakersFromLines(fullConversationLines)
                    });
                } catch (depthErr) {
                    console.error(`[Worker] ❌ [Conv: ${contactName}] Error en profundidad consolidada:`, depthErr.message);
                }
            }

            const allIds = messages.map(m => m.id).filter(id => id);
            for (let i = 0; i < allIds.length; i += 100) {
                const chunkIds = allIds.slice(i, i + 100);
                await supabase.from('raw_messages').update({ processed: true }).in('id', chunkIds);
            }
            console.log(`[Worker] ✅ ${allIds.length} mensajes marcados como procesados.`);

            totalProcessedThisRun += messages.length;

            console.log(`[Worker] 🍶 Iniciando Destilación Autónoma...`);
            await autonomousDistillation(clientId, soulData.slug, eligibleMessages.slice(-50), ownerName);
            console.log(`[Worker] ✅ Batch finalizado (Acumulado: ${totalProcessedThisRun})`);
        }
        await invalidateSemanticCache(clientId);
    } catch (e) {
        console.error('[Memory Worker] Error:', e.message);
    } finally {
        await supabase.from('user_souls').update({ is_processing: false, worker_status: '○ Cerebro en reposo' }).eq('client_id', clientId);
    }
}

// === 4. DREAM CYCLE ===
async function dreamCycle(clientId) {
    if (!ENABLE_DREAM_CYCLE) return;
    try {
        const { data: nodes } = await supabase.from('knowledge_nodes').select('entity_name, entity_type').eq('client_id', clientId).limit(50);
        const { data: edges } = await supabase.from('knowledge_edges').select('source_node, relationship_type, target_node').eq('client_id', clientId).limit(50);
        const { data: recentMemories } = await supabase.from('user_memories').select('content').eq('client_id', clientId).order('created_at', { ascending: false }).limit(10);
        if (!nodes?.length || !recentMemories?.length) return;

        const dreamResponse = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'system', content: 'Extrae conexiones latentes en JSON: {"latent_connections": [{"source", "relation", "target", "reasoning", "confidence"}]}' }, { role: 'user', content: `NODOS: ${nodes.map(n => n.entity_name).join(', ')} \nMEMORIAS: \n${recentMemories.map(m => m.content).join('\n')} ` }],
            response_format: { type: 'json_object' }
        });

        const discovery = parseLLMJson(dreamResponse.choices[0].message.content);
        for (const conn of (discovery?.latent_connections || [])) {
            if (conn.confidence > 0.7) {
                await upsertKnowledgeNode(clientId, conn.source, 'ENTITY', 'Deducido');
                await upsertKnowledgeNode(clientId, conn.target, 'ENTITY', 'Deducido');
                await upsertKnowledgeEdge(clientId, conn.source, conn.target, conn.relation, 0.5, conn.reasoning);
            }
        }
    } catch (e) { }
}

// === 5. MEMORY CONSOLIDATION ===
async function consolidateMemories() {
    try {
        const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: oldMemories } = await supabase.from('user_memories').select('*').lt('created_at', cutoffDate).order('created_at', { ascending: true }).limit(1000);
        if (!oldMemories?.length) return;

        const groups = {};
        for (const mem of oldMemories) {
            const key = `${mem.client_id}::${mem.metadata?.remoteId || 'unknown'} `;
            if (!groups[key]) groups[key] = [];
            groups[key].push(mem);
        }

        for (const [key, memories] of Object.entries(groups)) {
            if (memories.length < 5) continue;
            const [clientId, remoteId] = key.split('::');
            const summaryRes = await groq.chat.completions.create({
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'system', content: 'Consolida en narrativa densa.' }, { role: 'user', content: memories.map(m => m.content).join('\n') }]
            });
            const summary = summaryRes.choices[0].message.content;
            const embedding = await generateEmbedding(summary);
            await supabase.from('user_memories').insert({
                client_id: clientId, content: `[HISTORIA CONSOLIDADA]\n${summary} `,
                sender: 'system_consolidation', embedding, metadata: { remoteId, consolidated: true, level: 1 }
            });
            await supabase.from('user_memories').delete().in('id', memories.map(m => m.id));
        }
    } catch (e) { }
}

async function cleanupRawMessages() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('raw_messages').delete().eq('processed', true).lt('created_at', cutoff);
}

// === MAIN ===
async function main() {
    console.log('🚀 OpenClaw Memory Worker 2026 Online');
    try {
        const redisSub = redisClient.duplicate();
        await redisSub.connect();

        await redisSub.subscribe('__keyevent@0__:expired', async (key) => {
            if (key.startsWith('idle:')) {
                const clientId = key.split('idle:')[1];
                await distillAndVectorize(clientId);
            }
        });

        cron.schedule('*/30 * * * *', async () => {
            const { data: clients } = await supabase.from('raw_messages').select('client_id').eq('processed', false);
            const active = [...new Set(clients?.map(c => c.client_id))];
            for (const cid of active) await distillAndVectorize(cid);
        });
        if (ENABLE_DREAM_CYCLE) {
            cron.schedule('0 3 * * *', async () => {
                const { data: clients } = await supabase.from('user_souls').select('client_id');
                for (const c of (clients || [])) await dreamCycle(c.client_id);
            });
        } else {
            console.log('[Dream Cycle] Disabled by default. Set OPENCLAW_ENABLE_DREAM_CYCLE=true to opt in.');
        }
        cron.schedule('0 */3 * * *', consolidateMemories);
        cron.schedule('0 4 * * *', cleanupRawMessages);
    } catch (err) { }
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedFile === currentFile) {
    main().catch(console.error);
}
