import supabase from '../config/supabase.mjs';
import { generateEmbedding } from './local_ai.mjs';
import redisClient from '../config/redis.mjs';
import { resolveIdentityCandidates } from './identity.service.mjs';
import {
    deriveEffectiveEntityType,
    expandDetectedNamesConservatively,
    normalizeEntityName,
    sanitizeEntityType,
    sanitizeRelationType
} from '../utils/knowledge_guard.mjs';
import { isPhoneLikeGraphName } from '../utils/graph_admissibility_policy.mjs';
import { normalizeComparableText } from '../utils/message_guard.mjs';
import {
    computeEdgeStability,
    computeNodeStability,
    isStableTier
} from '../utils/stable_graph_policy.mjs';

const EXCLUSIVE_RELATION_TYPES = new Set([
    '[PAREJA_DE]',
    '[VIVE_EN]',
    '[TRABAJA_EN]',
    '[ESTUDIA_EN]'
]);

const SYMMETRIC_RELATION_TYPES = new Set([
    '[AMISTAD]',
    '[PAREJA_DE]',
    '[CONOCE_A]',
    '[FAMILIA_DE]',
    '[RELACIONADO_CON]',
    '[EVENTO_CON]'
]);

const GENERIC_ALIAS_STOPWORDS = new Set([
    'el',
    'ella',
    'ellos',
    'ellas',
    'lo',
    'la',
    'alguien',
    'persona',
    'contacto',
    'amigo',
    'amiga'
]);

function canonicalizeEdgeDirection(sourceName, targetName, relationType) {
    const sourceNode = String(sourceName || '').trim();
    const targetNode = String(targetName || '').trim();
    const canonicalRelationType = String(relationType || '').trim();

    if (!SYMMETRIC_RELATION_TYPES.has(canonicalRelationType)) {
        return { sourceNode, targetNode };
    }

    const sourceKey = normalizeComparableText(sourceNode);
    const targetKey = normalizeComparableText(targetNode);
    if (!sourceKey || !targetKey || sourceKey <= targetKey) {
        return { sourceNode, targetNode };
    }

    return {
        sourceNode: targetNode,
        targetNode: sourceNode
    };
}

function buildCitationLabel(prefix, id) {
    return `${prefix}${String(id || '').slice(0, 8)}`;
}

function toMemoryEvidenceCandidate(row, overrides = {}) {
    const metadata = row.metadata || {};
    const sourceId = row.id || overrides.source_id || cryptoRandomId();
    return {
        source_id: sourceId,
        source_kind: 'memory_chunk',
        directness: 'direct',
        evidence_text: row.content || '',
        speaker: row.sender || metadata.contactName || null,
        remote_id: row.remote_id || metadata.remoteId || null,
        timestamp: row.event_timestamp || row.timestamp || row.date || row.created_at || metadata.date || null,
        metadata,
        score_vector: Number(row.score_vector ?? row.similarity ?? 0),
        score_fts: Number(row.score_fts ?? 0),
        recall_score: Number(row.recall_score ?? row.similarity ?? 0),
        score_rerank: 0,
        final_score: Number(row.recall_score ?? row.similarity ?? 0),
        citation_label: overrides.citation_label || buildCitationLabel('M', sourceId),
        source: overrides.source || row.source || 'HYBRID_V2'
    };
}

function toGraphEvidenceCandidate(row, overrides = {}) {
    const sourceId = `${row.source_node || row.entity_name}:${row.relation_type || row.hop || 'node'}:${row.target_node || ''}`;
    const hop = Number(row.hop || 0);
    const directness = hop <= 1 ? 'direct' : 'derived';
    const sourceKind = hop === 0 ? 'graph_node' : 'graph_edge';

    return {
        source_id: sourceId,
        source_kind: sourceKind,
        directness,
        evidence_text: row.knowledge || row.context || '',
        speaker: row.entity_name || row.source_node || null,
        remote_id: overrides.remote_id || null,
        timestamp: row.last_seen || null,
        metadata: {
            relation_type: row.relation_type || null,
            hop,
            entity_name: row.entity_name || null,
            entity_type: row.entity_type || null,
            context: row.context || null,
            source_node: row.source_node || null,
            target_node: row.target_node || null
        },
        relation_type: row.relation_type || null,
        hop,
        score_vector: Number(row.score_vector ?? row.cognitive_resonance ?? 0),
        score_fts: Number(row.score_fts ?? 0),
        recall_score: Number(row.recall_score ?? row.cognitive_resonance ?? 0),
        score_rerank: 0,
        final_score: Number(row.recall_score ?? row.cognitive_resonance ?? 0),
        citation_label: overrides.citation_label || buildCitationLabel('G', sourceId),
        source: overrides.source || 'GRAPH_V2'
    };
}

function toFactEvidenceCandidate(payload, overrides = {}) {
    const metadata = payload.metadata || {};
    const sourceId = payload.source_id || `${payload.fact_type || 'fact'}:${payload.entity_name || payload.remote_id || cryptoRandomId()}`;
    const evidenceText = String(payload.evidence_text || '').trim();
    if (!evidenceText) return null;

    return {
        source_id: sourceId,
        source_kind: 'fact',
        directness: 'direct',
        evidence_text: evidenceText,
        speaker: payload.speaker || payload.entity_name || null,
        remote_id: payload.remote_id || null,
        timestamp: payload.timestamp || null,
        metadata: {
            ...metadata,
            fact_type: payload.fact_type || metadata.fact_type || null,
            entity_name: payload.entity_name || metadata.entity_name || null,
            relation_type: payload.relation_type || metadata.relation_type || null,
            source_node: payload.source_node || metadata.source_node || null,
            target_node: payload.target_node || metadata.target_node || null
        },
        relation_type: payload.relation_type || metadata.relation_type || null,
        hop: 0,
        score_vector: Number(payload.score_vector ?? 0.95),
        score_fts: Number(payload.score_fts ?? 1),
        recall_score: Number(payload.recall_score ?? 0.98),
        score_rerank: 0,
        final_score: Number(payload.final_score ?? payload.recall_score ?? 0.98),
        citation_label: overrides.citation_label || buildCitationLabel('F', sourceId),
        source: overrides.source || payload.source || 'FACT_V1'
    };
}

function cryptoRandomId() {
    return `tmp_${Math.random().toString(36).slice(2, 10)}`;
}

function mergeSourceTags(...sets) {
    const merged = new Set();
    for (const sourceSet of sets) {
        const values = Array.isArray(sourceSet) ? sourceSet : [sourceSet];
        for (const value of values) {
            const tag = String(value || '').trim();
            if (!tag) continue;
            merged.add(tag);
        }
    }
    return [...merged];
}

function nowIso() {
    return new Date().toISOString();
}

async function upsertEntityMentionAggregate(clientId, entityName, entityType, description, options = {}) {
    try {
        const { data: exactMention, error: selectError } = await supabase
            .from('entity_mentions')
            .select('id, support_count, stable_score, stability_tier, description, source_tags, metadata')
            .eq('client_id', clientId)
            .eq('entity_name', entityName)
            .maybeSingle();

        if (selectError) throw selectError;

        const nextSupportCount = Number(exactMention?.support_count || 0) + 1;
        const nextSourceTags = mergeSourceTags(exactMention?.source_tags || [], options.source || '');
        const finalDescription = String(description || '').trim() || String(exactMention?.description || '').trim();
        const metadata = {
            ...(exactMention?.metadata || {}),
            ...(options.metadata || {}),
            mention_kind: 'entity',
            latest_source: options.source || exactMention?.metadata?.latest_source || null
        };
        if (options.remoteId) metadata.remote_id = options.remoteId;

        const stability = computeNodeStability({
            entityName,
            entityType,
            description: finalDescription,
            supportCount: nextSupportCount,
            source: options.source || '',
            sourceTags: nextSourceTags,
            existingScore: exactMention?.stable_score || 0,
            existingTier: exactMention?.stability_tier || 'candidate'
        });

        const payload = {
            client_id: clientId,
            entity_name: entityName,
            entity_type: entityType,
            description: finalDescription || null,
            remote_id: options.remoteId || exactMention?.metadata?.remote_id || null,
            support_count: nextSupportCount,
            stable_score: stability.score,
            stability_tier: stability.tier,
            source_tags: nextSourceTags,
            metadata,
            last_seen: nowIso(),
            updated_at: nowIso()
        };

        if (!exactMention?.id) {
            payload.first_seen = nowIso();
        }

        const { data: savedMention, error: upsertError } = await supabase
            .from('entity_mentions')
            .upsert(payload, { onConflict: 'client_id, entity_name' })
            .select('id, support_count, stable_score, stability_tier, source_tags, description')
            .single();

        if (upsertError) throw upsertError;

        return {
            mentionId: savedMention.id,
            supportCount: Number(savedMention.support_count || nextSupportCount),
            sourceTags: savedMention.source_tags || nextSourceTags,
            description: String(savedMention.description || finalDescription || '').trim(),
            stability: {
                score: Number(savedMention.stable_score || stability.score),
                tier: String(savedMention.stability_tier || stability.tier),
                promote: isStableTier(savedMention.stability_tier || stability.tier)
            }
        };
    } catch (error) {
        console.warn('[Graph Service] entity mention staging unavailable:', error.message);
        return null;
    }
}

