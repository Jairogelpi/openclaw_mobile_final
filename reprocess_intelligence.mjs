import 'dotenv/config';
import supabase from './config/supabase.mjs';
import { distillAndVectorize } from './workers/memory_worker.mjs';

/**
 * OpenClaw REPROCESSOR (v2026)
 * Resets processing flags and re-runs the intelligence pipeline with upgraded models.
 */

async function reprocessIntelligence() {
    console.log('🔄 [REPROCESSOR] Starting Neural Overhaul...');

    const { data: clients } = await supabase.from('user_souls').select('client_id, slug');
    if (!clients?.length) {
        console.error('No clients found to reprocess.');
        return;
    }

    for (const client of clients) {
        console.log(`\n💎 Processing Client: ${client.slug} (${client.client_id})`);

        // 1. Optional Cleanup: If we want a clean slate, uncomment these
        // console.log('🗑️ Cleaning old memories...');
        // await supabase.from('user_memories').delete().eq('client_id', client.client_id);
        // await supabase.from('knowledge_nodes').delete().eq('client_id', client.client_id);
        // await supabase.from('knowledge_edges').delete().eq('client_id', client.client_id);

        // 2. Reset process flag on all raw messages
        console.log('🔄 Resetting raw_messages processed flag...');
        const { error: resetError } = await supabase
            .from('raw_messages')
            .update({ processed: false })
            .eq('client_id', client.client_id);

        if (resetError) {
            console.error(`Error resetting messages: ${resetError.message}`);
            continue;
        }

        // 3. Trigger heavy-duty processing
        let pending = true;
        let batchCount = 0;
        while (pending) {
            batchCount++;
            console.log(`🧠 [BrainReprocess] Batch #${batchCount}...`);
            await distillAndVectorize(client.client_id);
            
            // Check if there are still unprocessed messages
            const { count } = await supabase
                .from('raw_messages')
                .select('*', { count: 'exact', head: true })
                .eq('client_id', client.client_id)
                .eq('processed', false);
            
            pending = count > 0;
            console.log(`📊 Pending messages: ${count}`);
        }
        
        console.log(`✅ [REPROCESSOR] Client ${client.slug} fully re-calibrated.`);
    }

    console.log('\n✨ [REPROCESSOR] All clients re-calibrated with Deep Relational Intelligence.');
}

reprocessIntelligence().catch(error => {
    console.error('💥 Reprocessor failed:', error.message);
});
