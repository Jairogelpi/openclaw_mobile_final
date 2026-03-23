import {
    fallbackNameFromRemoteId,
    looksLikeWhatsAppRemoteId,
    normalizeEntityLikeText,
    normalizeComparableText,
    pickBestHumanName,
    stripDecorativeText
} from './message_guard.mjs';

const ROLE_RELATION_PATTERNS = [
    /^(padrastro|madrastra|padre|madre|hijo|hija|hermano|hermana|novio|novia|pareja|familia)\b/i,
    /^(el|la)\s+(papa|papá|mama|mamá)\b/i
];

/**
 * Level 6: Neural-Native Identity Policy
 * Replaces static stopword lists with dynamic confidence-based checks.
 */
export function isLowValueIdentityAlias(value) {
    const raw = String(value || '').trim();
    if (!raw) return true;
    
    // Technical patterns that are objectively low value (Phone numbers, IDs, URLs)
    if (/^\d{6,}$/.test(raw.replace(/\s+/g, ''))) return true;
    if (raw.includes('@')) return true;
    if (raw.length < 2) return true;
    
    return false;
}

export function normalizeIdentityName(value) {
    const cleaned = normalizeEntityLikeText(String(value || ''))
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return null;
    return {
        canonical: cleaned,
        normalized: normalizeComparableText(cleaned)
    };
}

function isStrongSelfMarker(value) {
    const normalized = normalizeComparableText(value);
    return ['yo', 'me', 'mi clon (yo)', 'usuario principal', 'user_sent', 'self'].includes(normalized);
}


export function isLikelyGroupConversation(remoteId) {
    return String(remoteId || '').endsWith('@g.us');
}

export function isLikelyGroupLabel(value) {
    const raw = normalizeEntityLikeText(String(value || ''));
    const normalized = normalizeComparableText(raw);
    if (!normalized) return true;
    if (GROUP_LABEL_STOPWORDS.has(normalized)) return true;
    const tokens = normalized.split(' ').filter(Boolean);
    const stopwordHits = tokens.filter(token => GROUP_LABEL_STOPWORDS.has(token)).length;
    if (stopwordHits >= 2) return true;
    if (stopwordHits >= 1 && tokens.length >= 2) return true;
    if (/^[.\u3000\ufe0f\-_ ]+$/u.test(raw)) return true;
    return false;
}

function mergeAliases(...aliasSets) {
    const seen = new Map();
    for (const aliasSet of aliasSets) {
        const values = Array.isArray(aliasSet) ? aliasSet : [aliasSet];
        for (const alias of values) {
            const normalized = normalizeIdentityName(alias);
            if (!normalized?.normalized) continue;
            if (!seen.has(normalized.normalized)) {
                seen.set(normalized.normalized, normalized.canonical);
            }
        }
    }
    return [...seen.values()];
}/**
 * Level 6 Generic Name Validator
 * Only rejects strictly technical or empty values.
 * Deferring semantic validation to IdentityService.
 */
export function looksHumanIdentityLabel(value) {
    const raw = String(value || '').trim();
    if (isLowValueIdentityAlias(raw)) return false;
    return raw.length >= 2;
}

export function looksHumanAliasLabel(value) {
    return looksHumanIdentityLabel(value);
}

export function classifyIdentityLikeName(value) {
    const raw = normalizeEntityLikeText(String(value || ''));
    if (!raw) return 'unknown';
    if (ROLE_RELATION_PATTERNS.some(pattern => pattern.test(raw))) return 'role_mention';
    return isLowValueIdentityAlias(raw) ? 'unknown' : 'human_alias';
}

function resolveOwnerPreferredName(remoteId, sourceDetails = {}, canonicalName = null) {
    const candidates = [
        sourceDetails?.owner_preferred_name,
        canonicalName
    ];

    for (const candidate of candidates) {
        const normalized = normalizeIdentityName(candidate);
        if (!normalized?.canonical) continue;
        if (!looksHumanIdentityLabel(normalized.canonical)) continue;
        return normalized.canonical;
    }

    const normalizedCanonical = normalizeIdentityName(canonicalName);
    if (String(remoteId || '').trim() === 'self' && looksHumanIdentityLabel(normalizedCanonical?.canonical || '')) {
        return normalizedCanonical.canonical;
    }

    return null;
}

function hasStrongSelfAliasSignal(values = []) {
    return (values || []).some(isStrongSelfMarker);
}

function shouldPersistOwnerIdentity(remoteId, canonicalName, aliases = [], existingSourceDetails = {}, sourceDetails = {}) {
    const ownerPreferredName = resolveOwnerPreferredName(
        remoteId,
        {
            ...(existingSourceDetails || {}),
            ...(sourceDetails || {})
        },
        canonicalName
    );

    const explicitSelfSignal = Boolean(
        String(remoteId || '').trim() === 'self' ||
        existingSourceDetails?.owner_identity ||
        sourceDetails?.owner_identity ||
        hasStrongSelfAliasSignal(aliases)
    );

    return {
        ownerIdentity: Boolean(explicitSelfSignal && ownerPreferredName),
        ownerPreferredName
    };
}

