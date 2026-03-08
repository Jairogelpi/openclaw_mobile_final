import supabase from '../config/supabase.mjs';
import { distillAndVectorize } from '../memory_worker.mjs';

const clientId = process.argv[2];

if (!clientId) {
    console.error('Usage: node scripts/process_pending_raw_messages.mjs <client_id>');
    process.exit(1);
}

async function pendingCount() {
    const { count, error } = await supabase
        .from('raw_messages')
        .select('*', { head: true, count: 'exact' })
        .eq('client_id', clientId)
        .eq('processed', false);

    if (error) throw error;
    return Number(count || 0);
}

async function main() {
    let pending = await pendingCount();
    console.log(`[Process Pending] start pending=${pending}`);

    while (pending > 0) {
        await distillAndVectorize(clientId);
        pending = await pendingCount();
        console.log(`[Process Pending] pending=${pending}`);
    }

    console.log(`[Process Pending] completed for ${clientId}`);
}

main().catch((error) => {
    console.error('[Process Pending] Error:', error.message);
    process.exit(1);
});
