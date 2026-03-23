import supabase from './config/supabase.mjs';

async function checkRecency() {
    const ids = ['cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6', '0049d221-75c2-4b8b-b0df-0aed07184099'];
    
    for (const id of ids) {
        console.log(`\n--- Checking recency for clientId: ${id} ---`);
        const { data: mems } = await supabase.from('user_memories').select('created_at').eq('client_id', id).order('created_at', { ascending: false }).limit(1);
        const { data: raw } = await supabase.from('raw_messages').select('created_at').eq('client_id', id).order('created_at', { ascending: false }).limit(1);
        const { count: rawCount } = await supabase.from('raw_messages').select('*', { count: 'exact', head: true }).eq('client_id', id);

        console.log(`Latest memory: ${mems?.[0]?.created_at || 'None'}`);
        console.log(`Latest raw message: ${raw?.[0]?.created_at || 'None'}`);
        console.log(`Total raw messages: ${rawCount || 0}`);
    }
}

(async () => {
    await checkRecency();
})();
