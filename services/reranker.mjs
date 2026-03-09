import { normalizeComparableText } from '../utils/message_guard.mjs';

const VECTOR_CACHE_TTL_MS = 30 * 60 * 1000;
const vectorCache = new Map();
let localAiModulePromise = null;

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
    if (candidate.directness === 'direct' && candidate.source_kind === 'fact') return 0.8;
    if (candidate.directness === 'direct') return 0.65;
    return 0.15;
}

function computeStabilityBias(candidate) {
    const supportCount = Number(candidate.metadata?.support_count || 0);
    const stableScore = Number(candidate.metadata?.stable_score || 0);
    const tier = normalizeComparableText(candidate.metadata?.stability_tier || '');
    let score = 0;
    if (tier === 'stable') score += 1;
    else if (tier === 'provisional') score += 0.55;
    else if (tier === 'candidate') score += 0.1;
    score += Math.min(supportCount, 4) * 0.08;
    score += Math.min(stableScore, 12) / 20;
    return Math.min(1, score);
}

function computeContradictionPenalty(candidate) {
    const flags = [
        ...(Array.isArray(candidate.metadata?.cognitive_flags) ? candidate.metadata.cognitive_flags : []),
        ...(Array.isArray(candidate.metadata?.flags) ? candidate.metadata.flags : [])
    ].map(flag => normalizeComparableText(flag));
    return flags.includes('conflicted') ? 1 : 0;
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

function computeIntentBias(plan, candidate) {
    if (!plan?.intent) return 0;

    if (plan.intent === 'identity_lookup') {
        if (candidate.source_kind === 'fact' && ['contact_identity', 'owner_identity'].includes(candidate.metadata?.fact_type)) return 1;
        if (candidate.source_kind === 'memory_chunk') return 0.35;
    }

    if (plan.intent === 'relationship_lookup') {
        if (candidate.metadata?.fact_type === 'relationship_edge') return 1;
        if (candidate.source_kind === 'graph_edge') return 0.9;
        if (candidate.source_kind === 'memory_chunk') return 0.4;
    }

    if (plan.intent === 'temporal_lookup') {
        if (candidate.source_kind === 'memory_chunk') return 1;
        if (candidate.source_kind === 'fact') return 0.25;
    }

    if (plan.intent === 'media_lookup') {
        if (candidate.source_kind === 'memory_chunk' && candidate.metadata?.explicitMediaAnchor) return 1;
        if (candidate.source_kind === 'memory_chunk') return 0.65;
        if (candidate.source_kind === 'fact') return 0.2;
    }

    return 0;
}

function computeMediaSpecificityBias(plan, candidate) {
    if (plan?.intent !== 'media_lookup') return 0;
    const metadata = candidate.metadata || {};
    const hasSnippet = Boolean(String(metadata.mediaSnippet || '').trim());
    const hasAnchor = Boolean(metadata.explicitMediaAnchor);
    const caption = normalizeComparableText(metadata.caption || '');
    if (hasAnchor && hasSnippet) return 1;
    if (hasAnchor || caption) return 0.6;
    return 0;
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

function candidateDiversityKey(candidate) {
    const remoteId = normalizeComparableText(candidate.remote_id || candidate.metadata?.remoteId || candidate.metadata?.remote_id || '');
    const speaker = normalizeComparableText(candidate.speaker || '');
    const kind = normalizeComparableText(candidate.source_kind || '');
    return `${kind}:${remoteId || speaker || 'global'}`;
}

function diversifyRankedCandidates(ranked = [], maxCandidates = 24) {
    const results = [];
    const familyCounts = new Map();

    for (const candidate of ranked) {
        const family = candidateDiversityKey(candidate);
        const currentCount = familyCounts.get(family) || 0;
        const perFamilyCap = candidate.source_kind === 'memory_chunk' ? 2 : 1;
        if (currentCount >= perFamilyCap) continue;
        familyCounts.set(family, currentCount + 1);
        results.push(candidate);
        if (results.length >= maxCandidates) break;
    }

    for (const candidate of ranked) {
        if (results.length >= maxCandidates) break;
        if (results.some(item => item.source_id === candidate.source_id)) continue;
        results.push(candidate);
    }

    return results.slice(0, maxCandidates);
}

async function getCachedVector(text, isQuery = false) {
    const sanitized = sanitizeEvidenceText(text);
    if (!sanitized) return null;

    const cacheKey = `${isQuery ? 'q' : 'd'}:${normalizeComparableText(sanitized)}`;
    const cached = vectorCache.get(cacheKey);
    if (cached && (Date.now() - cached.createdAt) < VECTOR_CACHE_TTL_MS) {
        return cached.vector;
    }

    if (!localAiModulePromise) {
        localAiModulePromise = import('./local_ai.mjs');
    }
    const { generateEmbedding } = await localAiModulePromise;
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
            if (!localAiModulePromise) {
                localAiModulePromise = import('./local_ai.mjs');
            }
            const { cosineSimilarity } = await localAiModulePromise;
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
        const stabilityBias = computeStabilityBias(candidate);
        const contradictionPenalty = computeContradictionPenalty(candidate);
        const entityBias = computeEntityBias(plan, candidate);
        const relationBias = computeRelationBias(plan, candidate);
        const temporalBias = computeTemporalBias(plan, candidate);
        const intentBias = computeIntentBias(plan, candidate);
        const mediaSpecificityBias = computeMediaSpecificityBias(plan, candidate);
        const recallScore = normalizeRecallScore(candidate);
        const semanticSimilarity = Number(semanticScores.get(candidate.source_id) || 0);

        const rerankScore = Math.min(
            1,
            (semanticSimilarity * 0.38) +
            (overlap * 0.15) +
            (entityBias * 0.12) +
            (relationBias * 0.08) +
            (temporalBias * 0.08) +
            (intentBias * 0.1) +
            (mediaSpecificityBias * 0.07) +
            (stabilityBias * 0.1)
        );

        const finalScore = Math.min(
            1,
            (recallScore * 0.24) +
            (rerankScore * 0.34) +
            (semanticSimilarity * 0.08) +
            (freshnessBias * 0.05) +
            (directnessBias * 0.14) +
            (stabilityBias * 0.1) +
            (intentBias * 0.08) -
            (contradictionPenalty * 0.2)
        );

        return {
            ...candidate,
            score_rerank: Number(rerankScore.toFixed(4)),
            semantic_similarity: Number(semanticSimilarity.toFixed(4)),
            freshness_bias: Number(freshnessBias.toFixed(4)),
            directness_bias: Number(directnessBias.toFixed(4)),
            stability_bias: Number(stabilityBias.toFixed(4)),
            contradiction_penalty: Number(contradictionPenalty.toFixed(4)),
            intent_bias: Number(intentBias.toFixed(4)),
            media_specificity_bias: Number(mediaSpecificityBias.toFixed(4)),
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

    return diversifyRankedCandidates(ranked, maxCandidates);
}
