#!/usr/bin/env node
/**
 * 🧠 BRAIN REFRESH 2026 — Non-blocking Re-Ingestion Script
 * 
 * Processes ALL historical raw_messages through the 2026 Semantic Quadruples engine.
 * SAFE: Uses rate limiting and yielding to ensure the backend remains fully operational
 * for new user onboarding and WhatsApp connections.
 * 
 * Usage: node brain_refresh_2026.mjs [--batch=50] [--delay=3000] [--dry-run]
 */
import 'dotenv/config';
import supabase from '../../config/supabase.mjs';
import { processConversationDepth } from './memory_worker.mjs';

const args = process.argv.slice(2);
const BATCH_SIZE = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] || '30');
const DELAY_MS = parseInt(args.find(a => a.startsWith('--delay='))?.split('=')[1] || '4000');
const DRY_RUN = args.includes('--dry-run');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log(`\n🧠 ═══════════════════════════════════════════════════`);
    console.log(`   BRAIN REFRESH 2026 — Semantic Quadruples Engine`);
    console.log(`   Batch: ${BATCH_SIZE} | Delay: ${DELAY_MS}ms | Dry Run: ${DRY_RUN}`);
    console.log(`═══════════════════════════════════════════════════\n`);

    // 1. Get all clients
    const { data: clients, error: clientErr } = await supabase
        .from('user_souls')
        .select('client_id, slug');

    if (clientErr || !clients?.length) {
        console.error('❌ No clients found:', clientErr?.message);
        process.exit(1);
    }

    console.log(`📊 Found ${clients.length} client(s) to process.\n`);

    for (const client of clients) {
        console.log(`\n🔄 Processing client: ${client.slug} (${client.client_id})`);

        // 2. Count total messages for this client
        const { count: totalMessages } = await supabase
            .from('raw_messages')
            .select('id', { count: 'exact', head: true })
            .eq('client_id', client.client_id);

        console.log(`   📦 Total messages: ${totalMessages || 0}`);
        if (!totalMessages) continue;

        // 3. Get all distinct conversations (remote_ids)
        const { data: conversations } = await supabase
            .from('raw_messages')
            .select('remote_id')
            .eq('client_id', client.client_id);

        const uniqueRemoteIds = [...new Set(conversations?.map(c => c.remote_id) || [])];
        console.log(`   💬 Unique conversations: ${uniqueRemoteIds.length}`);

        let processed = 0;
        let errors = 0;

        // 4. Process each conversation in small batches
        for (let i = 0; i < uniqueRemoteIds.length; i++) {
            const remoteId = uniqueRemoteIds[i];

            try {
                // Fetch messages for this conversation
                const { data: messages } = await supabase
                    .from('raw_messages')
                    .select('content, sender_role, created_at')
                    .eq('client_id', client.client_id)
                    .eq('remote_id', remoteId)
                    .order('created_at', { ascending: true })
                    .limit(100); // Cap per conversation

                if (!messages?.length) continue;

                const formattedMessages = messages.map(m => `${m.sender_role}: ${m.content}`);
                const lastSender = messages[messages.length - 1].sender_role;
                const lastText = messages[messages.length - 1].content;
                const chunkTimestamp = messages[0].created_at;

                if (DRY_RUN) {
                    console.log(`   📝 [DRY] Would process: ${remoteId} (${messages.length} msgs)`);
                } else {
                    console.log(`   🧠 [${i + 1}/${uniqueRemoteIds.length}] Processing: ${remoteId.substring(0, 20)}... (${messages.length} msgs)`);
                    await processConversationDepth(
                        client.client_id,
                        remoteId,
                        formattedMessages,
                        lastSender,
                        lastText,
                        chunkTimestamp
                    );
                }

                processed++;

                // Rate limiting: yield to event loop + delay to not overload Groq API
                if (processed % BATCH_SIZE === 0) {
                    console.log(`   ⏸️  Yielding... (${processed}/${uniqueRemoteIds.length} done, ${DELAY_MS}ms cooldown)`);
                    await sleep(DELAY_MS);
                } else {
                    // Small delay between individual conversations
                    await sleep(800);
                }

            } catch (e) {
                errors++;
                console.error(`   ❌ Error processing ${remoteId}: ${e.message}`);
                await sleep(2000); // Extra cooldown on error
            }
        }

        console.log(`\n   ✅ Client ${client.slug}: ${processed} conversations processed, ${errors} errors.`);
    }

    console.log(`\n🏁 ═══════════════════════════════════════════════════`);
    console.log(`   BRAIN REFRESH COMPLETE`);
    console.log(`═══════════════════════════════════════════════════\n`);
    process.exit(0);
}

main().catch(err => {
    console.error('💀 Fatal error:', err.message);
    process.exit(1);
});