async function upsertRelationMentionAggregate(clientId, sourceNode, targetNode, relationType, weight, context, flags = [], options = {}) {
    try {
        const { data: exactMention, error: selectError } = await supabase
            .from('relation_mentions')
            .select('id, support_count, stable_score, stability_tier, context, cognitive_flags, source_tags, metadata')
            .eq('client_id', clientId)
            .eq('source_node', sourceNode)
            .eq('relation_type', relationType)
            .eq('target_node', targetNode)
            .maybeSingle();

        if (selectError) throw selectError;

        const nextSupportCount = Number(exactMention?.support_count || 0) + 1;
        const nextSourceTags = mergeSourceTags(exactMention?.source_tags || [], options.source || '');
        const mergedFlags = [
            ...new Set([
                ...(Array.isArray(exactMention?.cognitive_flags) ? exactMention.cognitive_flags : []),
                ...(Array.isArray(flags) ? flags : [flags]).filter(Boolean)
            ])
        ];
        const finalContext = String(context || '').trim().slice(0, 500) || String(exactMention?.context || '').trim() || null;
        const metadata = {
            ...(exactMention?.metadata || {}),
            ...(options.metadata || {}),
            mention_kind: 'relation',
            latest_source: options.source || exactMention?.metadata?.latest_source || null
        };
        const stability = computeEdgeStability({
            relationType,
            context: finalContext,
            weight,
            supportCount: nextSupportCount,
            source: options.source || '',
            sourceTags: nextSourceTags,
            flags: mergedFlags,
            existingScore: exactMention?.stable_score || 0,
            existingTier: exactMention?.stability_tier || 'candidate'
        });

        const payload = {
            client_id: clientId,
            source_node: sourceNode,
            relation_type: relationType,
            target_node: targetNode,
            context: finalContext,
            support_count: nextSupportCount,
            stable_score: stability.score,
            stability_tier: stability.tier,
            cognitive_flags: mergedFlags,
            source_tags: nextSourceTags,
            metadata,
            last_seen: nowIso(),
            updated_at: nowIso()
        };

        if (!exactMention?.id) {
            payload.first_seen = nowIso();
        }

        const { data: savedMention, error: upsertError } = await supabase
            .from('relation_mentions')
            .upsert(payload, { onConflict: 'client_id, source_node, relation_type, target_node' })
            .select('id, support_count, stable_score, stability_tier, source_tags, context, cognitive_flags, metadata')
            .single();

        if (upsertError) throw upsertError;

        return {
            mentionId: savedMention.id,
            supportCount: Number(savedMention.support_count || nextSupportCount),
            sourceTags: savedMention.source_tags || nextSourceTags,
            context: String(savedMention.context || finalContext || '').trim() || null,
            cognitiveFlags: savedMention.cognitive_flags || mergedFlags,
            stability: {
                score: Number(savedMention.stable_score || stability.score),
                tier: String(savedMention.stability_tier || stability.tier),
                promote: isStableTier(savedMention.stability_tier || stability.tier)
            }
        };
    } catch (error) {
        console.warn('[Graph Service] relation mention staging unavailable:', error.message);
        return null;
    }
}

async function markEntityMentionPromoted(mentionId, nodeId) {
    if (!mentionId || !nodeId) return;
    await supabase
        .from('entity_mentions')
        .update({
            promoted_to_graph: true,
            promoted_node_id: nodeId,
            updated_at: nowIso()
        })
        .eq('id', mentionId);
}

async function markRelationMentionPromoted(mentionId) {
    if (!mentionId) return;
    await supabase
        .from('relation_mentions')
        .update({
            promoted_to_graph: true,
            updated_at: nowIso()
        })
        .eq('id', mentionId);
}

function hasConflictFlag(flags = []) {
    return (Array.isArray(flags) ? flags : [flags])
        .map(flag => normalizeComparableText(flag))
        .includes('conflicted');
}

async function hasConflictingExclusiveEdge(clientId, sourceNode, relationType, targetNode) {
    if (!EXCLUSIVE_RELATION_TYPES.has(String(relationType || '').trim())) return false;

    const { data, error } = await supabase
        .from('knowledge_edges')
        .select('target_node')
        .eq('client_id', clientId)
        .eq('source_node', sourceNode)
        .eq('relation_type', relationType)
        .neq('target_node', targetNode)
        .in('stability_tier', ['provisional', 'stable'])
        .limit(1);

    if (error) {
        console.warn('[Graph Service] exclusive edge conflict check skipped:', error.message);
        return false;
    }

    return Boolean((data || []).length);
}

function addAliasToMap(aliasMap, value) {
    const alias = String(value || '').trim();
    if (!alias || alias.length < 2) return;
    const normalized = normalizeComparableText(alias);
    if (!normalized) return;
    if (GENERIC_ALIAS_STOPWORDS.has(normalized)) return;
    if (!aliasMap.has(normalized)) {
        aliasMap.set(normalized, alias);
    }
}

function getEventTimestamp(row) {
    return row?.metadata?.dateStart || row?.metadata?.date || row?.timestamp || row?.created_at || null;
}

function isWeakMediaLine(line = '') {
    const normalized = normalizeComparableText(line);
    if (!normalized) return true;
    if (normalized.length < 10) return true;
    return [
        'audio',
        'el audio',
        'al audio',
        'esto era al audio',
        'esto era el audio',
        'mira el audio',
        'escucha el audio',
        'nota de voz',
        'el video',
        'la foto'
    ].includes(normalized);
}

function scoreMediaLine(line = '', normalizedTerms = []) {
    const normalized = normalizeComparableText(line);
    if (!normalized) return -10;

    const matchedTerms = normalizedTerms.filter(term => normalized.includes(term));
    let score = matchedTerms.length * 5;

    if (/\b(audio de|nota de voz|envie|envié|mande|mandé|paso|pasé|escuchaste|escucha|grab|video de|foto de|imagen de|pdf|documento|archivo)\b/i.test(normalized)) {
        score += 4;
    }
    if (line.includes(':')) score += 2;
    if (normalized.length >= 24) score += 2;
    if (normalized.length >= 50) score += 1;
    if (isWeakMediaLine(line)) score -= 5;

    return score;
}

function extractSpeakerLabel(line = '') {
    const match = String(line || '').match(/^([^:]{2,32}):/);
    if (!match) return null;
    const label = String(match[1] || '').trim();
    const normalized = normalizeComparableText(label);
    if (!normalized) return null;
    if (normalized.split(' ').length > 4) return null;
    return label;
}

function hasExplicitMediaAnchor(row = {}) {
    const metadata = row.metadata || {};
    return Boolean(
        metadata.mediaType ||
        metadata.attachmentType ||
        metadata.attachmentMime ||
        metadata.caption ||
        /\[(media|image|audio|video|document|documento|pdf)\]/i.test(String(row.content || ''))
    );
}

function extractMediaSnippetFromContent(content = '', matchedTerms = [], speaker = null) {
    const normalizedTerms = [...new Set((matchedTerms || []).map(term => normalizeComparableText(term)).filter(Boolean))];
    const lines = String(content || '')
        .split('\n')
        .map(line => line.replace(/\[[^\]]+\]/g, '').trim())
        .filter(Boolean);

    const scoredLines = lines
        .map((line, index) => ({
            line,
            index,
            score: scoreMediaLine(line, normalizedTerms)
        }))
        .filter(item => item.score > -10)
        .sort((a, b) => b.score - a.score || a.index - b.index);

    const lead = scoredLines[0] || null;
    const chosenIndexes = new Set();
    if (lead) chosenIndexes.add(lead.index);

    if (lead && (isWeakMediaLine(lead.line) || lead.line.length < 36)) {
        const neighbor = scoredLines.find(item =>
            Math.abs(item.index - lead.index) === 1 &&
            item.score >= Math.max(1, lead.score - 2)
        );
        if (neighbor) chosenIndexes.add(neighbor.index);
    }

    if (lead && chosenIndexes.size === 1) {
        const adjacent = [lead.index - 1, lead.index + 1]
            .filter(index => index >= 0 && index < lines.length)
            .map(index => ({ index, score: scoreMediaLine(lines[index], normalizedTerms) }))
            .sort((a, b) => b.score - a.score)[0];
        if (adjacent && adjacent.score >= 2) chosenIndexes.add(adjacent.index);
    }

    const snippetLines = [...chosenIndexes]
        .sort((a, b) => a - b)
        .map(index => lines[index])
        .filter(Boolean);

    if (!snippetLines.length) {
        snippetLines.push(...lines.slice(0, 2));
    }

    let snippet = snippetLines.join(' ');
    if (speaker) {
        const speakerName = String(speaker || '').trim();
        const firstToken = speakerName.split(/\s+/)[0];
        const speakerPattern = new RegExp(`^${firstToken}\\s*:`, 'i');
        if (speakerPattern.test(snippet) && !new RegExp(`^${speakerName}\\s*:`, 'i').test(snippet)) {
            snippet = snippet.replace(speakerPattern, `${speakerName}:`);
        }
    }

    return {
        snippet: snippet.trim().slice(0, 220),
        participants: [...new Set(snippetLines.map(extractSpeakerLabel).filter(Boolean))].slice(0, 2)
    };
}

function extractRequestedMediaTerms(queryText = '') {
    const normalized = normalizeComparableText(queryText);
    const terms = [];
    if (normalized.includes('audio') || normalized.includes('nota de voz') || normalized.includes('voz')) {
        terms.push('audio', 'nota de voz', 'voz', 'voice');
    }
    if (normalized.includes('foto') || normalized.includes('imagen')) {
        terms.push('foto', 'imagen', 'image');
    }
    if (normalized.includes('video')) {
        terms.push('video', 'clip');
    }
    if (normalized.includes('documento') || normalized.includes('pdf') || normalized.includes('archivo')) {
        terms.push('documento', 'pdf', 'archivo');
    }
    return [...new Set(terms)];
}

