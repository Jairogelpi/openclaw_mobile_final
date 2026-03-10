const IMMEDIATE_REBUILD_REASONS = new Set([
    'explicit_graph_cue',
    'third_party_reference',
    'deterministic_relationship_only'
]);

function uniqueSpeakers(speakers = []) {
    return [...new Set((speakers || []).filter(Boolean))];
}

export function shouldEmbedChunkImmediatelyForRebuild(mode, graphPrefilter = {}) {
    if (mode !== 'rebuild') return true;
    return IMMEDIATE_REBUILD_REASONS.has(String(graphPrefilter.reason || '').trim());
}

export function buildChunkMemoryMetadata({
    remoteId,
    contactName,
    graphPrefilterReason,
    chunkIndex,
    date,
    speakers = [],
    embeddingDeferred = false
} = {}) {
    return {
        remoteId: remoteId || null,
        contactName: contactName || null,
        holographic: true,
        conversation_consolidated: false,
        embedding_source: 'compact_hologram_v2',
        embedding_deferred: Boolean(embeddingDeferred),
        embedding_backfilled_at: null,
        graph_prefilter_reason: graphPrefilterReason || null,
        chunkIndex: Number.isFinite(chunkIndex) ? chunkIndex : null,
        date: date || null,
        speakers: uniqueSpeakers(speakers)
    };
}

export function buildConversationMemoryMetadata({
    remoteId,
    contactName,
    date,
    speakers = []
} = {}) {
    return {
        remoteId: remoteId || null,
        contactName: contactName || null,
        holographic: true,
        conversation_consolidated: true,
        embedding_source: 'compact_conversation_v1',
        embedding_deferred: false,
        embedding_backfilled_at: null,
        graph_prefilter_reason: 'conversation_consolidated',
        date: date || null,
        speakers: uniqueSpeakers(speakers)
    };
}

export function getDeferredEmbeddingPriority(metadata = {}, { prioritizeConsolidated = true } = {}) {
    if (prioritizeConsolidated && metadata.conversation_consolidated === true) return 0;
    if (metadata.graph_prefilter_reason === 'explicit_graph_cue') return 1;
    if (metadata.graph_prefilter_reason === 'third_party_reference') return 2;
    if (metadata.graph_prefilter_reason === 'deterministic_relationship_only') return 3;
    return 4;
}

export function shouldBackfillDeferredEmbeddingMetadata(metadata = {}) {
    return metadata.holographic === true && (
        metadata.embedding_deferred === true
        || metadata.embedding_source === 'compact_hologram_v2'
        || metadata.embedding_source === 'compact_conversation_v1'
    );
}

export function sortDeferredEmbeddingRows(rows = [], options = {}) {
    return [...rows].sort((left, right) => {
        const leftMeta = left?.metadata || {};
        const rightMeta = right?.metadata || {};
        const priorityDiff = getDeferredEmbeddingPriority(leftMeta, options) - getDeferredEmbeddingPriority(rightMeta, options);
        if (priorityDiff !== 0) return priorityDiff;

        const leftDate = new Date(left?.created_at || 0).getTime();
        const rightDate = new Date(right?.created_at || 0).getTime();
        return leftDate - rightDate;
    });
}
