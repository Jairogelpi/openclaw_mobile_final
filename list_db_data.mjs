import supabase from './config/supabase.mjs';

const clientId = '56d7732a-773a-446a-861f-178657689544'; 

async function listAllNodes() {
    console.log(`\n--- Listing all knowledge_nodes for clientId: ${clientId} ---`);
    const { data, error, count } = await supabase
        .from('knowledge_nodes')
        .select('*', { count: 'exact' })
        .eq('client_id', clientId)
        .limit(20);

    if (error) {
        console.error('Error:', error.message);
        return;
    }

    console.log(`Total nodes in DB for this client: ${count}`);
    data.forEach(n => {
        console.log(`- ${n.entity_name} (${n.entity_type}): ${n.description?.substring(0, 50)}...`);
    });
}

async function listAllMemories() {
    console.log(`\n--- Listing all user_memories for clientId: ${clientId} ---`);
    const { data, error, count } = await supabase
        .from('user_memories')
        .select('*', { count: 'exact' })
        .eq('client_id', clientId)
        .limit(5);

    if (error) {
        console.error('Error:', error.message);
        return;
    }

    console.log(`Total memories in DB for this client: ${count}`);
    data.forEach(m => {
        console.log(`- [${m.created_at}] ${m.content.substring(0, 100)}...`);
    });
}

(async () => {
    await listAllNodes();
    await listAllMemories();
})();
