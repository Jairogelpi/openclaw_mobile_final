import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildChunkMemoryMetadata,
    buildConversationMemoryMetadata,
    shouldBackfillDeferredEmbeddingMetadata,
    shouldEmbedChunkImmediatelyForRebuild,
    sortDeferredEmbeddingRows
} from '../utils/rebuild_embedding_policy.mjs';

test('rebuild defers low-signal participant banter embeddings', () => {
    assert.equal(
        shouldEmbedChunkImmediatelyForRebuild('rebuild', { reason: 'participant_only_banter' }),
        false
    );
    assert.equal(
        shouldEmbedChunkImmediatelyForRebuild('rebuild', { reason: 'low_semantic_signal' }),
        false
    );
});

test('rebuild keeps immediate embedding for structural signal', () => {
    assert.equal(
        shouldEmbedChunkImmediatelyForRebuild('rebuild', { reason: 'explicit_graph_cue' }),
        true
    );
    assert.equal(
        shouldEmbedChunkImmediatelyForRebuild('rebuild', { reason: 'deterministic_relationship_only' }),
        true
    );
});

test('chunk metadata is standardized for deferred rebuild memories', () => {
    const metadata = buildChunkMemoryMetadata({
        remoteId: '34600000000@s.whatsapp.net',
        contactName: 'Naiara',
        graphPrefilterReason: 'participant_only_banter',
        chunkIndex: 2,
        date: '2026-03-10T10:00:00.000Z',
        speakers: ['Jairo', 'Naiara', 'Jairo'],
        embeddingDeferred: true
    });

    assert.equal(metadata.conversation_consolidated, false);
    assert.equal(metadata.embedding_source, 'compact_hologram_v2');
    assert.equal(metadata.embedding_deferred, true);
    assert.equal(metadata.embedding_backfilled_at, null);
    assert.equal(metadata.graph_prefilter_reason, 'participant_only_banter');
    assert.deepEqual(metadata.speakers, ['Jairo', 'Naiara']);
});

test('conversation metadata is standardized and immediately embeddable', () => {
    const metadata = buildConversationMemoryMetadata({
        remoteId: '34600000000@s.whatsapp.net',
        contactName: 'Naiara',
        date: '2026-03-10T10:00:00.000Z',
        speakers: ['Jairo', 'Naiara']
    });

    assert.equal(metadata.conversation_consolidated, true);
    assert.equal(metadata.embedding_source, 'compact_conversation_v1');
    assert.equal(metadata.embedding_deferred, false);
    assert.equal(metadata.embedding_backfilled_at, null);
    assert.equal(metadata.graph_prefilter_reason, 'conversation_consolidated');
});

test('backfill only accepts deferred holographic memories', () => {
    assert.equal(shouldBackfillDeferredEmbeddingMetadata({
        holographic: true,
        embedding_deferred: true,
        embedding_source: 'compact_hologram_v2'
    }), true);

    assert.equal(shouldBackfillDeferredEmbeddingMetadata({
        holographic: false,
        embedding_deferred: true
    }), false);
});

test('deferred backfill prioritizes consolidated then explicit graph cues', () => {
    const rows = [
        {
            id: 'late-generic',
            created_at: '2026-03-10T10:10:00.000Z',
            metadata: { holographic: true, embedding_deferred: true, graph_prefilter_reason: 'low_semantic_signal' }
        },
        {
            id: 'explicit',
            created_at: '2026-03-10T10:05:00.000Z',
            metadata: { holographic: true, embedding_deferred: true, graph_prefilter_reason: 'explicit_graph_cue' }
        },
        {
            id: 'consolidated',
            created_at: '2026-03-10T10:20:00.000Z',
            metadata: { holographic: true, embedding_deferred: true, conversation_consolidated: true, embedding_source: 'compact_conversation_v1' }
        },
        {
            id: 'relationship',
            created_at: '2026-03-10T10:07:00.000Z',
            metadata: { holographic: true, embedding_deferred: true, graph_prefilter_reason: 'deterministic_relationship_only' }
        }
    ];

    const sorted = sortDeferredEmbeddingRows(rows, { prioritizeConsolidated: true });
    assert.deepEqual(sorted.map(row => row.id), ['consolidated', 'explicit', 'relationship', 'late-generic']);
});
