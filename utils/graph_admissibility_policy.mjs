import { normalizeComparableText } from './message_guard.mjs';
import { looksHumanIdentityLabel } from './identity_policy.mjs';

const WEAK_ENTITY_DESCRIPTIONS = new Set([
    'participante del chat',
    'participante',
    'debatido en la conversacion',
    'mencionado en la conversacion',
    'comunicacion en el chat',
    'fenomeno meteorologico',
    'evento climatico',
    'lugar de descanso'
]);

const WEAK_ENTITY_DESCRIPTION_PATTERNS = [
    /^lugar\b/,
    /^objeto\b/,
    /^tema\b/,
    /^asunto\b/,
    /^evento\b/,
    /^mascota\b/,
    /^animal\b/,
    /^fenomeno\b/,
    /^sitio\b/
];

const WEAK_PERSON_DESCRIPTION_PATTERNS = [
    /^interlocutor\b/,
    /^usuario del chat\b/,
    /^mencionado en la conversacion\b/,
    /^persona que\b/,
    /^(hijo|hija|hermano|hermana|novio|novia|pareja|amigo|amiga)\b/
];

const WEAK_RELATIONSHIP_CONTEXTS = new Set([
    'conversacion',
    'chat',
    'mensaje',
    'mensajes',
    'hablan',
    'comentario'
]);

const GENERIC_ENTITY_TYPES = new Set([
    'LUGAR',
    'ORGANIZACION',
    'EVENTO',
    'TEMA',
    'ENTITY',
    'OBJETO'
]);

const ROLE_MENTION_PERSON_PATTERNS = [
    /^(mi|mis|su|sus|tu|tus|nuestro|nuestra|nuestros|nuestras)\s+/i
];

export function compactDigits(value) {
    return String(value || '').replace(/[^\d]/g, '');
}

export function isPhoneLikeGraphName(value) {
    return compactDigits(value).length >= 7;
}

export function hasLeadingArticleName(value) {
    return /^(el|la|los|las|un|una)\s+/i.test(String(value || '').trim());
}

export function hasLowercaseArticleEntityShape(value) {
    return /^(el|la|los|las|un|una)\s+[a-záéíóúñ]/.test(String(value || '').trim());
}

export function isWeakEntityDescription(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) return true;
    if (WEAK_ENTITY_DESCRIPTIONS.has(normalized)) return true;
    return WEAK_ENTITY_DESCRIPTION_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isWeakPersonDescription(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) return true;
    return WEAK_PERSON_DESCRIPTION_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isWeakRelationshipContext(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) return true;
    return WEAK_RELATIONSHIP_CONTEXTS.has(normalized);
}

function hasKnownName(knownNames, normalizedName) {
    if (!normalizedName || !knownNames) return false;
    if (knownNames instanceof Map) return knownNames.has(normalizedName);
    if (knownNames instanceof Set) return knownNames.has(normalizedName);
    if (Array.isArray(knownNames)) return knownNames.map(normalizeComparableText).includes(normalizedName);
    return false;
}

function countNormalizedOccurrences(haystack, needle) {
    const normalizedHaystack = normalizeComparableText(haystack);
    const normalizedNeedle = normalizeComparableText(needle);
    if (!normalizedHaystack || !normalizedNeedle) return 0;

    let count = 0;
    let cursor = 0;
    while (cursor >= 0) {
        const next = normalizedHaystack.indexOf(normalizedNeedle, cursor);
        if (next < 0) break;
        count += 1;
        cursor = next + normalizedNeedle.length;
    }
    return count;
}

