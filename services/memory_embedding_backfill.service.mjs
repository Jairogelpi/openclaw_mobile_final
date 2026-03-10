import supabase from '../config/supabase.mjs';
import { generateEmbedding } from './local_ai.mjs';
import { buildCompactMemoryEmbeddingTextFromStoredMemory } from '../utils/memory_embedding_text.mjs';

export async function backfillDeferredMemoryEmbeddings(clientId, {
    batchSize = 100,
    maxRows = 1500
} = {}) {
    let processed = 0;
    let updated = 0;
    let hasMore = true;

    while (hasMore && processed < maxRows) {
        const { data: rows, error } = await supabase
            .from('user_memories')
            .select('id, content, metadata, created_at, embedding')
            .eq('client_id', clientId)
            .is('embedding', null)
            .order('created_at', { ascending: true })
            .limit(Math.min(batchSize, maxRows - processed));

        if (error) throw error;
        if (!rows?.length) break;

        for (const row of rows) {
            processed += 1;
            const metadata = row.metadata || {};
            const shouldBackfill =
                metadata.holographic === true
                && (
                    metadata.embedding_deferred === true
                    || metadata.embedding_source === 'compact_hologram_v2'
                );

            if (!shouldBackfill) continue;

            const embeddingText = buildCompactMemoryEmbeddingTextFromStoredMemory(row);
            if (!embeddingText) continue;

            const embedding = await generateEmbedding(embeddingText);
            const nextMetadata = {
                ...metadata,
                embedding_deferred: false,
                embedding_backfilled_at: new Date().toISOString()
            };

            const { error: updateError } = await supabase
                .from('user_memories')
                .update({
                    embedding,
                    metadata: nextMetadata
                })
                .eq('id', row.id);

            if (updateError) throw updateError;
            updated += 1;
        }

        hasMore = rows.length >= Math.min(batchSize, maxRows - (processed - rows.length));
    }

    return { processed, updated };
}
