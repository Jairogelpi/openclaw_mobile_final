import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkCounts() {
    const { count: personas } = await supabase.from('contact_personas').select('*', { count: 'exact', head: true });
    const { count: communities } = await supabase.from('knowledge_communities').select('*', { count: 'exact', head: true });
    const { count: nodeCommunities } = await supabase.from('node_communities').select('*', { count: 'exact', head: true });
    console.log(`contact_personas: ${personas}`);
    console.log(`knowledge_communities: ${communities}`);
    console.log(`node_communities: ${nodeCommunities}`);
    process.exit(0);
}
checkCounts();
