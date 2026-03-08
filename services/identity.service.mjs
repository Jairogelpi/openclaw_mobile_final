import supabase from '../config/supabase.mjs';
import {
    fallbackNameFromRemoteId,
    looksLikeWhatsAppRemoteId,
    normalizeComparableText,
    pickBestHumanName,
    stripDecorativeText
} from '../utils/message_guard.mjs';

const REGISTRY_TTL_MS = 5 * 60 * 1000;
const registryCache = new Map();
const identityRowsCache = new Map();
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

function isLikelyGroupConversation(remoteId) {
    return String(remoteId || '').endsWith('@g.us');
}

function isLikelyGroupLabel(value) {
    const raw = stripDecorativeText(String(value || '')).trim();
    const normalized = normalizeComparableText(raw);
    if (!normalized) return true;
    if (GROUP_LABEL_STOPWORDS.has(normalized)) return true;
    if (normalized.length > 20 && normalized.split(' ').length >= 3) return true;
    if (/^[.〰️\-_ ]+$/.test(raw)) return true;
    return false;
}

function buildRawIdentitySignal(message) {
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

function sanitizeIdentityAliases(values = [], preserve = []) {
    const preserved = new Set(
        preserve
            .map(value => normalizeComparableText(value))
            .filter(Boolean)
    );

    return mergeAliases(values)
        .filter(alias => {
            const normalized = normalizeComparableText(alias);
            if (preserved.has(normalized)) return true;
            return !isLowValueIdentityAlias(alias);
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

function addScoredName(scores, value, weight = 1) {
    const normalized = normalizeIdentityName(value);
    if (!normalized || isLowValueIdentityAlias(normalized.canonical)) return;
    const current = scores.get(normalized.normalized) || { canonical: normalized.canonical, score: 0 };
    const canonical = normalized.canonical.length > current.canonical.length ? normalized.canonical : current.canonical;
    scores.set(normalized.normalized, {
        canonical,
        score: current.score + weight
    });
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

function isOwnerIdentityRow(row) {
    return Boolean(row?.remote_id === 'self' || row?.source_details?.owner_identity);
}

function looksHumanIdentityLabel(value) {
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
    return sanitizeIdentityAliases(merged, canonical ? [canonical] : []);
}

function buildAliasOwnershipMap(rows = []) {
    const ownership = new Map();

    for (const row of rows) {
        const remoteId = String(row?.remote_id || '').trim();
        if (!remoteId) continue;

        for (const alias of buildIdentityAliasSet(row)) {
            const normalized = normalizeComparableText(alias);
            if (!normalized) continue;
            if (!ownership.has(normalized)) ownership.set(normalized, new Set());
            ownership.get(normalized).add(remoteId);
        }
    }

    return ownership;
}

function scoreIdentityRowForName(row, requestedName, aliasOwnership) {
    const requested = normalizeIdentityName(requestedName);
    if (!requested?.normalized) return null;

    const aliases = buildIdentityAliasSet(row);
    const canonical = normalizeIdentityName(row?.canonical_name);
    const canonicalNormalized = canonical?.normalized || '';
    const aliasNormalizedSet = new Set(aliases.map(alias => normalizeComparableText(alias)).filter(Boolean));
    const matched = aliasNormalizedSet.has(requested.normalized);
    if (!matched) return null;

    const owner = isOwnerIdentityRow(row);
    const group = isLikelyGroupConversation(row?.remote_id);
    const queryLooksHuman = looksHumanIdentityLabel(requested.canonical);
    const canonicalLooksHuman = looksHumanIdentityLabel(canonical?.canonical || '');
    const canonicalExact = canonicalNormalized === requested.normalized;
    const aliasOwners = aliasOwnership.get(requested.normalized) || new Set();
    const ambiguousAlias = aliasOwners.size > 1;

    let score = canonicalExact ? 120 : 70;
    if (owner) score += 20;
    if (canonicalLooksHuman) score += 8;
    if (queryLooksHuman && !canonicalLooksHuman && !canonicalExact) score -= 45;
    if (group) score -= 25;
    if (ambiguousAlias && !canonicalExact && !owner) score -= 35;
    score += Number(row?.confidence || 0) * 10;
    score += Math.min((canonical?.canonical || '').length, 24) / 24;

    return {
        row: {
            ...row,
            aliases
        },
        aliases,
        canonicalExact,
        owner,
        ambiguousAlias,
        score,
        matchedName: requested.canonical,
        queryLooksHuman,
        canonicalLooksHuman
    };
}

function cloneIdentityRows(rows = []) {
    return (rows || []).map(row => ({
        ...row,
        aliases: Array.isArray(row.aliases) ? [...row.aliases] : row.aliases,
        source_details: row.source_details ? { ...row.source_details } : row.source_details
    }));
}

function sanitizeIdentityRow(row) {
    if (!row) return row;

    const canonical = normalizeIdentityName(row.canonical_name)?.canonical || row.canonical_name || null;
    const aliases = buildIdentityAliasSet({
        ...row,
        canonical_name: canonical
    });

    return {
        ...row,
        canonical_name: canonical || row.canonical_name,
        normalized_name: normalizeComparableText(canonical || row.canonical_name || ''),
        aliases
    };
}

function setIdentityRowsCache(clientId, rows = []) {
    identityRowsCache.set(clientId, {
        at: Date.now(),
        rows: cloneIdentityRows(rows)
    });
}

function invalidateIdentityCache(clientId) {
    registryCache.delete(clientId);
    identityRowsCache.delete(clientId);
}

export async function upsertContactIdentity(clientId, remoteId, canonicalName, aliases = [], confidence = 0.75, sourceDetails = {}) {
    let normalized = normalizeIdentityName(canonicalName || fallbackNameFromRemoteId(remoteId));
    if (!clientId || !remoteId || !normalized) return null;

    try {
        const { data: existing } = await supabase
            .from('contact_identities')
            .select('id, aliases, confidence, source_details')
            .eq('client_id', clientId)
            .eq('remote_id', remoteId)
            .maybeSingle();

        const selfSignal = Boolean(
            existing?.source_details?.owner_identity ||
            sourceDetails?.owner_identity ||
            [...(existing?.aliases || []), ...aliases].some(isStrongSelfMarker)
        );
        const ownerPreferredName = sourceDetails?.owner_preferred_name || existing?.source_details?.owner_preferred_name || null;
        if (selfSignal && ownerPreferredName) {
            normalized = normalizeIdentityName(ownerPreferredName) || normalized;
        }

        const rawAliasList = mergeAliases(
            [normalized.canonical],
            existing?.aliases || [],
            aliases,
            [fallbackNameFromRemoteId(remoteId)]
        );
        const nextAliases = selfSignal
            ? sanitizeOwnerIdentityAliases(ownerPreferredName || normalized.canonical)
            : (isLikelyGroupConversation(remoteId)
                ? sanitizeGroupIdentityAliases(normalized.canonical, rawAliasList)
                : sanitizeIdentityAliases(rawAliasList, [normalized.canonical]));
        const nextConfidence = Math.max(Number(existing?.confidence || 0), Number(confidence || 0));
        const nextSourceDetails = {
            ...(existing?.source_details || {}),
            ...(sourceDetails || {}),
            ...(selfSignal ? {
                owner_identity: true,
                owner_preferred_name: ownerPreferredName || normalized.canonical
            } : {})
        };

        const payload = {
            client_id: clientId,
            remote_id: remoteId,
            canonical_name: normalized.canonical,
            normalized_name: normalized.normalized,
            aliases: nextAliases,
            confidence: nextConfidence,
            source_details: nextSourceDetails,
            last_verified_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const { data, error } = await supabase
            .from('contact_identities')
            .upsert(payload, { onConflict: 'client_id,remote_id' })
            .select('*')
            .single();

        if (error) throw error;
        const cached = identityRowsCache.get(clientId);
        const sanitizedData = sanitizeIdentityRow(data);
        if (cached?.rows?.length) {
            const nextRows = cached.rows.filter(row => row.remote_id !== remoteId);
            nextRows.push(sanitizedData);
            setIdentityRowsCache(clientId, nextRows);
        } else {
            invalidateIdentityCache(clientId);
        }
        registryCache.set(clientId, Date.now());
        return sanitizedData;
    } catch (error) {
        console.warn('[Identity Registry] Upsert skipped:', error.message);
        return null;
    }
}

export async function getPreferredOwnerIdentity(clientId) {
    const scores = new Map();
    const aliases = new Set();
    const remoteIds = new Set();

    try {
        const { data: soulRow } = await supabase
            .from('user_souls')
            .select('soul_json')
            .eq('client_id', clientId)
            .maybeSingle();

        for (const candidate of [
            soulRow?.soul_json?.nombre,
            soulRow?.soul_json?.profile?.name,
            soulRow?.soul_json?.profile?.nombre
        ]) {
            addScoredName(scores, candidate, 6);
            if (candidate && !isLowValueIdentityAlias(candidate)) aliases.add(candidate);
        }
    } catch (error) {
        console.warn('[Identity Registry] owner soul read skipped:', error.message);
    }

    const rows = await getIdentityRows(clientId);
    const ownerLikeRows = rows.filter(row =>
        row?.source_details?.owner_identity ||
        (row.aliases || []).some(isStrongSelfMarker)
    );

    for (const row of ownerLikeRows) {
        remoteIds.add(row.remote_id);
        addScoredName(scores, row.canonical_name, 4);
        for (const alias of (row.aliases || [])) {
            addScoredName(scores, alias, isStrongSelfMarker(alias) ? 0 : 3);
            if (!isLowValueIdentityAlias(alias)) aliases.add(alias);
        }
        if (row?.source_details?.owner_preferred_name) {
            addScoredName(scores, row.source_details.owner_preferred_name, 8);
            aliases.add(row.source_details.owner_preferred_name);
        }
    }

    const preferred = [...scores.values()]
        .sort((a, b) => b.score - a.score || b.canonical.length - a.canonical.length)[0]?.canonical || null;

    if (preferred) aliases.add(preferred);

    return {
        canonicalName: preferred,
        aliases: [...aliases],
        remoteIds: [...remoteIds]
    };
}

export async function repairOwnerIdentity(clientId, preferredName = null) {
    await hydrateContactIdentities(clientId);

    const ownerProfile = preferredName
        ? { canonicalName: preferredName, aliases: [preferredName], remoteIds: [] }
        : await getPreferredOwnerIdentity(clientId);

    const normalizedOwner = normalizeIdentityName(ownerProfile.canonicalName);
    if (!normalizedOwner) {
        return { updated: 0, preferredName: null, remoteIds: [] };
    }

    const rows = await getIdentityRows(clientId);
    const targetRows = rows.filter(row => {
        const aliases = row.aliases || [];
        const normalizedCanonical = normalizeComparableText(row.canonical_name);
        const onlyOwnerOrLowValueAliases = aliases.every(alias => {
            const normalizedAlias = normalizeComparableText(alias);
            return !normalizedAlias ||
                normalizedAlias === normalizedOwner.normalized ||
                isLowValueIdentityAlias(alias);
        });

        return Boolean(
            row?.source_details?.owner_identity ||
            aliases.some(isStrongSelfMarker) ||
            (normalizedCanonical === normalizedOwner.normalized && String(row.remote_id || '').endsWith('@lid') && onlyOwnerOrLowValueAliases)
        );
    });

    let updated = 0;
    const remoteIds = new Set(ownerProfile.remoteIds);

    for (const row of targetRows) {
        remoteIds.add(row.remote_id);
        const aliases = sanitizeOwnerIdentityAliases(normalizedOwner.canonical);

        const { error } = await supabase
            .from('contact_identities')
            .update({
                canonical_name: normalizedOwner.canonical,
                normalized_name: normalizedOwner.normalized,
                aliases,
                source_details: {
                    ...(row.source_details || {}),
                    owner_identity: true,
                    owner_preferred_name: normalizedOwner.canonical
                },
                last_verified_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('client_id', clientId)
            .eq('remote_id', row.remote_id);

        if (!error) updated++;
    }

    await upsertContactIdentity(
        clientId,
        'self',
        normalizedOwner.canonical,
        sanitizeOwnerIdentityAliases(normalizedOwner.canonical),
        1,
        {
            owner_identity: true,
            owner_preferred_name: normalizedOwner.canonical,
            repaired_at: new Date().toISOString()
        }
    );

    registryCache.set(clientId, Date.now());
    identityRowsCache.delete(clientId);
    return {
        updated,
        preferredName: normalizedOwner.canonical,
        remoteIds: [...remoteIds]
    };
}

async function collectIdentitySignals(clientId) {
    const signals = [];

    try {
        const { data: personas } = await supabase
            .from('contact_personas')
            .select('remote_id, display_name, persona_json')
            .eq('client_id', clientId);

        for (const persona of (personas || [])) {
            const personaName = pickBestHumanName(
                persona.display_name,
                persona.persona_json?.name,
                persona.persona_json?.display_name
            );
            if (!persona.remote_id || !personaName) continue;
            signals.push({
                remoteId: persona.remote_id,
                canonicalName: personaName,
                aliases: [persona.display_name, persona.persona_json?.name].filter(Boolean),
                confidence: 0.95,
                source: 'contact_personas'
            });
        }
    } catch (error) {
        console.warn('[Identity Registry] contact_personas skipped:', error.message);
    }

    try {
        const { data: rawMessages } = await supabase
            .from('raw_messages')
            .select('remote_id, sender_role, metadata, created_at')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(3000);

        for (const message of (rawMessages || [])) {
            const signal = buildRawIdentitySignal(message);
            if (!signal) continue;
            signals.push(signal);
        }
    } catch (error) {
        console.warn('[Identity Registry] raw_messages skipped:', error.message);
    }

    try {
        const { data: memories } = await supabase
            .from('user_memories')
            .select('sender, metadata, created_at')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(2000);

        for (const memory of (memories || [])) {
            const remoteId = memory.metadata?.remoteId;
            const canonicalName = pickBestHumanName(memory.sender, memory.metadata?.contactName);
            if (!remoteId || !canonicalName) continue;
            signals.push({
                remoteId,
                canonicalName,
                aliases: [memory.sender, memory.metadata?.contactName].filter(Boolean),
                confidence: 0.8,
                source: 'user_memories'
            });
        }
    } catch (error) {
        console.warn('[Identity Registry] user_memories skipped:', error.message);
    }

    return signals;
}

export async function hydrateContactIdentities(clientId, { force = false } = {}) {
    const cachedAt = registryCache.get(clientId);
    const cachedRows = identityRowsCache.get(clientId);
    if (!force && cachedAt && (Date.now() - cachedAt) < REGISTRY_TTL_MS && cachedRows?.rows?.length) {
        return true;
    }

    if (!force) {
        try {
            const { count, error } = await supabase
                .from('contact_identities')
                .select('*', { head: true, count: 'exact' })
                .eq('client_id', clientId);

            if (!error && Number(count || 0) > 0) {
                registryCache.set(clientId, Date.now());
                identityRowsCache.delete(clientId);
                return true;
            }
        } catch (error) {
            console.warn('[Identity Registry] Warm read skipped:', error.message);
        }
    }

    const signals = await collectIdentitySignals(clientId);
    for (const signal of signals) {
        await upsertContactIdentity(
            clientId,
            signal.remoteId,
            signal.canonicalName,
            signal.aliases,
            signal.confidence,
            { [signal.source]: true }
        );
    }

    registryCache.set(clientId, Date.now());
    identityRowsCache.delete(clientId);
    return true;
}

export async function getIdentityRows(clientId) {
    const cached = identityRowsCache.get(clientId);
    if (cached && (Date.now() - cached.at) < REGISTRY_TTL_MS) {
        return cloneIdentityRows(cached.rows);
    }

    try {
        const { data, error } = await supabase
            .from('contact_identities')
            .select('*')
            .eq('client_id', clientId);
        if (error) throw error;
        const rows = (data || []).map(sanitizeIdentityRow);
        setIdentityRowsCache(clientId, rows);
        return cloneIdentityRows(rows);
    } catch (error) {
        console.warn('[Identity Registry] Read skipped:', error.message);
        return [];
    }
}

export async function resolveIdentityCandidates(clientId, names = []) {
    await hydrateContactIdentities(clientId);
    const identityRows = await getIdentityRows(clientId);
    if (!identityRows.length) return [];

    const normalizedNames = (names || [])
        .map(name => normalizeIdentityName(name))
        .filter(Boolean);

    const aliasOwnership = buildAliasOwnershipMap(identityRows);
    const results = [];
    const seenRemoteIds = new Set();

    for (const name of normalizedNames) {
        const scored = identityRows
            .map(row => scoreIdentityRowForName(row, name.canonical, aliasOwnership))
            .filter(Boolean)
            .sort((a, b) =>
                b.score - a.score ||
                Number(b.owner) - Number(a.owner) ||
                Number(b.canonicalExact) - Number(a.canonicalExact) ||
                Number(b.row.confidence || 0) - Number(a.row.confidence || 0)
            );

        if (!scored.length) continue;

        const topCanonical = scored[0].row.canonical_name;
        const canonicalExactMatches = scored.filter(match => match.canonicalExact);
        const uniqueCanonicalExact = [...new Set(canonicalExactMatches.map(match => normalizeComparableText(match.row.canonical_name)))];
        if (uniqueCanonicalExact.length > 1) {
            continue;
        }

        const best = scored[0];
        const competingCanonical = scored.find(match =>
            normalizeComparableText(match.row.canonical_name) !== normalizeComparableText(topCanonical) &&
            (best.score - match.score) < 12
        );

        if (best.ambiguousAlias && !best.canonicalExact && !best.owner) {
            continue;
        }
        if (competingCanonical && !best.canonicalExact && !best.owner) {
            continue;
        }
        if (best.queryLooksHuman && !best.canonicalLooksHuman && !best.canonicalExact && !best.owner) {
            continue;
        }

        const remoteId = String(best.row.remote_id || '').trim();
        if (!remoteId || seenRemoteIds.has(remoteId)) continue;
        seenRemoteIds.add(remoteId);
        results.push({
            ...best.row,
            matched_name: best.matchedName,
            match_score: best.score,
            match_type: best.canonicalExact ? 'canonical_exact' : 'alias_exact'
        });
    }

    return results.sort((a, b) =>
        Number(b.match_score || 0) - Number(a.match_score || 0) ||
        Number(Boolean(b.remote_id === 'self' || b.source_details?.owner_identity)) - Number(Boolean(a.remote_id === 'self' || a.source_details?.owner_identity)) ||
        Number(b.confidence || 0) - Number(a.confidence || 0)
    );
}

export async function resolveIdentityNames(clientId, names = []) {
    const rows = await resolveIdentityCandidates(clientId, names);
    const resolved = new Map();

    for (const row of rows) {
        const canonical = row.canonical_name;
        for (const alias of (row.aliases || [])) {
            const normalized = normalizeComparableText(alias);
            if (!resolved.has(normalized)) {
                resolved.set(normalized, {
                    canonicalName: canonical,
                    remoteId: row.remote_id,
                    aliases: row.aliases || []
                });
            }
        }
    }

    return resolved;
}
