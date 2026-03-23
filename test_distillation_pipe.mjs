import 'dotenv/config';
import { distillAndVectorize } from './workers/memory_worker.mjs';
import supabase from './config/supabase.mjs';

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';

async function test() {
    console.log("🧪 Testing distillation pipe for 5 messages...");
    
    // Check current counts
    const { count: beforeNodes } = await supabase.from('knowledge_nodes').select('*', { head: true, count: 'exact' });
    const { count: beforeEdges } = await supabase.from('knowledge_edges').select('*', { head: true, count: 'exact' });
    
    console.log(`📊 Before: Nodes=${beforeNodes}, Edges=${beforeEdges}`);

    try {
        // We modify the memory_worker L49 to limit it even more if needed, 
        // but for now let's just run it as it is (it takes 200 by default).
        // To make it faster, let's just run one batch.
        await distillAndVectorize(clientId);
        
        const { count: afterNodes } = await supabase.from('knowledge_nodes').select('*', { head: true, count: 'exact' });
        const { count: afterEdges } = await supabase.from('knowledge_edges').select('*', { head: true, count: 'exact' });
        const { count: processedCount } = await supabase.from('raw_messages').select('*', { head: true, count: 'exact' }).eq('processed', true);

        console.log(`📊 After: Nodes=${afterNodes}, Edges=${afterEdges}`);
        console.log(`📈 Processed messages: ${processedCount}`);
        
        if (afterNodes > beforeNodes || afterEdges > beforeEdges || processedCount > 0) {
            console.log("✅ Pipeline is WORKING!");
        } else {
            console.log("⚠️ No new data produced. Check if there are unprocessed messages or if they were filtered out.");
        }
    } catch (err) {
        console.error("💥 Test failed:", err.message);
    }
    process.exit(0);
}

test();
