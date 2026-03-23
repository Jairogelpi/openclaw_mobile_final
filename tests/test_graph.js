import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
    const clientId = 'eecae11f-744e-44ae-910d-2e83d9424b77';
    console.log("Nodes...");
    const { data: nodesData, error: nodesErr } = await supabase
        .from('knowledge_nodes')
        .select('node_id, entity_type, description')
        .eq('client_id', clientId);
    console.log(nodesErr);

    console.log("Edges...");
    const { data: edgesData, error: edgesErr } = await supabase
        .from('knowledge_edges')
        .select('source_node, target_node, relation_type')
        .eq('client_id', clientId);
    console.log(edgesErr);
}
test();