function isMeaningfulAlias(alias) {
    const value = String(alias || '').trim();
    if (!value) return false;
    const normalized = normalizeComparableText(value);
    if (!normalized || normalized.length < 2) return false;
    if (['assistant', 'user', 'user sent', 'system_test', 'terminal-admin', 'contacto', 'usuario'].includes(normalized)) return false;
    if (GENERIC_ALIAS_STOPWORDS.has(normalized)) return false;
    if (/^\d{6,}$/.test(normalized)) return false;
    if (normalized.includes('@')) return false;
    return true;
}

function isWeakExactEntityMentionDescription(entityName = '', description = '') {
    const normalizedEntity = normalizeComparableText(entityName);
    const normalized = normalizeComparableText(description);
    if (!normalized) return true;
    if (normalized === normalizedEntity) return true;
    if (normalized.length < 14) return true;
    if (normalized.includes('participante del chat')) return true;
    if (normalized.includes('contacto mencionado')) return true;
    if (normalized.includes('persona mencionada') && normalized.length < 32) return true;
    if (/^(quien es|quien era|como se relaciona|que hace en mi vida|de que hablo con|que recuerdas de)\b/.test(normalized)) return true;
    if (normalizedEntity && normalized.includes(`quien es ${normalizedEntity}`)) return true;
    return false;
}

function shouldIncludeExactEntityMention(mention = {}, directIdentityNames = new Set()) {
    const entityName = String(mention.entity_name || '').trim();
    const description = String(mention.description || '').trim();
    const normalizedName = normalizeComparableText(entityName);
    const hasDirectIdentityMatch = normalizedName && directIdentityNames.has(normalizedName);

    if (!hasDirectIdentityMatch) {
        return !isWeakExactEntityMentionDescription(entityName, description);
    }

    if (isWeakExactEntityMentionDescription(entityName, description)) {
        return false;
    }

    return Number(mention.support_count || 0) >= 2 || Number(mention.stable_score || 0) >= 0.7;
}

const RELATION_MEMORY_CUES = new Map([
    ['FAMILIA_DE', ['madre', 'padre', 'hermano', 'hermana', 'hijo', 'hija', 'familia', 'primo', 'prima']],
    ['PAREJA_DE', ['pareja', 'novia', 'novio', 'amor', 'mi vida', 'te amo', 'cariño', 'carino']],
    ['AMISTAD', ['amigo', 'amiga', 'colega', 'bro']],
    ['TRABAJA_EN', ['trabaja', 'curro', 'empleo', 'empresa', 'oficina', 'jefe', 'jefa']],
    ['VIVE_EN', ['vive', 'casa', 'piso', 'mudado', 'mudarse']],
    ['ESTUDIA_EN', ['estudia', 'universidad', 'instituto', 'master', 'máster', 'curso']],
    ['CONOCE_A', ['conoce', 'quede con', 'quedé con', 'he hablado con', 'hablé con']]
]);

function normalizeRelationFilterKey(value) {
    const normalized = normalizeComparableText(String(value || '').replace(/[\[\]]/g, ''));
    if (!normalized) return null;
    if (normalized === 'any_relation') return 'ANY_RELATION';
    return normalized.toUpperCase();
}

function buildRelationCueMap(relationFilter = null) {
    const requested = normalizeRelationFilterKey(relationFilter);
    if (requested && requested !== 'ANY_RELATION' && RELATION_MEMORY_CUES.has(requested)) {
        return new Map([[requested, RELATION_MEMORY_CUES.get(requested)]]);
    }
    return RELATION_MEMORY_CUES;
}

function textContainsAlias(text = '', aliases = []) {
    const haystack = normalizeComparableText(text);
    if (!haystack) return false;
    return aliases.some(alias => {
        const needle = normalizeComparableText(alias);
        return Boolean(needle) && haystack.includes(needle);
    });
}

function inferRelationTypeFromText(text = '', relationFilter = null) {
    const haystack = normalizeComparableText(text);
    if (!haystack) return null;

    for (const [relationType, cues] of buildRelationCueMap(relationFilter).entries()) {
        if (cues.some(cue => haystack.includes(normalizeComparableText(cue)))) {
            return `[${relationType}]`;
        }
    }

    return null;
}

