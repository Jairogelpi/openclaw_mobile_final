import supabase from '../config/supabase.mjs';

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';
const tables = [
    'knowledge_nodes',
    'knowledge_edges',
    'user_memories',
    'inbox_summaries',
    'communities'
];

async function cleanup() {
    console.log(`🚀 Starting full reset for client ${clientId}...`);

    // 1. Lock processing
    console.log(`🔒 Locking soul processing...`);
    await supabase.from('user_souls').update({ is_processing: true, worker_status: '🧹 Resetting Knowledge...' }).eq('client_id', clientId);

    // 2. Clear tables
    for (const table of tables) {
        console.log(`🗑️ Clearing table: ${table}...`);
        const { error } = await supabase.from(table).delete().eq('client_id', clientId);
        if (error) {
            console.error(`❌ Error clearing ${table}:`, error.message);
        } else {
            console.log(`✅ ${table} cleared.`);
        }
    }

    // 3. Reset raw_messages flags
    console.log(`🔄 Resetting raw_messages processed flag...`);
    const { error: msgErr } = await supabase.from('raw_messages').update({ processed: false }).eq('client_id', clientId);
    if (msgErr) {
        console.error(`❌ Error resetting raw_messages:`, msgErr.message);
    } else {
        console.log(`✅ raw_messages reset to processed=false.`);
    }

    // 4. Unlock
    console.log(`🔓 Unlocking soul processing...`);
    await supabase.from('user_souls').update({ is_processing: false, worker_status: '✨ Ready for Re-processing' }).eq('client_id', clientId);

    console.log(`🏁 Full reset completed for client ${clientId}.`);
    process.exit(0);
}

cleanup();
