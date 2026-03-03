import supabase from '../config/supabase.mjs';
import { generateEmbedding } from './local_ai.mjs';

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
        content: `[Resonancia Cognitiva: ${(g.cognitive_resonance * 100).toFixed(1)}%] [Ruta: ${g.reasoning_path}]\n${g.knowledge}`,
        sender: g.entity_type,
        similarity: g.cognitive_resonance,
        hop: g.hop,
        source: 'GRAPH_V3'
    }));
}

/**
 * Guarda o actualiza un nodo de conocimiento.
 */
export async function upsertKnowledgeNode(clientId, entityName, entityType, description) {
    // 1. Buscar si ya existe
    const { data: existing } = await supabase
        .from('knowledge_nodes')
        .select('id')
        .eq('client_id', clientId)
        .eq('entity_name', entityName)
        .single();

    if (existing) return existing.id;

    // 2. Generar embedding si no existe
    const embedding = await generateEmbedding(`${entityName} ${description || ''}`);

    // 3. Insertar
    const { data: inserted, error } = await supabase.from('knowledge_nodes').insert({
        client_id: clientId,
        entity_name: entityName,
        entity_type: entityType,
        description: description,
        embedding: embedding
    }).select('id').single();

    if (error) {
        console.error('[Graph Service] Error upserting node:', error.message);
        throw error;
    }
    return inserted.id;
}

/**
 * Crea o actualiza una relación (edge) entre dos nodos.
 */
/**
 * Crea o actualiza una relación (edge) entre dos nombres de entidad.
 */
export async function upsertKnowledgeEdge(clientId, sourceName, targetName, relationType) {
    const { error } = await supabase.from('knowledge_edges').upsert({
        client_id: clientId,
        source_node: sourceName,
        target_node: targetName,
        relation_type: relationType
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

    return (data || []).map(m => ({ ...m, source: 'HYBRID' }));
}