function extractRelationshipSnippet(content = '', aliases = []) {
    const lines = String(content || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    if (!lines.length) return '';

    const scored = lines
        .map((line, index) => {
            const normalized = normalizeComparableText(line);
            let score = inferRelationTypeFromText(line, 'ANY_RELATION') ? 4 : 0;
            for (const alias of aliases) {
                const needle = normalizeComparableText(alias);
                if (needle && normalized.includes(needle)) score += 2;
            }
            if (line.includes(':')) score += 1;
            return { line, index, score };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index);

    const best = scored[0];
    const neighbor = scored.find(item => Math.abs(item.index - best.index) === 1 && item.score >= Math.max(1, best.score - 2));
    return [best.line, neighbor?.line].filter(Boolean).join(' ').trim().slice(0, 240);
}

function buildRelationshipAliasMap(lookup, canonicalEntities = []) {
    const aliasMap = new Map();

    for (const entity of canonicalEntities) {
        const normalizedEntity = normalizeComparableText(entity);
        const aliases = new Set([entity]);

        for (const row of (lookup.identityMatches || [])) {
            const rowAliases = [row.canonical_name, ...(row.aliases || [])]
                .map(value => String(value || '').trim())
                .filter(isMeaningfulAlias);
            const matchesEntity =
                normalizeComparableText(row.canonical_name) === normalizedEntity ||
                rowAliases.some(alias => normalizeComparableText(alias) === normalizedEntity);
            if (!matchesEntity) continue;
            for (const alias of rowAliases) aliases.add(alias);
        }

        aliasMap.set(entity, [...aliases]);
    }

    return aliasMap;
}

async function exactRelationshipMemorySearch(clientId, lookup, canonicalEntities = [], relationFilter = null, matchCount = 8) {
    if (canonicalEntities.length < 2) return [];

    const aliasMap = buildRelationshipAliasMap(lookup, canonicalEntities);
    const remoteIdSet = new Set(lookup.remoteIdList);
    const pairs = [];
    for (let i = 0; i < canonicalEntities.length; i += 1) {
        for (let j = i + 1; j < canonicalEntities.length; j += 1) {
            pairs.push([canonicalEntities[i], canonicalEntities[j]]);
        }
    }

    const { data: rows, error } = await supabase
        .from('user_memories')
        .select('id, content, sender, metadata, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(Math.max(300, matchCount * 60));

    if (error) throw error;

    const results = [];
    const seen = new Set();

    for (const row of (rows || [])) {
        const content = String(row.content || '');
        const sender = String(row.sender || '').trim();
        const remoteId = row.metadata?.remoteId || row.metadata?.remote_id || null;
        const senderNormalized = normalizeComparableText(sender);

        for (const [left, right] of pairs) {
            const leftAliases = aliasMap.get(left) || [left];
            const rightAliases = aliasMap.get(right) || [right];
            const leftMentionedInText = textContainsAlias(content, leftAliases);
            const rightMentionedInText = textContainsAlias(content, rightAliases);
            const leftBySpeaker = leftAliases.some(alias => normalizeComparableText(alias) === senderNormalized);
            const rightBySpeaker = rightAliases.some(alias => normalizeComparableText(alias) === senderNormalized);
            const remoteAnchored = remoteId && remoteIdSet.has(remoteId);
            const leftPresent = leftMentionedInText || leftBySpeaker;
            const rightPresent = rightMentionedInText || rightBySpeaker;

            const hasPairEvidence = Boolean(
                (leftMentionedInText && rightMentionedInText) ||
                (remoteAnchored && leftBySpeaker && rightMentionedInText) ||
                (remoteAnchored && rightBySpeaker && leftMentionedInText)
            );

            if (!hasPairEvidence) continue;

            const relationType = inferRelationTypeFromText(content, relationFilter);
            if (!relationType) continue;

            const sourceNode = leftPresent ? left : right;
            const targetNode = sourceNode === left ? right : left;
            const sourceId = `relationship_memory:${row.id}:${sourceNode}:${relationType}:${targetNode}`;
            if (seen.has(sourceId)) continue;
            seen.add(sourceId);

            results.push(toFactEvidenceCandidate({
                fact_type: 'relationship_memory',
                source_id: sourceId,
                entity_name: sourceNode,
                speaker: sender || sourceNode,
                remote_id: remoteId,
                timestamp: getEventTimestamp(row),
                relation_type: relationType,
                source_node: sourceNode,
                target_node: targetNode,
                evidence_text: extractRelationshipSnippet(content, [...leftAliases, ...rightAliases]),
                metadata: {
                    memory_id: row.id,
                    support_count: 1,
                    stability_tier: 'provisional',
                    relation_filter: relationFilter || null
                },
                recall_score: 0.93
            }, { source: 'RELATIONSHIP_MEMORY_EXACT' }));
        }
    }

    return results.slice(0, matchCount);
}

async function buildEntityLookupContext(clientId, entityNames = []) {
    const names = [...new Set((entityNames || []).map(name => String(name || '').trim()).filter(Boolean))].slice(0, 12);
    const identityMatches = await resolveIdentityCandidates(clientId, names).catch(() => []);
    const aliasMap = new Map();

    for (const name of names) addAliasToMap(aliasMap, name);
    for (const row of identityMatches) {
        addAliasToMap(aliasMap, row.canonical_name);
        for (const alias of (row.aliases || [])) addAliasToMap(aliasMap, alias);
    }

    return {
        names,
        identityMatches,
        aliasList: [...aliasMap.values()].slice(0, 24),
        normalizedAliases: new Set([...aliasMap.keys()]),
        remoteIdList: [...new Set(identityMatches.map(row => row.remote_id).filter(Boolean))]
    };
}

/**
 * Executes a traversal over the knowledge graph (GraphRAG).
 */
export async function traverseGraph(clientId, queryText, queryVector, matchCount = 5) {
    const { data, error } = await supabase.rpc('graphrag_traverse', {
        query_text: queryText,
        query_embedding: queryVector,
        match_count: matchCount,
        p_client_id: clientId
    });

    if (error) {
        console.warn('[Graph Service] Fallo en traversal:', error.message);
        throw error;
    }

    return (data || []).map(g => ({
        content: `[Resonancia: ${(g.cognitive_resonance * 100).toFixed(1)}%] [Ruta: ${g.reasoning_path}] [Visto: ${g.last_seen || g.created_at || 'N/A'}]\n${g.knowledge}`,
        sender: g.entity_type,
        similarity: g.cognitive_resonance,
        hop: g.hop,
        timestamp: g.last_seen || g.created_at || null,
        source: 'GRAPH_V3'
    }));
}

export async function traverseGraphV2(clientId, queryText, queryVector, matchCount = 10) {
    try {
        const { data, error } = await supabase.rpc('graphrag_traverse_v2', {
            query_text: queryText,
            query_embedding: queryVector,
            match_count: matchCount,
            p_client_id: clientId
        });

        if (error) throw error;
        return (data || []).map(row => toGraphEvidenceCandidate(row));
    } catch (error) {
        console.warn('[Graph Service] graphrag_traverse_v2 fallback:', error.message);
        const legacy = await traverseGraph(clientId, queryText, queryVector, matchCount).catch(() => []);
        return legacy.map(row => toGraphEvidenceCandidate({
            source_node: row.sender,
            target_node: null,
            relation_type: null,
            hop: row.hop || 0,
            knowledge: row.content,
            entity_name: row.sender,
            entity_type: row.sender,
            context: row.content,
            last_seen: row.timestamp,
            cognitive_resonance: row.similarity || 0,
            recall_score: row.similarity || 0
        }, { source: row.source || 'GRAPH_LEGACY' }));
    }
}

/**
 * Stores or updates a knowledge node using deterministic normalization.
 */
export async function upsertKnowledgeNode(clientId, entityName, entityType, description, options = {}) {
    const { data: soulRow } = await supabase
        .from('user_souls')
        .select('soul_json')
        .eq('client_id', clientId)
        .single();

    const ownerCanonicalName = normalizeEntityName(soulRow?.soul_json?.nombre) || null;
    const finalEntityName = normalizeEntityName(entityName, ownerCanonicalName);
    if (!finalEntityName) return null;

    const finalEntityType = deriveEffectiveEntityType(finalEntityName, entityType);
    if (!finalEntityType) return null;
    if (finalEntityType === 'PERSONA' && isPhoneLikeGraphName(finalEntityName)) {
        return null;
    }
    const finalDescription = String(description || '').trim().slice(0, 1000);
    const stagedMention = await upsertEntityMentionAggregate(clientId, finalEntityName, finalEntityType, finalDescription, options);

    if (stagedMention && !stagedMention.stability.promote) {
        return null;
    }

    const { data: exactNode } = await supabase
        .from('knowledge_nodes')
        .select('id, description, support_count, stable_score, stability_tier, entity_type, source_tags')
        .eq('client_id', clientId)
        .eq('entity_name', finalEntityName)
        .maybeSingle();

    const nextSupportCount = stagedMention
        ? Math.max(Number(exactNode?.support_count || 0), Number(stagedMention.supportCount || 0))
        : Number(exactNode?.support_count || 0) + 1;
    const nextSourceTags = stagedMention?.sourceTags || mergeSourceTags(exactNode?.source_tags || [], options.source || '');
    const stability = stagedMention?.stability || computeNodeStability({
        entityName: finalEntityName,
        entityType: finalEntityType,
        description: finalDescription,
        supportCount: nextSupportCount,
        source: options.source || '',
        sourceTags: nextSourceTags,
        existingScore: exactNode?.stable_score || 0,
        existingTier: exactNode?.stability_tier || 'candidate'
    });

    if (!stability.promote) {
        return null;
    }

    if (exactNode?.id) {
        const patch = {
            support_count: nextSupportCount,
            stable_score: stability.score,
            stability_tier: stability.tier,
            source_tags: nextSourceTags,
            last_seen: nowIso()
        };
        if (finalDescription && finalDescription.length > String(exactNode.description || '').length) {
            patch.description = finalDescription;
        }
        if (finalEntityType && finalEntityType !== String(exactNode.entity_type || '').trim()) {
            patch.entity_type = finalEntityType;
        }
        if (stability.promote) {
            patch.embedding = await generateEmbedding(`${finalEntityName} ${patch.description || finalDescription || exactNode.description || ''}`);
        }
        await supabase
            .from('knowledge_nodes')
            .update(patch)
            .eq('id', exactNode.id);
        if (stagedMention?.mentionId) {
            await markEntityMentionPromoted(stagedMention.mentionId, exactNode.id);
        }
        return exactNode.id;
    }

    if (finalEntityName.length >= 3) {
        const { data: nearbyNodes } = await supabase
            .from('knowledge_nodes')
            .select('id, entity_name')
            .eq('client_id', clientId)
            .ilike('entity_name', `${finalEntityName}%`)
            .limit(25);

        const normalizedTarget = normalizeComparableText(finalEntityName);
        const normalizedMatch = (nearbyNodes || [])
            .map(node => ({
                id: node.id,
                entity_name: node.entity_name,
                normalized: normalizeComparableText(normalizeEntityName(node.entity_name, ownerCanonicalName) || node.entity_name)
            }))
            .filter(node => node.normalized === normalizedTarget)
            .sort((a, b) => a.entity_name.length - b.entity_name.length)[0];

        if (normalizedMatch?.id) {
            return normalizedMatch.id;
        }
    }

    const embedding = stability.promote
        ? await generateEmbedding(`${finalEntityName} ${finalDescription}`)
        : null;

    const { data: inserted, error } = await supabase.from('knowledge_nodes').upsert({
        client_id: clientId,
        entity_name: finalEntityName,
        entity_type: finalEntityType,
        description: stagedMention?.description || finalDescription,
        embedding,
        support_count: nextSupportCount,
        stable_score: stability.score,
        stability_tier: stability.tier,
        source_tags: nextSourceTags,
        last_seen: nowIso()
    }, { onConflict: 'client_id, entity_name' }).select('id').single();

    if (error) {
        console.error('[Graph Service] Error upserting node:', error.message);
        throw error;
    }

    if (stagedMention?.mentionId) {
        await markEntityMentionPromoted(stagedMention.mentionId, inserted.id);
    }

    return inserted.id;
}

/**
 * Creates or updates an edge between two normalized entity names.
 */
export async function upsertKnowledgeEdge(clientId, sourceName, targetName, relationType, weight = 1, context = null, flags = {}, options = {}) {
    const flagsPayload = Array.isArray(flags) ? flags : [flags];
    const normalizedSource = normalizeEntityName(sourceName) || String(sourceName || '').trim();
    const normalizedTarget = normalizeEntityName(targetName) || String(targetName || '').trim();
    const canonicalRelationType = sanitizeRelationType(relationType) || String(relationType || '').trim();
    const { sourceNode: canonicalSource, targetNode: canonicalTarget } = canonicalizeEdgeDirection(
        normalizedSource,
        normalizedTarget,
        canonicalRelationType
    );

    if (!canonicalSource || !canonicalTarget || !canonicalRelationType) return false;
    if (canonicalSource === canonicalTarget) return false;

    const numericWeight = Number(weight);
    let intWeight = 5;

    if (Number.isFinite(numericWeight)) {
        if (numericWeight >= 1 && numericWeight <= 10) {
            intWeight = Math.round(numericWeight);
        } else if (numericWeight >= 0 && numericWeight <= 1) {
            intWeight = Math.round(numericWeight * 10);
        } else if (numericWeight >= -1 && numericWeight <= 1) {
            intWeight = Math.round((numericWeight + 1) * 5);
        } else {
            intWeight = Math.round(numericWeight);
        }
    }

    intWeight = Math.min(10, Math.max(1, intWeight || 5));
    const canonicalContext = String(context || '').trim().slice(0, 500) || null;
    const stagedMention = await upsertRelationMentionAggregate(
        clientId,
        canonicalSource,
        canonicalTarget,
        canonicalRelationType,
        intWeight,
        canonicalContext,
        flagsPayload,
        options
    );
    const { data: exactEdge } = await supabase
        .from('knowledge_edges')
        .select('id, support_count, stable_score, stability_tier, weight, context, cognitive_flags, source_tags, metadata')
        .eq('client_id', clientId)
        .eq('source_node', canonicalSource)
        .eq('relation_type', canonicalRelationType)
        .eq('target_node', canonicalTarget)
        .maybeSingle();

    const nextSupportCount = stagedMention
        ? Math.max(Number(exactEdge?.support_count || 0), Number(stagedMention.supportCount || 0))
        : Number(exactEdge?.support_count || 0) + 1;
    const mergedFlags = [
        ...new Set([
            ...(Array.isArray(exactEdge?.cognitive_flags) ? exactEdge.cognitive_flags : []),
            ...(Array.isArray(stagedMention?.cognitiveFlags) ? stagedMention.cognitiveFlags : []),
            ...flagsPayload.filter(Boolean)
        ])
    ];
    const mergedSourceTags = stagedMention?.sourceTags || mergeSourceTags(exactEdge?.source_tags || [], options.source || '');
    const conflictingExclusiveEdge = await hasConflictingExclusiveEdge(
        clientId,
        canonicalSource,
        canonicalRelationType,
        canonicalTarget
    );
    if (conflictingExclusiveEdge && !mergedFlags.includes('conflicted')) {
        mergedFlags.push('conflicted');
    }
    const stability = stagedMention?.stability || computeEdgeStability({
        relationType: canonicalRelationType,
        context: stagedMention?.context || canonicalContext || exactEdge?.context || '',
        weight: intWeight,
        supportCount: nextSupportCount,
        source: options.source || '',
        sourceTags: mergedSourceTags,
        flags: mergedFlags,
        existingScore: exactEdge?.stable_score || 0,
        existingTier: exactEdge?.stability_tier || 'candidate'
    });

    if (!stability.promote) {
        return false;
    }

    const mergedMetadata = {
        ...(exactEdge?.metadata || {}),
        ...(stagedMention?.metadata || {}),
        ...(options.metadata || {})
    };

    const { error } = await supabase.from('knowledge_edges').upsert({
        client_id: clientId,
        source_node: canonicalSource,
        target_node: canonicalTarget,
        relation_type: canonicalRelationType,
        weight: Math.max(intWeight, Number(exactEdge?.weight || 0)),
        context: stagedMention?.context || canonicalContext || exactEdge?.context || null,
        cognitive_flags: mergedFlags,
        source_tags: mergedSourceTags,
        metadata: mergedMetadata,
        support_count: nextSupportCount,
        stable_score: stability.score,
        stability_tier: stability.tier,
        last_seen: nowIso()
    }, { onConflict: 'client_id, source_node, relation_type, target_node' });

    if (error) {
        console.error('[Graph Service] Error upserting edge:', error.message);
        throw error;
    }
    if (stagedMention?.mentionId) {
        await markRelationMentionPromoted(stagedMention.mentionId);
    }
    return true;
}

/**
 * Performs a hybrid search (semantic + text) across memories.
 */
export async function hybridSearchV2(clientId, queryText, queryVector, matchCount = 12) {
    try {
        const { data, error } = await supabase.rpc('hybrid_search_memories_v2', {
            query_text: queryText,
            query_embedding: queryVector,
            match_count: matchCount,
            p_client_id: clientId
        });

        if (error) throw error;
        return (data || []).map(row => toMemoryEvidenceCandidate(row, { source: 'HYBRID_V2' }));
    } catch (error) {
        console.warn('[Graph Service] hybrid_search_memories_v2 fallback:', error.message);
        const legacy = await hybridSearch(clientId, queryText, queryVector, matchCount).catch(() => []);
        return legacy.map(row => toMemoryEvidenceCandidate({
            ...row,
            metadata: row.metadata || {},
            created_at: row.timestamp || row.created_at || null,
            score_vector: row.similarity || 0,
            recall_score: row.similarity || 0
        }, { source: row.source || 'HYBRID_LEGACY' }));
    }
}

export async function exactEntityMemorySearch(clientId, entityNames = [], matchCount = 20) {
    const lookup = await buildEntityLookupContext(clientId, entityNames);
    if (!lookup.names.length) return [];

    try {
        const results = [];
        const seenIds = new Set();
        const remoteIdSet = new Set(lookup.remoteIdList);

        if (remoteIdSet.size > 0) {
            const { data: recentRows } = await supabase
                .from('user_memories')
                .select('id, content, sender, metadata, created_at')
                .eq('client_id', clientId)
                .order('created_at', { ascending: false })
                .limit(Math.max(matchCount * 40, 800));

            for (const row of (recentRows || [])) {
                const remoteId = row.metadata?.remoteId || row.metadata?.remote_id || row.metadata?.participantJid || null;
                if (!remoteIdSet.has(remoteId)) continue;
                if (seenIds.has(row.id)) continue;
                seenIds.add(row.id);
                results.push(toMemoryEvidenceCandidate({
                    ...row,
                    remote_id: remoteId,
                    timestamp: getEventTimestamp(row),
                    score_vector: 0.92,
                    score_fts: 0.92,
                    recall_score: 0.97
                }, { source: 'EXACT_ENTITY_REMOTE' }));
            }
        }

        if (lookup.aliasList.length > 0) {
            const { data: senderMatches } = await supabase
                .from('user_memories')
                .select('id, content, sender, metadata, created_at')
                .eq('client_id', clientId)
                .in('sender', lookup.aliasList)
                .order('created_at', { ascending: false })
                .limit(matchCount);

            for (const row of (senderMatches || [])) {
                if (seenIds.has(row.id)) continue;
                seenIds.add(row.id);
                results.push(toMemoryEvidenceCandidate({
                    ...row,
                    remote_id: row.metadata?.remoteId || null,
                    timestamp: getEventTimestamp(row),
                    score_vector: 0.9,
                    score_fts: 0.9,
                    recall_score: 0.95
                }, { source: 'EXACT_ENTITY_SENDER' }));
            }
        }

        for (const alias of lookup.aliasList.slice(0, 8)) {
            if (alias.length < 4) continue;
            const { data: contentMatches } = await supabase
                .from('user_memories')
                .select('id, content, sender, metadata, created_at')
                .eq('client_id', clientId)
                .ilike('content', `%${alias}%`)
                .limit(6);

            for (const row of (contentMatches || [])) {
                if (seenIds.has(row.id)) continue;
                seenIds.add(row.id);
                results.push(toMemoryEvidenceCandidate({
                    ...row,
                    remote_id: row.metadata?.remoteId || null,
                    timestamp: getEventTimestamp(row),
                    score_vector: 0.75,
                    score_fts: 0.95,
                    recall_score: 0.9
                }, { source: 'EXACT_ENTITY_CONTENT' }));
            }
        }

        return results.slice(0, matchCount);
    } catch (error) {
        console.warn('[Graph Service] exactEntityMemorySearch skipped:', error.message);
        return [];
    }
}

export async function exactEntityFactSearch(clientId, entityNames = [], matchCount = 12) {
    const lookup = await buildEntityLookupContext(clientId, entityNames);
    if (!lookup.names.length) return [];

    try {
        const results = [];
        const seen = new Set();
        const pushResult = candidate => {
            if (!candidate?.source_id || seen.has(candidate.source_id)) return;
            seen.add(candidate.source_id);
            results.push(candidate);
        };

        for (const row of lookup.identityMatches) {
            const aliases = [...new Set((row.aliases || []).filter(isMeaningfulAlias))].slice(0, 4);
            const aliasSuffix = aliases.length ? ` Alias confirmados: ${aliases.join(', ')}.` : '';
            const isOwnerIdentity = row.remote_id === 'self' || row.source_details?.owner_identity;
            const isGroupIdentity = String(row.remote_id || '').endsWith('@g.us');
            pushResult(toFactEvidenceCandidate({
                fact_type: 'contact_identity',
                source_id: `contact_identity:${row.remote_id}`,
                entity_name: row.canonical_name,
                speaker: row.canonical_name,
                remote_id: row.remote_id,
                timestamp: row.last_verified_at || row.updated_at || row.created_at || null,
                evidence_text: isOwnerIdentity
                    ? `${row.canonical_name} es el titular de esta memoria.`
                    : (isGroupIdentity
                        ? `${row.canonical_name} es un grupo identificado en tu memoria.${aliasSuffix}`
                        : `${row.canonical_name} es un contacto identificado en tu memoria.${aliasSuffix}`),
                metadata: {
                    aliases,
                    confidence: row.confidence,
                    owner_identity: isOwnerIdentity,
                    identity_kind: isGroupIdentity ? 'group' : 'contact',
                    support_count: 1,
                    stability_tier: 'stable'
                },
                recall_score: 0.99
            }, { source: 'CONTACT_IDENTITY' }));
        }

        const { data: soulRow } = await supabase
            .from('user_souls')
            .select('soul_json')
            .eq('client_id', clientId)
            .maybeSingle();

        const ownerNames = [
            soulRow?.soul_json?.nombre,
            soulRow?.soul_json?.profile?.name,
            soulRow?.soul_json?.profile?.nombre
        ].filter(Boolean);

        const normalizedOwnerNames = ownerNames.map(name => normalizeComparableText(name));
        const ownerMatched = [...lookup.normalizedAliases].some(alias => normalizedOwnerNames.includes(alias));
        if (ownerMatched && ownerNames[0]) {
            pushResult(toFactEvidenceCandidate({
                fact_type: 'owner_identity',
                source_id: `owner_identity:${clientId}`,
                entity_name: ownerNames[0],
                speaker: ownerNames[0],
                remote_id: 'self',
                evidence_text: `El titular de esta memoria es ${ownerNames[0]}.`,
                metadata: {
                    owner_names: ownerNames,
                    support_count: 1,
                    stability_tier: 'stable'
                },
                recall_score: 0.995
            }, { source: 'OWNER_IDENTITY' }));
        }

        const candidateNodeNames = new Set([
            ...lookup.aliasList,
            ...lookup.identityMatches.map(row => row.canonical_name).filter(Boolean)
        ]);
        const directIdentityNames = new Set(
            lookup.identityMatches
                .flatMap(row => [row?.canonical_name, ...(row?.aliases || [])])
                .map(value => normalizeComparableText(value))
                .filter(Boolean)
        );
        const exactNodeNames = new Set();
        const exactMentionNames = new Set();

        for (const alias of [...candidateNodeNames].slice(0, 10)) {
            const { data: nodes } = await supabase
                .from('knowledge_nodes')
                .select('id, entity_name, entity_type, description, created_at, updated_at, stable_score, stability_tier')
                .eq('client_id', clientId)
                .in('stability_tier', ['provisional', 'stable'])
                .ilike('entity_name', alias)
                .limit(4);

            for (const node of (nodes || [])) {
                if (!isStableTier(node.stability_tier)) continue;
                const normalizedName = normalizeComparableText(node.entity_name);
                if (!lookup.normalizedAliases.has(normalizedName)) continue;
                exactNodeNames.add(node.entity_name);
                const description = String(node.description || '').trim();
                pushResult(toFactEvidenceCandidate({
                    fact_type: 'knowledge_node',
                    source_id: `knowledge_node:${node.id}`,
                    entity_name: node.entity_name,
                    speaker: node.entity_name,
                    timestamp: node.updated_at || node.created_at || null,
                    evidence_text: description
                        ? `${node.entity_name}: ${description}`
                        : `${node.entity_name} aparece como entidad ${node.entity_type || 'registrada'} en tu memoria.`,
                    metadata: {
                        entity_type: node.entity_type,
                        support_count: node.support_count || 0,
                        stable_score: node.stable_score || 0,
                        stability_tier: node.stability_tier || 'candidate'
                    },
                    recall_score: 0.96
                }, { source: 'KNOWLEDGE_NODE_EXACT' }));
            }

            const { data: mentions } = await supabase
                .from('entity_mentions')
                .select('id, entity_name, entity_type, description, support_count, stable_score, stability_tier, last_seen, updated_at')
                .eq('client_id', clientId)
                .in('stability_tier', ['provisional', 'stable'])
                .ilike('entity_name', alias)
                .limit(4);

            for (const mention of (mentions || [])) {
                if (!isStableTier(mention.stability_tier)) continue;
                const normalizedName = normalizeComparableText(mention.entity_name);
                if (!lookup.normalizedAliases.has(normalizedName)) continue;
                if (!shouldIncludeExactEntityMention(mention, directIdentityNames)) continue;
                exactMentionNames.add(mention.entity_name);
                const description = String(mention.description || '').trim();
                pushResult(toFactEvidenceCandidate({
                    fact_type: 'entity_mention',
                    source_id: `entity_mention:${mention.id}`,
                    entity_name: mention.entity_name,
                    speaker: mention.entity_name,
                    timestamp: mention.last_seen || mention.updated_at || null,
                    evidence_text: description
                        ? `${mention.entity_name} aparece mencionado en tus recuerdos como ${description}.`
                        : `${mention.entity_name} aparece mencionado varias veces en tus recuerdos.`,
                    metadata: {
                        entity_type: mention.entity_type,
                        support_count: mention.support_count || 0,
                        stable_score: mention.stable_score || 0,
                        stability_tier: mention.stability_tier || 'candidate'
                    },
                    recall_score: 0.955
                }, { source: 'ENTITY_MENTION_EXACT' }));
            }
        }

        const exactGraphEntityNames = [...new Set([
            ...exactNodeNames,
            ...exactMentionNames
        ])].slice(0, 8);

        for (const entityName of exactGraphEntityNames) {
            const edgeQueries = await Promise.all([
                supabase
                    .from('knowledge_edges')
                    .select('source_node, target_node, relation_type, context, last_seen, weight, support_count, stable_score, stability_tier, cognitive_flags')
                    .eq('client_id', clientId)
                    .in('stability_tier', ['provisional', 'stable'])
                    .eq('source_node', entityName)
                    .order('last_seen', { ascending: false })
                    .limit(4),
                supabase
                    .from('knowledge_edges')
                    .select('source_node, target_node, relation_type, context, last_seen, weight, support_count, stable_score, stability_tier, cognitive_flags')
                    .eq('client_id', clientId)
                    .in('stability_tier', ['provisional', 'stable'])
                    .eq('target_node', entityName)
                    .order('last_seen', { ascending: false })
                    .limit(4),
                supabase
                    .from('relation_mentions')
                    .select('id, source_node, target_node, relation_type, context, last_seen, support_count, stable_score, stability_tier, cognitive_flags, metadata')
                    .eq('client_id', clientId)
                    .in('stability_tier', ['provisional', 'stable'])
                    .eq('source_node', entityName)
                    .order('stable_score', { ascending: false })
                    .order('last_seen', { ascending: false })
                    .limit(4),
                supabase
                    .from('relation_mentions')
                    .select('id, source_node, target_node, relation_type, context, last_seen, support_count, stable_score, stability_tier, cognitive_flags, metadata')
                    .eq('client_id', clientId)
                    .in('stability_tier', ['provisional', 'stable'])
                    .eq('target_node', entityName)
                    .order('stable_score', { ascending: false })
                    .order('last_seen', { ascending: false })
                    .limit(4)
            ]);

            for (const queryResult of edgeQueries) {
                for (const edge of (queryResult.data || [])) {
                    if (!isStableTier(edge.stability_tier)) continue;
                    pushResult(toFactEvidenceCandidate({
                        fact_type: 'knowledge_edge',
                        source_id: `knowledge_edge:${edge.source_node}:${edge.relation_type}:${edge.target_node}`,
                        entity_name,
                        speaker: edge.source_node,
                        timestamp: edge.last_seen || null,
                        relation_type: edge.relation_type,
                        source_node: edge.source_node,
                        target_node: edge.target_node,
                        evidence_text: `${edge.source_node} tiene relacion ${edge.relation_type} con ${edge.target_node}.`,
                        metadata: {
                            context: edge.context || null,
                            weight: edge.weight || null,
                            support_count: edge.support_count || 0,
                            stable_score: edge.stable_score || 0,
                            stability_tier: edge.stability_tier || 'candidate',
                            cognitive_flags: edge.cognitive_flags || []
                        },
                        recall_score: 0.95
                    }, { source: 'KNOWLEDGE_EDGE_EXACT' }));
                }
            }

            for (const queryResult of edgeQueries.slice(2)) {
                for (const mention of (queryResult.data || [])) {
                    if (!isStableTier(mention.stability_tier)) continue;
                    pushResult(toFactEvidenceCandidate({
                        fact_type: 'relationship_mention',
                        source_id: `relationship_mention:${mention.id}`,
                        entity_name,
                        speaker: mention.source_node,
                        timestamp: mention.last_seen || null,
                        relation_type: mention.relation_type,
                        source_node: mention.source_node,
                        target_node: mention.target_node,
                        evidence_text: String(
                            mention.metadata?.evidence
                            || mention.context
                            || `${mention.source_node} tiene relacion ${mention.relation_type} con ${mention.target_node}.`
                        ).trim(),
                        metadata: {
                            context: mention.context || null,
                            support_count: mention.support_count || 0,
                            stable_score: mention.stable_score || 0,
                            stability_tier: mention.stability_tier || 'candidate',
                            cognitive_flags: mention.cognitive_flags || []
                        },
                        recall_score: 0.945
                    }, { source: 'RELATION_MENTION_EXACT' }));
                }
            }
        }

        return results.slice(0, matchCount);
    } catch (error) {
        console.warn('[Graph Service] exactEntityFactSearch skipped:', error.message);
        return [];
    }
}

export async function temporalMemorySearch(clientId, temporalWindow, entityNames = [], matchCount = 20) {
    if (!temporalWindow?.start || !temporalWindow?.end) return [];
    const lookup = await buildEntityLookupContext(clientId, entityNames);

    const { data: rows, error } = await supabase
        .from('user_memories')
        .select('id, content, sender, metadata, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(Math.max(matchCount * 80, 1200));

    if (error) {
        console.warn('[Graph Service] temporalMemorySearch skipped:', error.message);
        return [];
    }

    const startMs = new Date(temporalWindow.start).getTime();
    const endMs = new Date(temporalWindow.end).getTime();
    const remoteIdSet = new Set(lookup.remoteIdList);
    return (rows || [])
        .filter(row => {
            const eventTimestamp = getEventTimestamp(row);
            const eventMs = new Date(eventTimestamp).getTime();
            if (!Number.isFinite(eventMs) || eventMs < startMs || eventMs > endMs) return false;

            if (!lookup.aliasList.length && !remoteIdSet.size) return true;

            const remoteId = row.metadata?.remoteId || row.metadata?.remote_id || row.metadata?.participantJid || null;
            if (remoteIdSet.has(remoteId)) return true;

            const haystack = normalizeComparableText([
                row.sender,
                row.content,
                row.metadata?.contactName,
                row.metadata?.canonicalSenderName
            ].filter(Boolean).join(' '));

            return [...lookup.normalizedAliases].some(entity => haystack.includes(entity));
        })
        .slice(0, matchCount)
        .map(row => toMemoryEvidenceCandidate({
            ...row,
            remote_id: row.metadata?.remoteId || null,
            timestamp: getEventTimestamp(row),
            score_vector: 0.7,
            score_fts: 0.85,
            recall_score: 0.9
        }, { source: 'TEMPORAL_MEMORY' }));
}

export async function mediaMemorySearch(clientId, entityNames = [], queryText = '', matchCount = 12) {
    const lookup = await buildEntityLookupContext(clientId, entityNames);
    const rowsPerPass = Math.max(matchCount * 80, 1200);
    const mediaTerms = extractRequestedMediaTerms(queryText);
    const fallbackMediaTerms = mediaTerms.length ? mediaTerms : ['audio', 'nota de voz', 'voz', 'voice', 'foto', 'imagen', 'image', 'video', 'clip', 'documento', 'pdf', 'archivo'];

    try {
        const { data: rows, error } = await supabase
            .from('user_memories')
            .select('id, content, sender, metadata, created_at')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(rowsPerPass);

        if (error) throw error;

        const remoteIdSet = new Set(lookup.remoteIdList);
        return (rows || [])
            .map(row => {
                const remoteId = row.metadata?.remoteId || row.metadata?.remote_id || row.metadata?.participantJid || null;
                const senderHaystack = normalizeComparableText([
                    row.sender,
                    row.metadata?.contactName,
                    row.metadata?.canonicalSenderName
                ].filter(Boolean).join(' '));
                const haystack = normalizeComparableText([
                    row.sender,
                    row.content,
                    row.metadata?.contactName,
                    row.metadata?.canonicalSenderName,
                    row.metadata?.mediaType,
                    row.metadata?.attachmentType,
                    row.metadata?.attachmentMime,
                    row.metadata?.caption
                ].filter(Boolean).join(' '));

                if (!haystack) return false;
                const matchedTerms = fallbackMediaTerms.filter(term => term && haystack.includes(term));
                if (!matchedTerms.length) return null;
                if (!hasExplicitMediaAnchor(row) && matchedTerms.length < 2) return null;

                let entityMatched = !lookup.aliasList.length && !remoteIdSet.size;

                if (remoteIdSet.has(remoteId)) entityMatched = true;

                if (remoteIdSet.size > 0) {
                    entityMatched = entityMatched || [...lookup.normalizedAliases].some(alias => senderHaystack.includes(alias));
                } else {
                    entityMatched = entityMatched || [...lookup.normalizedAliases].some(alias => haystack.includes(alias));
                }

                if (!entityMatched) return null;

                const contentNormalized = normalizeComparableText(row.content || '');
                const exactPhraseBoost = /(escuchaste mi audio|audio de|nota de voz|audio llor)/i.test(contentNormalized) ? 3 : 0;
                const senderBoost = [...lookup.normalizedAliases].some(alias => senderHaystack.includes(alias)) ? 2 : 0;
                const remoteBoost = remoteIdSet.has(remoteId) ? 3 : 0;
                const mediaSnippetTerms = matchedTerms.length
                    ? matchedTerms
                    : fallbackMediaTerms.filter(term => normalizeComparableText(row.content || '').includes(term));

                return {
                    row,
                    mediaScore: matchedTerms.length + exactPhraseBoost + senderBoost + remoteBoost + (hasExplicitMediaAnchor(row) ? 4 : 0),
                    mediaSnippetTerms
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.mediaScore - a.mediaScore || new Date(getEventTimestamp(b.row)).getTime() - new Date(getEventTimestamp(a.row)).getTime())
            .slice(0, matchCount)
            .map(({ row, mediaScore, mediaSnippetTerms }) => {
                const mediaExtraction = extractMediaSnippetFromContent(
                    row.content || '',
                    mediaSnippetTerms,
                    row.sender || row.metadata?.contactName || row.metadata?.canonicalSenderName || null
                );

                return toMemoryEvidenceCandidate({
                ...row,
                remote_id: row.metadata?.remoteId || null,
                timestamp: getEventTimestamp(row),
                metadata: {
                    ...(row.metadata || {}),
                    mediaMatchedTerms: mediaSnippetTerms,
                    mediaSnippet: mediaExtraction.snippet,
                    mediaParticipants: mediaExtraction.participants,
                    explicitMediaAnchor: hasExplicitMediaAnchor(row)
                },
                score_vector: 0.78 + Math.min(mediaScore * 0.02, 0.12),
                score_fts: 0.92,
                recall_score: 0.94 + Math.min(mediaScore * 0.01, 0.05)
                }, { source: 'MEDIA_MEMORY' });
            });
    } catch (error) {
        console.warn('[Graph Service] mediaMemorySearch skipped:', error.message);
        return [];
    }
}

export async function exactRelationshipSearch(clientId, entityNames = [], matchCount = 10, options = {}) {
    const lookup = await buildEntityLookupContext(clientId, entityNames);
    const canonicalEntities = [...new Set([
        ...lookup.names,
        ...lookup.identityMatches.map(row => row.canonical_name)
    ].map(value => String(value || '').trim()).filter(Boolean))].slice(0, 3);

    if (canonicalEntities.length < 2) return [];

    try {
        const pairs = [];
        for (let i = 0; i < canonicalEntities.length; i += 1) {
            for (let j = i + 1; j < canonicalEntities.length; j += 1) {
                pairs.push([canonicalEntities[i], canonicalEntities[j]]);
            }
        }

        const results = [];
        const seen = new Set();
        const pushCandidate = candidate => {
            if (!candidate?.source_id || seen.has(candidate.source_id)) return;
            seen.add(candidate.source_id);
            results.push(candidate);
        };

        const requestedRelation = normalizeRelationFilterKey(options.relationFilter);

        for (const [left, right] of pairs.slice(0, 3)) {
            const queries = await Promise.all([
                supabase
                    .from('knowledge_edges')
                    .select('source_node, target_node, relation_type, context, last_seen, weight, support_count, stable_score, stability_tier, cognitive_flags')
                    .eq('client_id', clientId)
                    .in('stability_tier', ['provisional', 'stable'])
                    .eq('source_node', left)
                    .eq('target_node', right)
                    .order('last_seen', { ascending: false })
                    .limit(6),
                supabase
                    .from('knowledge_edges')
                    .select('source_node, target_node, relation_type, context, last_seen, weight, support_count, stable_score, stability_tier, cognitive_flags')
                    .eq('client_id', clientId)
                    .in('stability_tier', ['provisional', 'stable'])
                    .eq('source_node', right)
                    .eq('target_node', left)
                    .order('last_seen', { ascending: false })
                    .limit(6),
                supabase
                    .from('relation_mentions')
                    .select('source_node, target_node, relation_type, context, last_seen, support_count, stable_score, stability_tier, cognitive_flags, metadata')
                    .eq('client_id', clientId)
                    .in('stability_tier', ['provisional', 'stable'])
                    .eq('source_node', left)
                    .eq('target_node', right)
                    .order('stable_score', { ascending: false })
                    .order('last_seen', { ascending: false })
                    .limit(6),
                supabase
                    .from('relation_mentions')
                    .select('source_node, target_node, relation_type, context, last_seen, support_count, stable_score, stability_tier, cognitive_flags, metadata')
                    .eq('client_id', clientId)
                    .in('stability_tier', ['provisional', 'stable'])
                    .eq('source_node', right)
                    .eq('target_node', left)
                    .order('stable_score', { ascending: false })
                    .order('last_seen', { ascending: false })
                    .limit(6)
            ]);

            for (const queryResult of queries) {
                for (const edge of (queryResult.data || [])) {
                    if (!isStableTier(edge.stability_tier)) continue;
                    if (requestedRelation && requestedRelation !== 'ANY_RELATION' && normalizeRelationFilterKey(edge.relation_type) !== requestedRelation) continue;
                    pushCandidate(toFactEvidenceCandidate({
                        fact_type: 'relationship_edge',
                        source_id: `relationship_edge:${edge.source_node}:${edge.relation_type}:${edge.target_node}`,
                        entity_name: edge.source_node,
                        speaker: edge.source_node,
                        timestamp: edge.last_seen || null,
                        relation_type: edge.relation_type,
                        source_node: edge.source_node,
                        target_node: edge.target_node,
                        evidence_text: String(edge.metadata?.evidence || edge.context || `${edge.source_node} tiene relacion ${edge.relation_type} con ${edge.target_node}.`).trim(),
                        metadata: {
                            context: edge.context || null,
                            weight: edge.weight || null,
                            support_count: edge.support_count || 0,
                            stable_score: edge.stable_score || 0,
                            stability_tier: edge.stability_tier || 'candidate',
                            cognitive_flags: edge.cognitive_flags || [],
                            evidence: edge.metadata?.evidence || null
                        },
                        recall_score: 0.985
                    }, { source: 'RELATIONSHIP_EDGE_EXACT' }));
                }
            }
        }

        const memoryCandidates = await exactRelationshipMemorySearch(
            clientId,
            lookup,
            canonicalEntities,
            options.relationFilter || null,
            Math.max(4, Math.min(matchCount, 8))
        );
        for (const candidate of memoryCandidates) {
            pushCandidate(candidate);
        }

        return results.slice(0, matchCount);
    } catch (error) {
        console.warn('[Graph Service] exactRelationshipSearch skipped:', error.message);
        return [];
    }
}

export async function hybridSearch(clientId, queryText, queryVector, matchCount = 10) {
    const { data, error } = await supabase.rpc('hybrid_search_memories', {
        query_text: queryText,
        query_embedding: queryVector,
        match_count: matchCount,
        p_client_id: clientId
    });

    if (error) {
        console.warn('[Graph Service] Fallo en busqueda hibrida:', error.message);
        throw error;
    }

    const results = (data || []).map(m => ({
        ...m,
        source: 'HYBRID',
        remote_id: m.remote_id,
        timestamp: m.timestamp || m.date || m.created_at || null
    }));

    const nameRegex = /\b([\p{L}][\p{L}'-]{2,})\b/gu;
    const stopWords = new Set([
        'que', 'como', 'cuando', 'donde', 'quien', 'por', 'para', 'con', 'sin', 'sobre',
        'hasta', 'desde', 'hola', 'bueno', 'todo', 'algo', 'nada', 'muy', 'pero', 'porque',
        'esto', 'eso', 'dime', 'necesito', 'saber', 'quiero', 'hay', 'una', 'uno'
    ]);
    const detectedNames = [...new Set(
        [...String(queryText || '').matchAll(nameRegex)]
            .map(match => match[1])
            .filter(name => !stopWords.has(normalizeComparableText(name)) && name.length > 2)
    )];

    if (detectedNames.length > 0) {
        try {
            const knownNamePool = new Set();
            const { data: soulRow } = await supabase
                .from('user_souls')
                .select('soul_json')
                .eq('client_id', clientId)
                .single();

            const network = soulRow?.soul_json?.network || {};
            for (const key of Object.keys(network)) {
                if (key) knownNamePool.add(key);
            }

            const { data: personaNodes } = await supabase
                .from('knowledge_nodes')
                .select('entity_name')
                .eq('client_id', clientId)
                .in('stability_tier', ['provisional', 'stable'])
                .eq('entity_type', 'PERSONA');
            for (const node of (personaNodes || [])) {
                if (node.entity_name) knownNamePool.add(node.entity_name);
            }

            const { data: contactPersonas } = await supabase
                .from('contact_personas')
                .select('display_name')
                .eq('client_id', clientId);
            for (const persona of (contactPersonas || [])) {
                if (persona.display_name) knownNamePool.add(persona.display_name);
            }

            const { data: senderData } = await supabase
                .from('user_memories')
                .select('sender')
                .eq('client_id', clientId);
            for (const senderRow of (senderData || [])) {
                if (senderRow.sender) knownNamePool.add(senderRow.sender);
            }

            if (redisClient) {
                try {
                    const pattern = `contacts:${clientId}:*`;
                    let cursor = 0;
                    do {
                        const result = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 200 });
                        cursor = result.cursor;
                        for (const contactKey of result.keys) {
                            const contactData = await redisClient.get(contactKey);
                            if (!contactData) continue;
                            try {
                                const parsed = JSON.parse(contactData);
                                if (parsed.name) knownNamePool.add(parsed.name);
                            } catch (e) {
                                if (contactData.length < 80) knownNamePool.add(contactData);
                            }
                        }
                    } while (cursor !== 0);
                } catch (e) {
                    console.warn('[Redis Contacts] Error:', e.message);
                }
            }

            const expandedNames = expandDetectedNamesConservatively(detectedNames, [...knownNamePool]);
            const nameList = [...new Set(
                expandedNames
                    .map(name => normalizeEntityName(name) || String(name || '').trim())
                    .filter(Boolean)
            )].slice(0, 20);

            if (nameList.length > 0) {
                const { data: senderMatches } = await supabase
                    .from('user_memories')
                    .select('id, content, sender, metadata, created_at')
                    .eq('client_id', clientId)
                    .in('sender', nameList)
                    .order('created_at', { ascending: false })
                    .limit(20);

                for (const senderMatch of (senderMatches || [])) {
                    if (!results.some(result => result.id === senderMatch.id)) {
                        results.push({
                            ...senderMatch,
                            similarity: 0.95,
                            source: 'SENDER_BATCH',
                            timestamp: senderMatch.created_at || senderMatch.metadata?.date || null
                        });
                    }
                }

                const primaryExactName = nameList.find(name => normalizeComparableText(name) === normalizeComparableText(detectedNames[0]));
                if (results.length < 5 && primaryExactName && primaryExactName.includes(' ') && primaryExactName.length >= 5) {
                    const { data: softMatches } = await supabase
                        .from('user_memories')
                        .select('id, content, sender, metadata, created_at')
                        .eq('client_id', clientId)
                        .ilike('content', `%${primaryExactName}%`)
                        .limit(10);

                    for (const softMatch of (softMatches || [])) {
                        if (!results.some(result => result.id === softMatch.id)) {
                            results.push({
                                ...softMatch,
                                similarity: 0.8,
                                source: 'CONTENT_PRIMARY_MATCH',
                                timestamp: softMatch.created_at || softMatch.metadata?.date || null
                            });
                        }
                    }
                }
            }
            console.log(`[Name Filter] Busqueda finalizada. Resultados: ${results.length}`);
        } catch (e) {
            console.warn('[Name Resolution] Error:', e.message);
        }
    }

    try {
        const { data: communities } = await supabase
            .from('knowledge_communities')
            .select('community_name, temporal_horizon, summary')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(3);

        if (communities && communities.length > 0) {
            for (const comm of communities) {
                results.push({
                    content: `[MACRO-COMUNIDAD: ${comm.community_name} | EPOCA: ${comm.temporal_horizon}]\nRESUMEN GLOBAL: ${comm.summary}`,
                    sender: 'SYSTEM_MACRO_GRAPH',
                    similarity: 0.95,
                    source: 'COMMUNITY_SUMMARY'
                });
            }
        }
    } catch (e) {
        console.warn('[Graph Service] Fallo al recuperar comunidades:', e.message);
    }

    return results;
}

/**
 * NEW: Unified Relational Retrieval for Neural Brain (2026).
 * Combines nodes, edges, and community summaries into a single enriched structure.
 */
export async function getEnrichedGraphContext(clientId, queryText, queryVector, options = {}) {
    console.log(`[NeuralGraph] Building enriched relational context for: "${queryText.substring(0, 30)}..."`);
    
    // 1. Keyword extraction (simple) to improve graph hits
    const keywords = queryText.split(/\s+/)
        .map(w => w.replace(/[.,!?()[\]{}]/g, ''))
        .filter(w => w.length > 3 && !['quien', 'como', 'cuando', 'donde', 'porque', 'para', 'tiene', 'esta', 'este', 'esta'].includes(w.toLowerCase()));
    
    // 2. Concurrent fetching of all relational assets
    let [nodes, communities, facts] = await Promise.all([
        supabase.rpc('search_knowledge_nodes_v2', { 
            cid: clientId, 
            query: keywords.length ? keywords.join(' ') : queryText,
            lim: 15
        }).then(r => r.data || []),
        supabase.from('knowledge_communities')
            .select('community_name, summary, temporal_horizon')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(3)
            .then(r => r.data || []),
        // Retrieve explicit facts using keywords
        exactEntityFactSearch(clientId, keywords.length ? keywords : [queryText], 10).catch(() => [])
    ]);

    // 2b. Fallback: If no nodes found with combined keywords, try top keywords individually
    if (nodes.length < 3 && keywords.length > 1) {
        console.log(`[NeuralGraph] Low node hits (${nodes.length}). Trying fallback individual keywords...`);
        const individualPromises = keywords.slice(0, 3).map(kw => 
            supabase.rpc('search_knowledge_nodes_v2', { cid: clientId, query: kw, lim: 5 }).then(r => r.data || [])
        );
        const individualResults = await Promise.all(individualPromises);
        const allNewNodes = individualResults.flat();
        
        // Merge and unique
        const seenNodes = new Set(nodes.map(n => n.id));
        for (const n of allNewNodes) {
            if (!seenNodes.has(n.id)) {
                nodes.push(n);
                seenNodes.add(n.id);
            }
        }
    }

    // 2. Extract neighbor edges for the top nodes to build local context
    let edges = [];
    if (nodes.length > 0) {
        const topNodeNames = nodes.slice(0, 5).map(n => n.entity_name);
        const { data: edgeData } = await supabase
            .from('knowledge_edges')
            .select('source_node, target_node, relation_type, context')
            .eq('client_id', clientId)
            .in('stability_tier', ['stable', 'provisional'])
            .or(`source_node.in.(${topNodeNames.map(n => `"${n}"`).join(',')}),target_node.in.(${topNodeNames.map(n => `"${n}"`).join(',')})`)
            .limit(15);
        edges = edgeData || [];
    }

    return {
        nodes,
        edges,
        communities,
        facts,
        unified_prompt_segment: formatEnrichedPrompt(nodes, edges, communities, facts)
    };
}

function formatEnrichedPrompt(nodes, edges, communities, facts) {
    const communityPart = communities.length 
        ? `### ÁREAS DE VIDA (COMMUNITIES)\n${communities.map(c => `- ${c.community_name}: ${c.summary}`).join('\n')}`
        : '';
    
    const nodePart = nodes.length
        ? `### ENTIDADES RELEVANTES\n${nodes.map(n => `- ${n.entity_name} (${n.entity_type}): ${n.description}`).join('\n')}`
        : '';
        
    const edgePart = edges.length
        ? `### RELACIONES DETECTADAS\n${edges.map(e => `- ${e.source_node} --[${e.relation_type}]--> ${e.target_node} (${e.context || 'Sin contexto'})`).join('\n')}`
        : '';

    const factPart = facts.length
        ? `### HECHOS CONFIRMADOS\n${facts.map(f => `- ${f.evidence_text}`).join('\n')}`
        : '';

    return [communityPart, nodePart, edgePart, factPart].filter(Boolean).join('\n\n');
}