function sanitizePersonalIdentityAliases(canonicalName, values = [], preserve = []) {
    const normalizedCanonical = normalizeIdentityName(canonicalName);
    const preserved = new Set(
        [
            ...(preserve || []),
            normalizedCanonical?.canonical
        ]
            .map(value => normalizeComparableText(value))
            .filter(Boolean)
    );

    return mergeAliases(values)
        .filter(alias => {
            const normalized = normalizeComparableText(alias);
            if (!normalized) return false;
            if (preserved.has(normalized)) return true;
            if (isLowValueIdentityAlias(alias)) return false;
            if (looksHumanIdentityLabel(normalizedCanonical?.canonical || '') && isLikelyGroupLabel(alias)) return false;
            return true;
        });
}

function sanitizeOwnerIdentityAliases(canonicalName) {
    const normalized = normalizeIdentityName(canonicalName);
    return normalized ? [normalized.canonical] : [];
}

function sanitizeGroupIdentityAliases(canonicalName, values = []) {
    const normalizedCanonical = normalizeIdentityName(canonicalName);
    if (!normalizedCanonical) return [];

    return mergeAliases([normalizedCanonical.canonical], values)
        .filter(alias => {
            const normalized = normalizeComparableText(alias);
            if (!normalized) return false;
            if (normalized === normalizedCanonical.normalized) return true;
            if (isLowValueIdentityAlias(alias)) return false;
            return isLikelyGroupLabel(alias);
        });
}

function isOwnerIdentityRow(row) {
    return Boolean(
        String(row?.remote_id || '').trim() === 'self' ||
        (row?.source_details?.owner_identity && resolveOwnerPreferredName(row?.remote_id, row?.source_details, row?.canonical_name))
    );
}

function buildIdentityAliasSet(row) {
    const canonical = normalizeIdentityName(row?.canonical_name)?.canonical || row?.canonical_name || null;
    const merged = mergeAliases(
        canonical ? [canonical] : [],
        row?.aliases || [],
        (isOwnerIdentityRow(row) || isLikelyGroupConversation(row?.remote_id)) ? [] : [fallbackNameFromRemoteId(row?.remote_id)]
    );

    if (isOwnerIdentityRow(row)) {
        return sanitizeOwnerIdentityAliases(canonical);
    }
    if (isLikelyGroupConversation(row?.remote_id)) {
        return sanitizeGroupIdentityAliases(canonical, merged);
    }
    return sanitizePersonalIdentityAliases(canonical, merged, canonical ? [canonical] : []);
}

export function buildRawIdentitySignal(message) {
    const metadata = message?.metadata || {};
    const isGroup = isLikelyGroupConversation(message?.remote_id);
    const participantRemoteId = String(metadata.participantJid || '').trim();
    const senderRole = String(message?.sender_role || '').trim();
    const canonicalSenderName = String(metadata.canonicalSenderName || '').trim();
    const pushName = String(metadata.pushName || '').trim();
    const conversationName = String(metadata.conversationName || '').trim();

    if (isGroup && !participantRemoteId) {
        return null;
    }

    const remoteId = participantRemoteId || String(message?.remote_id || '').trim();
    if (!remoteId || !looksLikeWhatsAppRemoteId(remoteId)) {
        return null;
    }

    const canonicalName = pickBestHumanName(
        canonicalSenderName,
        pushName,
        senderRole
    );
    if (!canonicalName) return null;

    const aliases = [
        canonicalSenderName,
        pushName,
        senderRole
    ].filter(Boolean);

    if (!isGroup && conversationName && !isLikelyGroupLabel(conversationName)) {
        aliases.push(conversationName);
    }

    return {
        remoteId,
        canonicalName,
        aliases,
        confidence: 0.85,
        source: 'raw_messages'
    };
}

export function sanitizeIdentityRow(row) {
    if (!row) return row;

    const canonical = normalizeIdentityName(row.canonical_name)?.canonical || row.canonical_name || null;
    const ownerState = shouldPersistOwnerIdentity(
        row.remote_id,
        canonical,
        row.aliases || [],
        row.source_details || {},
        {}
    );
    const sourceDetails = {
        ...(row.source_details || {})
    };

    if (ownerState.ownerIdentity) {
        sourceDetails.owner_identity = true;
        sourceDetails.owner_preferred_name = ownerState.ownerPreferredName;
    } else {
        delete sourceDetails.owner_identity;
        delete sourceDetails.owner_preferred_name;
    }

    const aliases = buildIdentityAliasSet({
        ...row,
        canonical_name: canonical,
        source_details: sourceDetails
    });

    return {
        ...row,
        canonical_name: canonical || row.canonical_name,
        normalized_name: normalizeComparableText(canonical || row.canonical_name || ''),
        aliases,
        source_details: sourceDetails
    };
}
