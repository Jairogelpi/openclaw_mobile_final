import supabase from './config/supabase.mjs';

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6'; 

async function testSearch(query) {
    console.log(`\n--- Testing RPC search_knowledge_nodes_v2 with query: "${query}" ---`);
    const { data, error } = await supabase.rpc('search_knowledge_nodes_v2', {
        cid: clientId,
        query: query,
        lim: 10
    });

    if (error) {
        console.error('Error:', error.message);
        return;
    }

    console.log(`Results (${data?.length || 0}):`);
    data?.forEach(n => {
        console.log(`- ${n.entity_name} (${n.entity_type}, similarity: ${n.similarity}): ${n.description?.substring(0, 50)}...`);
    });
}

(async () => {
    await testSearch('Sara');
    await testSearch('Victor');
    await testSearch('quien es victor y que relacion tiene con sara');
})();
