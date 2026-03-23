import { traverseGraph, hybridSearch } from '../services/graph.service.mjs';
import { generateEmbedding } from '../services/local_ai.mjs';

async function test() {
    try {
        const query = "conoce a mireya?";

        // Let's get an actual client id
        const supabase = (await import('../config/supabase.mjs')).default;
        const { data: clients } = await supabase.from('clients').select('user_id').limit(1);
        if (!clients || clients.length === 0) {
            console.log("No clients found");
            return;
        }
        const activeClientId = clients[0].user_id;

        console.log("Testing with client:", activeClientId);
        const vector = await generateEmbedding(query);

        const graph = await traverseGraph(activeClientId, query, vector, 5);
        console.log("Graph Nodes Size:", graph.length);
        if (graph.length > 0) {
            console.log("Top node:", graph[0]);
        }

    } catch (e) {
        console.error("Test failed:", e);
    }
}

test();
