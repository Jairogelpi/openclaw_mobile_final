import { distillAndVectorize } from '../workers/memory_worker.mjs';
import supabase from '../config/supabase.mjs';

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';

async function run() {
    console.log(`🚀 Starting massive re-processing for client ${clientId}...`);

    // Forzar el desbloqueo del cliente antes de arrancar
    console.log(`🔓 Forcing client unlock...`);
    await supabase.from('user_souls').update({ is_processing: false }).eq('client_id', clientId);

    let finished = false;
    let totalProcessed = 0;

    while (!finished) {
        // Check how many are left
        const { count, error: countErr } = await supabase
            .from('raw_messages')
            .select('*', { head: true, count: 'exact' })
            .eq('client_id', clientId)
            .eq('processed', false);

        if (countErr) {
            console.error('❌ Error checking counts:', countErr.message);
            break;
        }

        console.log(`📊 Total raw_messages remaining: ${count}`);

        if (count === 0) {
            finished = true;
            break;
        }

        console.log(`🧠 Triggering distillAndVectorize batch...`);
        const startTime = Date.now();
        await distillAndVectorize(clientId);
        const duration = (Date.now() - startTime) / 1000;

        console.log(`✅ Batch finished in ${duration.toFixed(2)}s.`);
    }

    console.log(`🏁 All messages processed for client ${clientId}.`);
    process.exit(0);
}

run();
