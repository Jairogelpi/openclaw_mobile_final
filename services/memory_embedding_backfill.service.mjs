import supabase from '../config/supabase.mjs';
import { generateEmbedding, trackDeferredEmbedding } from './local_ai.mjs';
import { buildCompactMemoryEmbeddingTextFromStoredMemory } from '../utils/memory_embedding_text.mjs';
import { shouldBackfillDeferredEmbeddingMetadata, sortDeferredEmbeddingRows } from '../utils/rebuild_embedding_policy.mjs';

export function shouldBackfillDeferredMemory(row = {}) {
    return shouldBackfillDeferredEmbeddingMetadata(row.metadata || {});
}

export function prioritizeDeferredEmbeddingRows(rows = [], options = {}) {
    return sortDeferredEmbeddingRows(
        rows.filter(shouldBackfillDeferredMemory),
        options
    );
}

export async function backfillDeferredMemoryEmbeddings(clientId, {
    batchSize = 100,
    maxRows = 1500,
    prioritizeConsolidated = true
} = {}) {
    let processed = 0;
    let updated = 0;
    let hasMore = true;

    while (hasMore && processed < maxRows) {
        const fetchLimit = Math.min(Math.max(batchSize * 3, batchSize), maxRows - processed);
        const { data: rows, error } = await supabase
            .from('user_memories')
            .select('id, content, metadata, created_at, embedding')
            .eq('client_id', clientId)
            .is('embedding', null)
            .order('created_at', { ascending: true })
            .limit(fetchLimit);

        if (error) throw error;
        if (!rows?.length) break;

        const prioritizedRows = prioritizeDeferredEmbeddingRows(rows, { prioritizeConsolidated })
            .slice(0, Math.min(batchSize, maxRows - processed));

        if (!prioritizedRows.length) break;

        for (const row of prioritizedRows) {
            processed += 1;
            const metadata = row.metadata || {};
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
            trackDeferredEmbedding(-1);
        }

        hasMore = rows.length >= fetchLimit;
    }

    return { processed, updated };
}
