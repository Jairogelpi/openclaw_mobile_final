import supabase from './config/supabase.mjs';
import { incomingQueue } from './config/queues.mjs';
import { normalizeUuid } from './services/raw_message_ingest.service.mjs';

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6'; 

async function reprocessBacklog() {
    console.log(`\n--- Reprocessing backlog for clientId: ${clientId} ---`);
    
    // 1. Fetch unprocessed messages
    const { data: messages, error } = await supabase
        .from('raw_messages')
        .select('*')
        .eq('client_id', clientId)
        .eq('processed', false)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('Error fetching messages:', error.message);
        return;
    }

    console.log(`Found ${messages?.length || 0} unprocessed messages.`);

    if (!messages || messages.length === 0) return;

    // 2. Enqueue in batches to be safe (though BullMQ handles it)
    let count = 0;
    for (const msg of messages) {
        try {
            await incomingQueue.add('process_message', {
                clientId: msg.client_id,
                clientSlug: 'jairo-wa', // Slug hardcoded for now or fetch it
                channel: msg.channel || 'whatsapp',
                senderId: msg.remote_id,
                text: msg.semantic_text || msg.content,
                metadata: {
                    reprocessed: true,
                    originalCreated: msg.created_at,
                    sourceMessageId: msg.source_message_id
                }
            });
            count++;
            if (count % 100 === 0) console.log(`Enqueued ${count}/${messages.length}...`);
        } catch (e) {
            console.error(`Failed to enqueue message ${msg.id}:`, e.message);
        }
    }

    console.log(`✅ Finished enqueuing ${count} messages.`);
}

(async () => {
    await reprocessBacklog();
    process.exit(0);
})();