export function evaluateEntityAdmissibility({
    name,
    type,
    desc,
    evidence,
    knownNames,
    remoteId,
    isGroup = false,
    chunkText = '',
    groundedBySpeaker = false,
    groundedByEvidence = false,
    groundedByMention = false,
    requireStrongAnchor = true
}) {
    const normalizedName = normalizeComparableText(name);
    const entityType = String(type || '').trim().toUpperCase();
    const descriptionText = desc || evidence || '';
    const known = hasKnownName(knownNames, normalizedName);
    const mentionCount = countNormalizedOccurrences(chunkText, name);
    let score = 0;

    if (!normalizedName) {
        return { allowed: false, reason: 'empty_name', score, mentionCount };
    }

    if (isPhoneLikeGraphName(name)) {
        if (entityType === 'PERSONA' && !known) {
            return { allowed: false, reason: 'phone_like_person_without_anchor', score: -6, mentionCount };
        }
        if (isGroup && compactDigits(remoteId) !== compactDigits(name)) {
            return { allowed: false, reason: 'group_phone_without_remote_match', score: -6, mentionCount };
        }
    }

    if (known) score += 6;
    if (groundedBySpeaker) score += 4;
    if (groundedByEvidence) score += 3;
    if (groundedByMention) score += 1;
    if (mentionCount >= 2) score += 1;

    if (known) {
        return { allowed: true, reason: 'known_anchor', score, mentionCount };
    }

    if (
        entityType === 'PERSONA'
        && ROLE_MENTION_PERSON_PATTERNS.some(pattern => pattern.test(String(name || '').trim()))
    ) {
        return { allowed: false, reason: 'role_mention_person', score: score - 6, mentionCount };
    }

    if (
        entityType === 'PERSONA'
        && !looksHumanIdentityLabel(name)
        && !groundedBySpeaker
        && (
            isWeakPersonDescription(descriptionText)
            || (!groundedByEvidence && mentionCount < 2)
        )
    ) {
        return { allowed: false, reason: 'weak_non_human_person', score: score - 4, mentionCount };
    }

    if (
        entityType === 'PERSONA'
        && hasLeadingArticleName(name)
        && (
            hasLowercaseArticleEntityShape(name)
            || isWeakPersonDescription(descriptionText)
            || isWeakEntityDescription(descriptionText)
        )
    ) {
        return { allowed: false, reason: 'weak_article_person', score: score - 5, mentionCount };
    }

    if (
        GENERIC_ENTITY_TYPES.has(entityType)
        && hasLeadingArticleName(name)
        && (
            isWeakEntityDescription(descriptionText)
            || hasLowercaseArticleEntityShape(name)
        )
    ) {
        return { allowed: false, reason: 'weak_article_entity', score: score - 5, mentionCount };
    }

    if (requireStrongAnchor && !groundedBySpeaker && !groundedByEvidence && mentionCount < 2) {
        return { allowed: false, reason: 'single_unanchored_mention', score, mentionCount };
    }

    return {
        allowed: !requireStrongAnchor || score >= 2,
        reason: (!requireStrongAnchor || score >= 2) ? 'grounded' : 'insufficient_anchor_score',
        score,
        mentionCount
    };
}

export function evaluateRelationshipAdmissibility({
    relationType,
    sourceEntity,
    targetEntity,
    evidence,
    context,
    knownNames,
    remoteId,
    isGroup = false
}) {
    const normalizedRelationType = String(relationType || '').trim();
    if (!normalizedRelationType) {
        return { allowed: false, reason: 'missing_relation_type' };
    }

    if (normalizedRelationType !== '[HABLA_DE]') {
        return { allowed: true, reason: 'not_talks_about' };
    }

    if (isPhoneLikeGraphName(targetEntity?.name)) {
        return { allowed: false, reason: 'phone_like_talk_target' };
    }

    const targetCheck = evaluateEntityAdmissibility({
        name: targetEntity?.name,
        type: targetEntity?.type,
        desc: targetEntity?.desc,
        evidence,
        knownNames,
        remoteId,
        isGroup
    });

    if (!targetCheck.allowed && (isGroup || isWeakRelationshipContext(context))) {
        return { allowed: false, reason: `weak_talk_target:${targetCheck.reason}` };
    }

    if (
        isGroup
        && String(sourceEntity?.type || '').trim().toUpperCase() === 'GRUPO'
        && String(targetEntity?.type || '').trim().toUpperCase() === 'PERSONA'
    ) {
        return { allowed: false, reason: 'group_to_person_talks_about' };
    }

    return { allowed: true, reason: 'grounded' };
}
