import supabase from '../config/supabase.mjs';

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
        content: g.knowledge,
        sender: g.entity_type,
        similarity: null,
        hop: g.hop,
        source: 'GRAPH'
    }));
}

/**
 * Guarda o actualiza un nodo de conocimiento.
 */
export async function upsertKnowledgeNode(clientId, entityName, entityType, description) {
    const { data, error } = await supabase.rpc('upsert_knowledge_node', {
        p_client_id: clientId,
        p_name: entityName,
        p_type: entityType,
        p_description: description
    });

    if (error) {
        console.error('[Graph Service] Error upserting node:', error.message);
        throw error;
    }
    return data; // Retorna el ID del nodo
}

/**
 * Crea o actualiza una relación (edge) entre dos nodos.
 */
export async function upsertKnowledgeEdge(clientId, sourceId, targetId, relationType) {
    const { error } = await supabase.from('knowledge_edges').upsert({
        client_id: clientId,
        source_id: sourceId,
        target_id: targetId,
        relation_type: relationType
    }, { onConflict: 'client_id, source_id, target_id, relation_type' });

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
