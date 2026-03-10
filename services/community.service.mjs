import supabase from '../config/supabase.mjs';
import groq from '../services/groq.mjs';
import { filterValidCommunityNodeIds } from '../utils/community_guard.mjs';

const parseLLMJson = (text) => {
    try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        console.warn('⚠️ [LLM-JSON] Fallback parsing failed in Community Service');
        throw e;
    }
};

/**
 * Level 1 GraphRAG: Community Detection
 * Extrae Nodos que no tengan comunidad y los agrupa.
 */
export async function detectAndSaveCommunities(clientId) {
    try {
        // 1. Obtener nodos (limitado a 50 huérfanos para no saturar contextos)
        // En un caso real usaríamos un JOIN o una vista para saber cuáles no están en node_communities
        // Por simplicidad en este MVP, cogemos los últimos 50 nodos modificados
        const { data: nodes, error } = await supabase
            .from('knowledge_nodes')
            .select('id, entity_name, description')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error || !nodes || nodes.length < 5) {
            console.log(`🌍 [Community] No hay suficientes nodos nuevos para agrupar.`);
            return;
        }

        const nodesList = nodes.map(n => `[ID: ${n.id}] ${n.entity_name} - ${n.description}`).join('\n');
        const validNodeIds = new Set(nodes.map(node => node.id).filter(Boolean));

        // 2. LLM Clustering (Leiden Algorithm emulado por LLM)
        const clusterPrompt = `Eres un Algoritmo de Detección de Comunidades (GraphRAG Nivel 1).
Tu objetivo es analizar esta lista de nodos aislados y agruparlos en "Comunidades Temáticas" o "Eventos" (ej. "Trabajo Startup X", "Amigos del Instituto", "Viaje a Japón Verano 2024").

NODOS DISPONIBLES:
${nodesList}

Reglas:
1. Agrupa nodos que tengan relación obvia.
2. Cada comunidad DEBE tener un "temporal_horizon" (Mes y Año aproximado, ej. "Marzo 2024", o "Actualidad" si no se deduce).
3. "summary" debe ser una EXPLICACIÓN MACRO (The Big Picture). Redacta un párrafo detallado (3-5 líneas) como si fueras un novelista resumiendo ese grupo, conectando a la gente y los hechos. (Ej: "En el Trabajo X, Juan interactúa con Ana y el Jefe, enfocados en el Proyecto Z que les causa estrés...").

Responde ÚNICAMENTE en JSON con esta estructura:
{
  "communities": [
    {
      "name": "Nombre_Descriptivo",
      "temporal_horizon": "Mes Año",
      "summary": "Resumen macro ultra-detallado de cómo interactúan estos nodos...",
      "node_ids": ["ID1", "ID2"]
    }
  ]
}
`;

        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile', // Usamos 70B porque el "Macro Summary" es vital
            messages: [{ role: 'system', content: clusterPrompt }],
            response_format: { type: 'json_object' },
            temperature: 0.3
        });

        const discovery = parseLLMJson(response.choices[0].message.content);

        // 3. Guardar en Base de Datos
        if (discovery.communities && discovery.communities.length > 0) {
            console.log(`🌍 [Community] Se detectaron ${discovery.communities.length} nuevas comunidades.`);
            for (const comm of discovery.communities) {
                const validCommunityNodeIds = filterValidCommunityNodeIds(comm.node_ids, validNodeIds);
                if (validCommunityNodeIds.length < 2) continue; // Ignorar comunidades de 1 nodo o IDs inválidos

                // Insertar Comunidad
                const { data: insertedComm, error: commError } = await supabase
                    .from('knowledge_communities')
                    .insert({
                        client_id: clientId,
                        community_name: comm.name,
                        summary: comm.summary,
                        temporal_horizon: comm.temporal_horizon
                    })
                    .select('id')
                    .single();

                if (commError) {
                    console.error(`🌍 [Community] Error insertando comunidad ${comm.name}:`, commError.message);
                    continue;
                }

                // Relacionar Nodos
                const relations = filterValidCommunityNodeIds(validCommunityNodeIds, validNodeIds).map(nodeId => ({
                    node_id: nodeId,
                    community_id: insertedComm.id
                }));

                if (relations.length < 2) {
                    console.warn(`ðŸŒ [Community] ${comm.name} descartada tras validaciÃ³n final de node_ids.`);
                    continue;
                }

                const { error: relError } = await supabase
                    .from('node_communities')
                    .insert(relations);

                if (relError) {
                    console.error(`🌍 [Community] Error vinculando nodos a ${comm.name}:`, relError.message);
                } else {
                    console.log(`   ✨ [Macro-Nodo Creado] ${comm.name} (${comm.temporal_horizon}): ${relations.length} entidades agrupadas.`);
                }
            }
        }

    } catch (error) {
        console.error(`🌍 [Community] Error en el análisis macro:`, error.message);
    }
}
