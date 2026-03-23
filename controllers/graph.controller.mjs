import supabase from '../config/supabase.mjs';

/**
 * Fetches full knowledge graph for 3D visualization.
 */
export async function getGraphData(req, res) {
    const { clientId } = req.params;

    try {
        // --- 1. Fetch ALL Nodes (Paginated) ---
        let allNodes = [];
        let fromNode = 0;
        let hasMoreNodes = true;
        while (hasMoreNodes) {
            const { data, error } = await supabase
                .from('knowledge_nodes')
                .select('entity_name, entity_type, description, created_at')
                .eq('client_id', clientId)
                .range(fromNode, fromNode + 999);

            if (error) throw error;
            allNodes = [...allNodes, ...data];
            fromNode += 1000;
            if (data.length < 1000) hasMoreNodes = false;
            if (fromNode >= 10000) hasMoreNodes = false; // Safety cap
        }

        // --- 2. Fetch ALL Edges (Paginated) ---
        let allEdges = [];
        let fromEdge = 0;
        let hasMoreEdges = true;
        while (hasMoreEdges) {
            const { data, error } = await supabase
                .from('knowledge_edges')
                .select('source_node, target_node, relation_type, weight, context, cognitive_flags, created_at, last_seen')
                .eq('client_id', clientId)
                .range(fromEdge, fromEdge + 999);

            if (error) throw error;
            allEdges = [...allEdges, ...data];
            fromEdge += 1000;
            if (data.length < 1000) hasMoreEdges = false;
            if (fromEdge >= 10000) hasMoreEdges = false; // Safety cap
        }

        // --- 3. Fetch Client Info for Biography ---
        const { data: clientData } = await supabase
            .from('user_souls')
            .select('soul_json')
            .eq('client_id', clientId)
            .single();

        const ownerName = clientData?.soul_json?.nombre || "Usuario";
        const bio = clientData?.soul_json?.resumen_narrativo || "Dueño de esta red neuronal.";

        // --- 4. Format for 3D Visualizer ---
        const nodeSet = new Set(allNodes.map(n => n.entity_name));
        const finalNodes = allNodes.map(n => ({
            id: n.entity_name,
            name: n.entity_name,
            type: n.entity_type,
            description: (n.entity_name === ownerName || n.entity_name === 'Usuario') ? bio : n.description,
            created_at: n.created_at
        }));

        const finalLinks = allEdges.map(e => ({
            source: e.source_node,
            target: e.target_node,
            relation: e.relation_type,
            weight: (e.weight || 0) + 1,
            context: e.context,
            flags: e.cognitive_flags,
            created_at: e.created_at,
            last_seen: e.last_seen
        }));

        // Ghost Node Protection
        finalLinks.forEach(link => {
            if (!nodeSet.has(link.source)) {
                finalNodes.push({ id: link.source, name: link.source, type: 'ENTITY', description: 'Referencia automática.' });
                nodeSet.add(link.source);
            }
            if (!nodeSet.has(link.target)) {
                finalNodes.push({ id: link.target, name: link.target, type: 'ENTITY', description: 'Referencia automática.' });
                nodeSet.add(link.target);
            }
        });

        if (!nodeSet.has(ownerName)) {
            finalNodes.push({ id: ownerName, name: ownerName, type: 'PERSONA', description: bio });
        }

        res.json({ nodes: finalNodes, links: finalLinks, ownerName });
    } catch (err) {
        console.error('[Graph-API] Fatal Error:', err);
        res.status(500).json({ error: err.message });
    }
}
