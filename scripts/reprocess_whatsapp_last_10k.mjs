import supabase from '../config/supabase.mjs';

async function reprocessLast10k() {
    console.log("🔄 Resetting status for last 10,000 WhatsApp messages (Batched)...");
    
    let allIds = [];
    let lastCreatedAt = new Date().toISOString();
    const batchSize = 1000;
    const targetCount = 10000;

    // 1. Fetch in loops to bypass default 1000 limit
    while (allIds.length < targetCount) {
        const { data: messages, error } = await supabase
            .from('raw_messages')
            .select('id, created_at')
            .eq('channel', 'whatsapp')
            .lt('created_at', lastCreatedAt)
            .order('created_at', { ascending: false })
            .limit(batchSize);

        if (error) {
            console.error("❌ Error fetching messages:", error.message);
            break;
        }

        if (!messages?.length) break;

        allIds.push(...messages.map(m => m.id));
        lastCreatedAt = messages[messages.length - 1].created_at;
        
        console.log(`- Fetched ${allIds.length} IDs so far...`);
        if (messages.length < batchSize) break;
    }

    if (!allIds.length) {
        console.error("❌ No messages found to reprocess.");
        return;
    }

    const idsToProcess = allIds.slice(0, targetCount);
    console.log(`🚀 Resetting 'processed' flag for ${idsToProcess.length} messages in chunks of 500...`);

    // 2. Update in chunks of 500 to avoid Bad Request (payload size)
    const chunkSize = 500;
    for (let i = 0; i < idsToProcess.length; i += chunkSize) {
        const chunk = idsToProcess.slice(i, i + chunkSize);
        const { error: updateError } = await supabase
            .from('raw_messages')
            .update({ processed: false })
            .in('id', chunk);

        if (updateError) {
            console.error(`❌ Chunk ${i / chunkSize + 1} failed:`, updateError.message);
        } else {
            console.log(`✅ Chunk ${i / chunkSize + 1} processed (${Math.min(i + chunkSize, idsToProcess.length)}/${idsToProcess.length})`);
        }
    }

    console.log("✨ Reprocessing triggered successfully.");
}

reprocessLast10k().catch(console.error);
