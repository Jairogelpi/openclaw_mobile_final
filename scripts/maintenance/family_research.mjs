import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';

async function research() {
    console.log(`Researching for Gelpi and family info...`);

    // Search for "Gelpi"
    const { data: gelpiMemos } = await supabase
        .from('user_memories')
        .select('content')
        .eq('client_id', clientId)
        .ilike('content', '%Gelpi%')
        .limit(20);

    console.log('--- GELPI MENTIONS ---');
    gelpiMemos?.forEach(m => console.log(m.content));

    // Search for "Mireya" and "madre" together
    const { data: combined } = await supabase
        .from('user_memories')
        .select('content')
        .eq('client_id', clientId)
        .and('content.ilike.%Mireya%,content.ilike.%madre%')
        .limit(20);

    console.log('\n--- MIREYA + MADRE ---');
    combined?.forEach(m => console.log(m.content));

    process.exit(0);
}

research();
