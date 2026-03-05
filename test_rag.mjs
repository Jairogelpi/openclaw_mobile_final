import supabase from './config/supabase.mjs';

async function test() {
    const { data: nodes, error: nodeErr } = await supabase
        .from('knowledge_nodes')
        .select('entity_name, description')
        .eq('entity_name', 'Mireya')
        .limit(1);

    console.log('Node Error:', nodeErr);
    console.log('Node Found:', !!nodes?.length);
    if (nodes?.length) {
        console.log('Description:', nodes[0].description);
    }

    const { data: edges, error: edgeErr } = await supabase
        .from('knowledge_edges')
        .select('*')
        .or('source_node.eq.Mireya,target_node.eq.Mireya');

    console.log('Edge Error:', edgeErr);
    console.log('Edges Found:', edges?.length || 0);
    if(edges?.length) {
        console.log('First Edge:', edges[0]);
    }
}

test();
