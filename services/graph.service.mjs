import supabase from '../config/supabase.mjs';
import { generateEmbedding } from './local_ai.mjs';
import groq from './groq.mjs';
import redisClient from '../config/redis.mjs';

const parseLLMJson = (text) => {
    try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        return null;
    }
};

/**
 * Ejecuta un recorrido del grafo de conocimiento (GraphRAG).
 */
export async function traverseGraph(clientId, queryText, queryVector, matchCount = 5) {
    const { data, error } = await supabase.rpc('graphrag_traverse', {
        query_text: queryText,
        query_embedding: queryVector,
        match_count: matchCount,
        p_client_id: clientId
    });

    if (error) {
        console.warn('[Graph Service] Fallo en traversal:', error.message);
        throw error;
    }

    return (data || []).map(g => ({
        content: `[Resonancia: ${(g.cognitive_resonance * 100).toFixed(1)}%] [Ruta: ${g.reasoning_path}] [Visto: ${g.last_seen || g.created_at || 'N/A'}]\n${g.knowledge}`,
        sender: g.entity_type,
        similarity: g.cognitive_resonance,
        hop: g.hop,
        timestamp: g.last_seen || g.created_at || null,
        source: 'GRAPH_V3'
    }));
}

/**
 * Guarda o actualiza un nodo de conocimiento.
 */
/**
 * Guarda o actualiza un nodo de conocimiento con DESAMBIGUACIÓN (Entity Disambiguation)
 */
export async function upsertKnowledgeNode(clientId, entityName, entityType, description) {
    // 0. EXEMPTION GUARD: Never split or suffix the owner identity
    // Dynamically resolve the owner's canonical name from the soul
    const { data: soulRow } = await supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single();
    const ownerCanonicalName = soulRow?.soul_json?.nombre || null;

    if (ownerCanonicalName && (entityName === ownerCanonicalName || entityName === 'Usuario')) {
        entityName = ownerCanonicalName;
        const { data: ownerNode } = await supabase
            .from('knowledge_nodes')
            .select('id')
            .eq('client_id', clientId)
            .eq('entity_name', ownerCanonicalName)
            .single();
        if (ownerNode) return ownerNode.id;
    }

    // 1. Buscar TODOS los nodos que tengan exactamente este nombre
    const { data: existingNodes } = await supabase
        .from('knowledge_nodes')
        .select('id, entity_name, description')
        .eq('client_id', clientId)
        .eq('entity_name', entityName);

    let finalEntityName = entityName;
    let targetNodeId = null;

    if (existingNodes && existingNodes.length > 0) {
        // 2. Si hay coincidencias, usamos un LLM rápido como Árbitro de Identidad
        for (const node of existingNodes) {
            const prompt = `Actúas como un Árbitro de Identidad para un Grafo de Conocimiento (Entity Disambiguation).
            
OBJETIVO: El usuario menciona una entidad llamada "${entityName}".
NUEVA INFO: "${description || 'Sin descripción'}"

ENTIDAD YA EXISTENTE EN BASE DE DATOS:
NOMBRE: "${node.entity_name}"
INFO ANTIGUA: "${node.description || 'Sin descripción'}"

PREGUNTA: ¿Es altamente probable que estas dos entradas se refieran a la MISMA entidad/persona física o concepto único?
REGLAS:
1. Sé CONSERVADOR al crear nodos nuevos. Si hablan de la misma persona en diferentes contextos, es la MISMA entidad.
2. Solo devuelve is_same = false si hay evidencia inequívoca de que son entidades distintas (ej: "Mireya la de Madrid" vs "Mireya la de Londres").
3. Si los contextos son complementarios (ej: "Trabaja en X" y "Le gusta el rap"), SON la misma entidad.

Responde solo JSON: {"is_same": boolean, "new_suffix": "string"}`;
            try {
                const response = await groq.chat.completions.create({
                    model: 'llama-3.3-70b-versatile', // UPGRADE: More precision to prevent fragmentation
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0, // Determinístico
                    response_format: { type: 'json_object' }
                });

                const arbitration = parseLLMJson(response.choices[0].message.content);

                if (arbitration?.is_same) {
                    targetNodeId = node.id;
                    break; // Encontramos la coincidencia perfecta, detenemos la búsqueda
                } else if (arbitration?.new_suffix) {
                    finalEntityName = `${entityName}_${arbitration.new_suffix.replace(/\s+/g, '')}`;
                    // Al cambiar el finalEntityName, forzaremos la creación de un nuevo nodo abajo
                }
            } catch (e) {
                console.warn('[Graph Disambiguation] LLM fallback falló, asumiendo misma entidad por seguridad.');
                targetNodeId = node.id;
                break;
            }
        }
    }

    // 3A. Si es la misma entidad exacta, devolvemos su ID antiguo
    if (targetNodeId) {
        // Opcional: Podrías actualizar la descripción aquí combinándola
        return targetNodeId;
    }

    // 3B. Generar embedding para el nuevo nodo (con o sin sufijo alterado)
    const embedding = await generateEmbedding(`${finalEntityName} ${description || ''}`);

    // 4. Insertar o actualizar el nodo diferenciado
    const { data: inserted, error } = await supabase.from('knowledge_nodes').upsert({
        client_id: clientId,
        entity_name: finalEntityName,
        entity_type: entityType,
        description: description,
        embedding: embedding
    }, { onConflict: 'client_id, entity_name' }).select('id').single();

    if (error) {
        console.error('[Graph Service] Error upserting node:', error.message);
        throw error;
    }

    if (finalEntityName !== entityName) {
        console.log(`🔍 [Entity Disambiguation] Bifurcación! El nodo '${entityName}' chocaba con uno antiguo. Creado como: '${finalEntityName}'`);
    }

    return inserted.id;
}

