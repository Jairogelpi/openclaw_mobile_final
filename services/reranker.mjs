import { generateEmbedding, cosineSimilarity } from './local_ai.mjs';
import { normalizeComparableText } from '../utils/message_guard.mjs';

const VECTOR_CACHE_TTL_MS = 30 * 60 * 1000;
const vectorCache = new Map();

function tokenize(text) {
    return [...new Set(
        normalizeComparableText(text)
            .split(/[^a-z0-9áéíóúñü]+/i)
            .map(token => token.trim())
            .filter(token => token.length > 2)
    )];
}

function lexicalOverlap(queryTokens, evidenceTokens) {
    if (!queryTokens.length || !evidenceTokens.length) return 0;
    const evidenceSet = new Set(evidenceTokens);
    const matches = queryTokens.filter(token => evidenceSet.has(token)).length;
    return matches / Math.max(queryTokens.length, 1);
}

function computeFreshnessBias(timestamp) {
    if (!timestamp) return 0;
    const ts = new Date(timestamp).getTime();
    if (!Number.isFinite(ts)) return 0;

    const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
    if (ageDays <= 1) return 1;
    if (ageDays <= 7) return 0.8;
    if (ageDays <= 30) return 0.5;
    if (ageDays <= 90) return 0.25;
    return 0.1;
}

function computeDirectnessBias(candidate) {
    if (candidate.directness === 'direct' && candidate.source_kind === 'memory_chunk') return 1;
    if (candidate.directness === 'direct' && candidate.source_kind === 'graph_edge') return 0.85;
    if (candidate.directness === 'direct') return 0.65;
    return 0.15;
}

function computeEntityBias(plan, candidate) {
    const entityNames = (plan.entities || []).map(entity => normalizeComparableText(entity));
    if (!entityNames.length) return 0;

    const speaker = normalizeComparableText(candidate.speaker);
    const evidence = normalizeComparableText(candidate.evidence_text);
    const matches = entityNames.filter(entity =>
        speaker === entity ||
        evidence.includes(entity)
    ).length;

    return Math.min(1, matches / entityNames.length);
}

function computeRelationBias(plan, candidate) {
    if (!plan.relation_filter) return 0;
    const relation = normalizeComparableText(candidate.relation_type || candidate.metadata?.relation_type || '');
    const expected = normalizeComparableText(plan.relation_filter);
    if (!relation || !expected) return 0;
    return relation.includes(expected) || expected.includes(relation) ? 1 : 0;
}

function computeTemporalBias(plan, candidate) {
    const start = plan.temporal_window?.start ? new Date(plan.temporal_window.start).getTime() : null;
    const end = plan.temporal_window?.end ? new Date(plan.temporal_window.end).getTime() : null;
    if (!start && !end) return 0;

    const ts = candidate.timestamp ? new Date(candidate.timestamp).getTime() : null;
    if (!Number.isFinite(ts)) return 0;

    if (start && ts < start) return 0;
    if (end && ts > end) return 0;
    return 1;
}

function normalizeRecallScore(candidate) {
    const recallScore = Number(candidate.recall_score ?? candidate.final_score ?? candidate.similarity ?? 0);
    return Number.isFinite(recallScore) ? Math.max(0, Math.min(1, recallScore)) : 0;
}

function sanitizeEvidenceText(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 720);
}

async function getCachedVector(text, isQuery = false) {
    const sanitized = sanitizeEvidenceText(text);
    if (!sanitized) return null;

    const cacheKey = `${isQuery ? 'q' : 'd'}:${normalizeComparableText(sanitized)}`;
    const cached = vectorCache.get(cacheKey);
    if (cached && (Date.now() - cached.createdAt) < VECTOR_CACHE_TTL_MS) {
        return cached.vector;
    }

    const vector = await generateEmbedding(sanitized, isQuery);
    vectorCache.set(cacheKey, {
        vector,
        createdAt: Date.now()
    });
    return vector;
}

export async function rerankEvidenceCandidates({
    queryText,
    queryVector = null,
    plan,
    candidates,
    maxCandidates = 24,
    semanticEnabled = true,
    semanticMaxCandidates = 8
}) {
    const queryTokens = tokenize(queryText);
    const recallRanked = (candidates || [])
        .slice()
        .sort((a, b) => normalizeRecallScore(b) - normalizeRecallScore(a))
        .slice(0, Math.max(maxCandidates * 2, 16));

    const semanticScores = new Map();
    if (semanticEnabled && recallRanked.length > 0) {
        try {
            const qVec = queryVector || await getCachedVector(queryText, true);
            const semanticPool = recallRanked
                .filter(candidate => candidate.source_kind !== 'fact')
                .slice(0, Math.max(1, semanticMaxCandidates));

            for (const candidate of semanticPool) {
                const evidenceText = sanitizeEvidenceText(candidate.evidence_text || candidate.content || candidate.metadata?.context || '');
                if (!qVec || !evidenceText) continue;
                const evidenceVec = await getCachedVector(evidenceText, false);
                if (!evidenceVec) continue;
                semanticScores.set(candidate.source_id, Math.max(0, cosineSimilarity(qVec, evidenceVec)));
            }
        } catch (error) {
            console.warn('[Reranker] Semantic rerank skipped:', error.message);
        }
    }

    const ranked = (candidates || []).map(candidate => {
        const evidenceTokens = tokenize(candidate.evidence_text || candidate.content || '');
        const overlap = lexicalOverlap(queryTokens, evidenceTokens);
        const freshnessBias = computeFreshnessBias(candidate.timestamp);
        const directnessBias = computeDirectnessBias(candidate);
        const entityBias = computeEntityBias(plan, candidate);
        const relationBias = computeRelationBias(plan, candidate);
        const temporalBias = computeTemporalBias(plan, candidate);
        const recallScore = normalizeRecallScore(candidate);
        const semanticSimilarity = Number(semanticScores.get(candidate.source_id) || 0);

        const rerankScore = Math.min(
            1,
            (semanticSimilarity * 0.55) +
            (overlap * 0.15) +
            (entityBias * 0.15) +
            (relationBias * 0.075) +
            (temporalBias * 0.075)
        );

        const finalScore = Math.min(
            1,
            (recallScore * 0.3) +
            (rerankScore * 0.4) +
            (semanticSimilarity * 0.1) +
            (freshnessBias * 0.05) +
            (directnessBias * 0.15)
        );

        return {
            ...candidate,
            score_rerank: Number(rerankScore.toFixed(4)),
            semantic_similarity: Number(semanticSimilarity.toFixed(4)),
            freshness_bias: Number(freshnessBias.toFixed(4)),
            directness_bias: Number(directnessBias.toFixed(4)),
            final_score: Number(finalScore.toFixed(4))
        };
    });

    ranked.sort((a, b) => {
        if (b.final_score !== a.final_score) return b.final_score - a.final_score;
        if (a.directness !== b.directness) return a.directness === 'direct' ? -1 : 1;
        const dateA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const dateB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return dateB - dateA;
    });

    return ranked.slice(0, maxCandidates);
}
