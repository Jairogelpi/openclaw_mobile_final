import {
    fallbackNameFromRemoteId,
    looksLikeWhatsAppRemoteId,
    normalizeComparableText,
    pickBestHumanName,
    stripDecorativeText
} from './message_guard.mjs';

const STRONG_SELF_MARKERS = new Set([
    'user sent',
    'user_sent',
    'yo',
    'me',
    'mi clon (yo)',
    'usuario principal'
]);

const LOW_VALUE_IDENTITY_ALIASES = new Set([
    '',
    'assistant',
    'asistente',
    'system',
    'system test',
    'system_test',
    'contacto',
    'usuario',
    'usuario principal',
    'user sent',
    'user_sent',
    'yo',
    'me',
    'anonimo',
    'anónimo',
    'unknown',
    'desconocido'
]);

const GROUP_LABEL_STOPWORDS = new Set([
    'grupo',
    'chat',
    'familia',
    'casa',
    'master',
    'máster',
    'info',
    'controles',
    'radares'
]);

export function normalizeIdentityName(value) {
    const cleaned = stripDecorativeText(String(value || ''))
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return null;
    return {
        canonical: cleaned,
        normalized: normalizeComparableText(cleaned)
    };
}

function isStrongSelfMarker(value) {
    return STRONG_SELF_MARKERS.has(normalizeComparableText(value));
}

function isLowValueIdentityAlias(value) {
    const raw = String(value || '').trim();
    const normalized = normalizeComparableText(raw);
    if (!normalized) return true;
    if (LOW_VALUE_IDENTITY_ALIASES.has(normalized)) return true;
    if (/^\d{6,}$/.test(normalized)) return true;
    if (/^[\d\s+()_-]{6,}$/.test(raw)) return true;
    if (/^\d[\d\s-]{5,}$/.test(raw)) return true;
    if (normalized.includes('@')) return true;
    return false;
}

export function isLikelyGroupConversation(remoteId) {
    return String(remoteId || '').endsWith('@g.us');
}

export function isLikelyGroupLabel(value) {
    const raw = stripDecorativeText(String(value || '')).trim();
    const normalized = normalizeComparableText(raw);
    if (!normalized) return true;
    if (GROUP_LABEL_STOPWORDS.has(normalized)) return true;
    const tokens = normalized.split(' ').filter(Boolean);
    const stopwordHits = tokens.filter(token => GROUP_LABEL_STOPWORDS.has(token)).length;
    if (stopwordHits >= 2) return true;
    if (stopwordHits >= 1 && tokens.length >= 2) return true;
    if (normalized.length > 20 && normalized.split(' ').length >= 3) return true;
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
}

export function looksHumanIdentityLabel(value) {
    const raw = stripDecorativeText(String(value || '')).trim();
    const normalized = normalizeComparableText(raw);
    if (!normalized) return false;
    if (isLowValueIdentityAlias(raw)) return false;
    if (looksLikeWhatsAppRemoteId(raw)) return false;
    if (/^\d{6,}$/.test(normalized)) return false;

    const tokens = normalized
        .split(' ')
        .map(token => token.trim())
        .filter(Boolean);

    if (!tokens.length || tokens.length > 4) return false;
    if (tokens.some(token => GROUP_LABEL_STOPWORDS.has(token))) return false;

    const alphaTokens = tokens.filter(token => /[a-záéíóúñ]/i.test(token));
    if (!alphaTokens.length) return false;

    return alphaTokens.every(token =>
        token.length >= 2 || ['de', 'del', 'la', 'el', 'y'].includes(token)
    );
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
