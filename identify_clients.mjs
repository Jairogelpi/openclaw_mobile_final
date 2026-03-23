import supabase from './config/supabase.mjs';

async function identifyActiveClients() {
    console.log(`\n--- Identifying Active Client IDs in user_memories ---`);
    const { data, error } = await supabase
        .from('user_memories')
        .select('client_id')
        .limit(100);

    if (error) {
        console.error('Error:', error.message);
        return;
    }

    const uniqueIds = [...new Set(data.map(m => m.client_id))];
    console.log(`Unique client_ids with memories:`, uniqueIds);

    console.log(`\n--- Identifying Active Client IDs in knowledge_nodes ---`);
    const { data: nodesData, error: nodesError } = await supabase
        .from('knowledge_nodes')
        .select('client_id')
        .limit(100);

    if (nodesError) {
        console.warn('Error fetching nodes:', nodesError.message);
    } else {
        const uniqueNodeIds = [...new Set(nodesData.map(n => n.client_id))];
        console.log(`Unique client_ids with knowledge nodes:`, uniqueNodeIds);
    }
}

(async () => {
    await identifyActiveClients();
})();
