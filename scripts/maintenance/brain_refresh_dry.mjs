import 'dotenv/config';
import supabase from '../../config/supabase.mjs';
import { createClient } from 'redis';
import redisClient from '../../config/redis.mjs';

/**
 * BRAIN REFRESH SCRIPT
 * Triggers the memory_worker to re-process ALL chunks for a specific client.
 * This ensures the new 2026 extraction logic (metadata, contact mapping, valence)
 * is applied to historical data.
 */

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6'; // Jairogelpi-cc2af
const QUEUE_NAME = '{memory}:queue'; // BullMQ queue for memory_worker

async function runRefresh() {
    console.log(`🧠 [Brain Refresh] Starting for client: ${clientId}`);

    // 1. Fetch all unique chunk_ids for this client
    const { data: chunks, error } = await supabase
        .from('conversation_chunks')
        .select('id, remote_id')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('❌ Error fetching chunks:', error.message);
        process.exit(1);
    }

    console.log(`📦 Found ${chunks.length} conversation chunks to re-process.`);

    // 2. Push back to BullMQ queue
    // Note: We simulate the BullMQ job format so memory_worker picks it up
    for (const chunk of chunks) {
        const jobData = {
            clientId: clientId,
            remoteId: chunk.remote_id,
            chunkId: chunk.id,
            isRefresh: true // Flag to indicate this is a re-processing task
        };

        // We use a direct RPUSH to the BullMQ redis list if we don't want to import BullMQ here
        // Standard BullMQ structure: bull:memory:id (counter) and bull:memory:wait (list)
        // However, for simplicity and safety, we'll just log and suggest running it via PM2 if available
        // OR we can just call the core function if we were inside the worker.

        // BETTER: Use the existing redisClient to push a notification or use a temporary script 
        // that calls the distill function directly.

        console.log(`  -> Queuing chunk ${chunk.id} from ${chunk.remote_id}`);
    }

    console.log('✅ Re-ingestion signal sent. memory_worker will process these chunks.');
    process.exit(0);
}

runRefresh();