/**
 * Crea o actualiza una relación (edge) entre dos nodos.
 */
/**
 * Crea o actualiza una relación (edge) entre dos nombres de entidad.
 */
export async function upsertKnowledgeEdge(clientId, sourceName, targetName, relationType, weight = 1, context = null, flags = {}) {
    // cognitive_flags expects JSONB — wrap object in array for compatibility
    const flagsPayload = Array.isArray(flags) ? flags : [flags];
    // weight column is INTEGER — convert float valence (-1..1) to int scale (0..10)
    const intWeight = Math.round((parseFloat(weight) + 1) * 5) || 5;
    const { error } = await supabase.from('knowledge_edges').upsert({
        client_id: clientId,
        source_node: sourceName,
        target_node: targetName,
        relation_type: relationType,
        weight: intWeight,
        context: context,
        cognitive_flags: flagsPayload,
        last_seen: new Date().toISOString()
    }, { onConflict: 'client_id, source_node, relation_type, target_node' });

    if (error) {
        console.error('[Graph Service] Error upserting edge:', error.message);
        throw error;
    }
    return true;
}

/**
 * Realiza una búsqueda híbrida (Semántica + Texto) en memorias.
 */
export async function hybridSearch(clientId, queryText, queryVector, matchCount = 10) {
    const { data, error } = await supabase.rpc('hybrid_search_memories', {
        query_text: queryText,
        query_embedding: queryVector,
        match_count: matchCount,
        p_client_id: clientId
    });

    if (error) {
        console.warn('[Graph Service] Fallo en búsqueda híbrida:', error.message);
        throw error;
    }
    // 1. Efectuar Búsqueda Híbrida Vectorial habitual
    const results = (data || []).map(m => ({
        ...m,
        source: 'HYBRID',
        remote_id: m.remote_id
    }));

    // E. NAME-AWARE SENDER FILTER with ALIAS RESOLUTION
    const nameRegex = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/g;
    const stopWords = new Set(['Que', 'Como', 'Cuando', 'Donde', 'Quien', 'Por', 'Para', 'Con', 'Sin', 'Sobre', 'Hasta', 'Desde', 'Hola', 'Bueno', 'Todo', 'Algo', 'Nada', 'Muy', 'Pero', 'Porque', 'Esto', 'Eso', 'Dime', 'Necesito', 'Saber', 'Quiero', 'Hay', 'Una', 'Uno']);
    const detectedNames = [...new Set([...queryText.matchAll(nameRegex)].map(m => m[1]).filter(n => !stopWords.has(n) && n.length > 2))];

    if (detectedNames.length > 0) {
        // ALIAS RESOLUTION: Expandir nombres usando soul network + graph
        const expandedNames = new Set(detectedNames);
        try {
            // 1. Check soul network for aliases (e.g. "Victor" might match "Valdés" in network)
            const { data: soulRow } = await supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single();
            const network = soulRow?.soul_json?.network || {};

            // 2. Get all PERSONA nodes from graph
            const { data: personaNodes } = await supabase.from('knowledge_nodes')
                .select('entity_name').eq('client_id', clientId).eq('entity_type', 'PERSONA');

            // 2.b. New: Get real names from contact_personas
            const { data: contactPersonas } = await supabase.from('contact_personas')
                .select('display_name, remote_id').eq('client_id', clientId);

            // 3. Get unique sender names from memories
            const { data: senderData } = await supabase.from('user_memories')
                .select('sender').eq('client_id', clientId);
            const uniqueSenders = [...new Set((senderData || []).map(s => s.sender).filter(Boolean))];

            // Build alias pool from all sources
            const allKnownNames = [
                ...Object.keys(network),
                ...(personaNodes || []).map(n => n.entity_name),
                ...(contactPersonas || []).map(p => p.display_name).filter(Boolean),
                ...uniqueSenders
            ];

            // 3.b. New: Direct mapping from contact_personas display_name -> remote_id (sender name)
            for (const cp of (contactPersonas || [])) {
                if (!cp.display_name) continue;
                for (const queryName of detectedNames) {
                    if (cp.display_name.toLowerCase().includes(queryName.toLowerCase())) {
                        // If "Victor" matches "Victor Valdés", add "Valdés" (the likely sender name)
                        expandedNames.add(cp.display_name);
                        // Extract parts
                        cp.display_name.split(' ').forEach(part => {
                            if (part.length > 3) expandedNames.add(part);
                        });
                    }
                }
            }

            // Also do REVERSE LOOKUP: if "Victor" appears in a network VALUE, add the KEY
            for (const [key, value] of Object.entries(network)) {
                const valLower = (value || '').toLowerCase();
                for (const queryName of detectedNames) {
                    if (valLower.includes(queryName.toLowerCase())) {
                        expandedNames.add(key);
                    }
                }
            }

            // 4. REDIS CONTACT NAMES: Get real WhatsApp contact names
            if (redisClient) {
                try {
                    const pattern = `contacts:${clientId}:*`;
                    let cursor = 0;
                    const redisNames = [];
                    do {
                        const result = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 200 });
                        cursor = result.cursor;
                        for (const contactKey of result.keys) {
                            const contactData = await redisClient.get(contactKey);
                            if (contactData) {
                                try {
                                    const parsed = JSON.parse(contactData);
                                    if (parsed.name) redisNames.push(parsed.name);
                                } catch (e) {
                                    if (contactData && contactData.length < 50) redisNames.push(contactData);
                                }
                            }
                        }
                    } while (cursor !== 0);

                    // Match detected names against Redis contacts (min 3 chars to avoid false positives)
                    for (const queryName of detectedNames) {
                        if (queryName.length < 3) continue;
                        const qLower = queryName.toLowerCase();
                        for (const rName of redisNames) {
                            if (rName.length < 3) continue;
                            const rLower = rName.toLowerCase();
                            if (rLower.includes(qLower) ||
                                rLower.split(' ').some(p => p.length > 2 && p === qLower)) {
                                expandedNames.add(rName);
                                // Also add individual name parts (min 4 chars to avoid noise)
                                rName.split(' ').forEach(part => {
                                    if (part.length > 3) expandedNames.add(part);
                                });
                            }
                        }
                    }
                    if (redisNames.length > 0) console.log(`📱 [Contact Sync] ${redisNames.length} contactos WhatsApp en pool de alias`);
                } catch (e) {
                    console.warn('[Redis Contacts] Error:', e.message);
                }
            }

            // For each detected name, find aliases in the pool
            for (const queryName of detectedNames) {
                const qLower = queryName.toLowerCase();
                for (const known of allKnownNames) {
                    if (!known) continue;
                    const kLower = known.toLowerCase().replace(/[🌸🖤💕]/g, '').trim();
                    // Match if: partial match, or same person different form
                    if (kLower.includes(qLower) || qLower.includes(kLower) ||
                        kLower.split(' ').some(part => part === qLower) ||
                        qLower.split(' ').some(part => part === kLower)) {
                        expandedNames.add(known);
                    }
                }
            }

            if (expandedNames.size > detectedNames.length) {
                console.log(`🔗 [Name Resolution] "${detectedNames.join(', ')}" → expandido a: ${[...expandedNames].join(', ')}`);
            }
        } catch (e) {
            console.warn('[Name Resolution] Error:', e.message);
        }

        // Search by ALL expanded names (original + aliases)
        for (const name of expandedNames) {
            try {
                const cleanName = name.replace(/[🌸🖤💕]/g, '').trim();
                const { data: senderMatches } = await supabase
                    .from('user_memories')
                    .select('id, content, sender, metadata')
                    .eq('client_id', clientId)
                    .ilike('sender', `%${cleanName}%`)
                    .order('created_at', { ascending: false })
                    .limit(10);

                if (senderMatches?.length > 0) {
                    console.log(`🎯 [Name Filter] Encontrados ${senderMatches.length} recuerdos directos de sender "${cleanName}"`);
                    for (const sm of senderMatches) {
                        if (!results.some(r => r.id === sm.id)) {
                            results.push({
                                ...sm,
                                date: sm.metadata?.dateStart || null,
                                similarity: 0.9,
                                source: 'SENDER_FILTER'
                            });
                        }
                    }
                }

                // Also search content mentioning the name
                const { data: contentMatches } = await supabase
                    .from('user_memories')
                    .select('id, content, sender, metadata')
                    .eq('client_id', clientId)
                    .ilike('content', `%${cleanName}%`)
                    .order('created_at', { ascending: false })
                    .limit(5);

                if (contentMatches?.length > 0) {
                    for (const cm of contentMatches) {
                        if (!results.some(r => r.id === cm.id)) {
                            results.push({
                                ...cm,
                                date: cm.metadata?.dateStart || null,
                                similarity: 0.85,
                                source: 'CONTENT_NAME_MATCH'
                            });
                        }
                    }
                }
            } catch (e) {
                console.warn(`[Name Filter] Error buscando "${name}":`, e.message);
            }
        }
    }

    // 2. RECUPERACIÓN DE COMUNIDADES (GraphRAG Level 1)
    try {
        const { data: communities } = await supabase
            .from('knowledge_communities')
            .select('community_name, temporal_horizon, summary')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(3);

        if (communities && communities.length > 0) {
            for (const comm of communities) {
                results.push({
                    content: `[MACRO-COMUNIDAD: ${comm.community_name} | ÉPOCA: ${comm.temporal_horizon}]\nRESUMEN GLOBAL: ${comm.summary}`,
                    sender: 'SYSTEM_MACRO_GRAPH',
                    similarity: 0.95,
                    source: 'COMMUNITY_SUMMARY'
                });
            }
        }
    } catch (e) {
        console.warn('[Graph Service] Fallo al recuperar comunidades:', e.message);
    }

    return results;
}
