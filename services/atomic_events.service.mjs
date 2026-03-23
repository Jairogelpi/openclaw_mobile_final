import supabase from '../config/supabase.mjs';
import { resolveIdentityCandidates } from './identity.service.mjs';
import {
    fallbackNameFromRemoteId,
    normalizeComparableText,
    resolveStoredSpeakerName,
    stripMediaPlaceholders
} from '../utils/message_guard.mjs';

const TOPIC_RULES = [
    { key: 'music', label: 'musica', pattern: /\b(musica|cancion|canciones|playlist|spotify|tema|temazo|album|rap|trap|reggaeton|concierto)\b/i },
    { key: 'work', label: 'trabajo', pattern: /\b(curro|trabajo|curro|empresa|oficina|jefe|cliente|proyecto|data|reunion|reunion|curro)\b/i },
    { key: 'study', label: 'estudios', pattern: /\b(curso|clase|clases|estudio|estudiar|examen|universidad|instituto|formacion|formacion|asignatura)\b/i },
    { key: 'plans', label: 'planes', pattern: /\b(quedar|quedamos|plan|planes|vernos|venir|vienes|voy|vamos|salir|finde|fin de semana)\b/i },
    { key: 'relationship', label: 'relacion', pattern: /\b(amor|pareja|novio|novia|relacion|amistad|te quiero|te amo|echar de menos|celos)\b/i },
    { key: 'emotion', label: 'emociones', pattern: /\b(triste|pena|ansiedad|agobio|contento|feliz|rayado|rayada|preocupado|preocupada|mal)\b/i },
    { key: 'family', label: 'familia', pattern: /\b(madre|padre|mama|papa|hermano|hermana|familia|primo|prima|abuela|abuelo)\b/i },
    { key: 'health', label: 'salud', pattern: /\b(medico|doctor|hospital|medicina|dolor|enfermo|enferma|ansiedad|terapia)\b/i },
    { key: 'money', label: 'dinero', pattern: /\b(dinero|pagar|pago|euros|cobrar|sueldo|pasta|gasto|gastos)\b/i },
    { key: 'home', label: 'casa', pattern: /\b(casa|piso|dormir|dormi|cama|mudanza|vivir|vive|hogar)\b/i },
    { key: 'food', label: 'comida', pattern: /\b(comer|comida|cena|cenar|desayuno|desayunar|beber|tomar algo|restaurante)\b/i },
    { key: 'travel', label: 'viajes', pattern: /\b(viaje|viajar|tren|avion|coche|pueblo|madrid|barcelona|badajoz|caceres|vacaciones)\b/i }
];

const SPANISH_STOPWORDS = new Set([
    'de', 'la', 'el', 'que', 'y', 'a', 'en', 'me', 'te', 'lo', 'le', 'se', 'no', 'un', 'una',
    'mi', 'tu', 'es', 'ya', 'si', 'pero', 'por', 'con', 'para', 'como', 'mas', 'del', 'al',
    'yo', 'tu', 'esta', 'este', 'eso', 'esa', 'hay', 'porque', 'muy', 'solo', 'solo', 'todo'
]);

function uniqueNormalized(values = []) {
    const seen = new Set();
    const output = [];
    for (const value of values) {
        const raw = String(value || '').trim();
        const normalized = normalizeComparableText(raw);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        output.push(raw);
    }
    return output;
}

function cleanAtomicText(value = '') {
    return String(stripMediaPlaceholders(value) || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function looksLikeWhatsappRemoteId(value = '') {
    const raw = String(value || '').trim();
    return /@s\.whatsapp\.net$|@lid$|@g\.us$/.test(raw);
}

function inferAtomicChannel(message = null) {
    const explicitChannel = normalizeComparableText(message?.channel || '');
    if (explicitChannel) return explicitChannel;
    const metadataChannel = normalizeComparableText(message?.metadata?.channel || '');
    if (metadataChannel) return metadataChannel;
    if (looksLikeWhatsappRemoteId(message?.remote_id) || looksLikeWhatsappRemoteId(message?.participant_jid) || looksLikeWhatsappRemoteId(message?.metadata?.participantJid)) {
        return 'whatsapp';
    }
    if (message?.is_history || message?.metadata?.isHistory || message?.metadata?.timestamp) {
        return 'whatsapp';
    }
    return null;
}

function isWhatsappLikeAtomicRow(row = null) {
    const metadataChannel = normalizeComparableText(row?.source_metadata?.channel || '');
    if (metadataChannel === 'whatsapp') return true;
    if (looksLikeWhatsappRemoteId(row?.remote_id) || looksLikeWhatsappRemoteId(row?.source_metadata?.participantJid)) {
        return true;
    }
    return Boolean(row?.event_timestamp);
}

function detectMediaType(message = null) {
    const explicitType = normalizeComparableText(message?.media_type || '');
    if (explicitType) return explicitType;

    const metadata = message?.metadata || {};
    const payload = metadata.mediaPayload || {};
    if (payload.imageMessage) return 'image';
    if (payload.audioMessage) return 'audio';
    if (payload.videoMessage) return 'video';
    if (payload.documentMessage) return 'document';

    const content = normalizeComparableText(message?.content || '');
    if (/\[(imagen|foto)/.test(content)) return 'image';
    if (/\[(audio|nota de voz)/.test(content)) return 'audio';
    if (/\[(video)/.test(content)) return 'video';
    if (/\[(documento|archivo|pdf)/.test(content)) return 'document';
    return null;
}

function sentenceSplit(text = '') {
    return String(text || '')
        .split(/(?<=[.!?])\s+|\n+/)
        .map(chunk => chunk.trim())
        .filter(Boolean);
}

function extractClaims(text = '') {
    return sentenceSplit(text)
        .map(sentence => sentence.replace(/^[,;:\-]+/, '').trim())
        .filter(Boolean)
        .filter(sentence => sentence.length >= 12)
        .slice(0, 3);
}

function extractTopics(text = '') {
    const normalized = normalizeComparableText(text);
    if (!normalized) return [];

    const directHits = TOPIC_RULES
        .filter(rule => rule.pattern.test(normalized))
        .map(rule => ({
            key: rule.key,
            label: rule.label,
            source: 'rule'
        }));

    if (directHits.length) return directHits;

    const tokens = normalized
        .split(/[^a-z0-9áéíóúñü]+/i)
        .map(token => token.trim())
        .filter(Boolean)
        .filter(token => token.length >= 4)
        .filter(token => !SPANISH_STOPWORDS.has(token))
        .slice(0, 3);

    return tokens.map(token => ({
        key: `kw:${token}`,
        label: token,
        source: 'keyword'
    }));
}

function extractInlineNames(text = '') {
    const matches = [...String(text || '').matchAll(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\b/g)];
    return uniqueNormalized(matches.map(match => match[1])).slice(0, 4);
}

function buildEntities({ speaker = '', contactName = '', directText = '', remoteId = '' } = {}) {
    return uniqueNormalized([
        speaker,
        contactName,
        ...extractInlineNames(directText),
        fallbackNameFromRemoteId(remoteId)
    ]).slice(0, 6);
}

function buildQuotedSpan(message = null, byMessageId = new Map()) {
    const quotedMessageId = String(message?.quoted_message_id || message?.metadata?.quotedMessageId || '').trim();
    if (!quotedMessageId) return null;
    const quoted = byMessageId.get(quotedMessageId);
    const clean = cleanAtomicText(quoted?.semantic_text || quoted?.content || '');
    return clean ? clean.slice(0, 220) : null;
}

function buildAtomicEventRow(message, ownerName, contactName, byMessageId = new Map()) {
    const channel = inferAtomicChannel(message);
    if (channel && channel !== 'whatsapp') return null;

    const sourceText = message?.semantic_text || message?.content || '';
    if (message?.content_ready === false && !message?.semantic_text) return null;

    const directText = cleanAtomicText(sourceText);
    if (!directText) return null;

    const eventTimestamp = message?.event_timestamp || message?.metadata?.timestamp || message?.created_at || null;
    const speaker = resolveStoredSpeakerName(message, ownerName, contactName);
    const normalizedText = normalizeComparableText(directText);
    const entities = buildEntities({
        speaker,
        contactName,
        directText,
        remoteId: message?.remote_id
    });
    const topics = extractTopics(directText);
    const claims = extractClaims(directText);
    const quotedSpan = buildQuotedSpan(message, byMessageId);

    return {
        client_id: String(message?.client_id || '').trim(),
        raw_message_id: String(message?.id || '').trim(),
        message_id: String(message?.source_message_id || message?.metadata?.msgId || '').trim() || null,
        remote_id: String(message?.remote_id || '').trim() || null,
        speaker,
        speaker_role: String(message?.sender_role || '').trim() || null,
        event_timestamp: eventTimestamp,
        reply_to: String(message?.quoted_message_id || message?.metadata?.quotedMessageId || '').trim() || null,
        quoted_span: quotedSpan,
        media_type: detectMediaType(message),
        direct_text: directText,
        normalized_text: normalizedText,
        entities,
        topics,
        claims,
        source_metadata: {
            participantJid: message?.participant_jid || message?.metadata?.participantJid || null,
            canonicalSenderName: message?.canonical_sender_name || message?.metadata?.canonicalSenderName || null,
            conversationName: message?.conversation_name || message?.metadata?.conversationName || null,
            channel: channel || null,
            status: message?.delivery_status || message?.metadata?.status || null
        },
        updated_at: new Date().toISOString()
    };
}

export function deriveAtomicEvents(messages = [], ownerName = null, contactName = null) {
    const byMessageId = new Map(
        (messages || [])
            .map(message => [String(message?.source_message_id || message?.metadata?.msgId || '').trim(), message])
            .filter(([value]) => Boolean(value))
    );

    return (messages || [])
        .map(message => buildAtomicEventRow(message, ownerName, contactName, byMessageId))
        .filter(row => row && row.client_id && row.raw_message_id);
}

export async function persistAtomicEvents({ clientId, remoteId = null, ownerName = null, contactName = null, messages = [] } = {}) {
    const rows = deriveAtomicEvents(
        (messages || []).map(message => ({
            ...message,
            client_id: message?.client_id || clientId,
            remote_id: message?.remote_id || remoteId
        })),
        ownerName,
        contactName
    );

    if (!rows.length) {
        return {
            inserted: 0,
            failedRawMessageIds: []
        };
    }

    const failedRawMessageIds = [];
    let inserted = 0;

    for (let index = 0; index < rows.length; index += 100) {
        const batch = rows.slice(index, index + 100);
        const { error } = await supabase
            .from('atomic_events')
            .upsert(batch, { onConflict: 'client_id,raw_message_id' });

        if (error) {
            failedRawMessageIds.push(...batch.map(row => row.raw_message_id));
            console.warn('[Atomic Events] Persist skipped:', error.message);
            continue;
        }

        inserted += batch.length;
    }

    return {
        inserted,
        failedRawMessageIds
    };
}

async function resolveEntityContext(clientId, entityNames = []) {
    const rawNames = uniqueNormalized(entityNames);
    if (!rawNames.length) {
        return {
            aliases: [],
            normalizedAliases: [],
            remoteIds: [],
            canonicalNames: []
        };
    }

    const resolved = await resolveIdentityCandidates(clientId, rawNames).catch(() => []);
    const aliases = uniqueNormalized([
        ...rawNames,
        ...resolved.map(item => item?.canonical_name),
        ...resolved.flatMap(item => item?.aliases || [])
    ]);

    return {
        aliases,
        normalizedAliases: aliases.map(alias => normalizeComparableText(alias)).filter(Boolean),
        remoteIds: uniqueNormalized(resolved.map(item => item?.remote_id)).filter(Boolean),
        canonicalNames: uniqueNormalized(resolved.map(item => item?.canonical_name)).filter(Boolean)
    };
}

function atomicRowMatchesEntity(row, entityContext) {
    if (!entityContext?.normalizedAliases?.length && !entityContext?.remoteIds?.length) return true;

    const remoteId = String(row?.remote_id || '').trim();
    const speakerHaystack = normalizeComparableText(row?.speaker || '');

    if (entityContext.remoteIds.length) {
        if (entityContext.remoteIds.includes(remoteId)) {
            return true;
        }

        return entityContext.normalizedAliases.some(alias => speakerHaystack.includes(alias));
    }

    const haystack = normalizeComparableText([
        row?.speaker,
        row?.direct_text,
        ...(Array.isArray(row?.entities) ? row.entities : []),
        row?.quoted_span
    ].filter(Boolean).join(' '));

    return entityContext.normalizedAliases.some(alias => haystack.includes(alias));
}

function tokenizeQuery(queryText = '') {
    return normalizeComparableText(queryText)
        .split(/[^a-z0-9áéíóúñü]+/i)
        .map(token => token.trim())
        .filter(Boolean)
        .filter(token => token.length >= 3)
        .filter(token => !SPANISH_STOPWORDS.has(token));
}

function scoreAtomicRow(row, queryTokens = [], plan = null, entityContext = null) {
    const haystack = normalizeComparableText([
        row?.speaker,
        row?.direct_text,
        row?.quoted_span,
        ...(Array.isArray(row?.entities) ? row.entities : []),
        ...(Array.isArray(row?.topics) ? row.topics.map(topic => topic?.label || topic?.key || '') : [])
    ].filter(Boolean).join(' '));

    let score = 0.72;
    const tokenHits = queryTokens.filter(token => haystack.includes(token)).length;
    score += tokenHits * 0.03;

    if (atomicRowMatchesEntity(row, entityContext)) score += 0.08;
    if (row?.quoted_span) score += 0.02;
    if (Array.isArray(row?.topics) && row.topics.length) score += 0.02;

    if (plan?.outbound_focus && normalizeComparableText(row?.speaker_role) === 'user_sent') score += 0.07;
    if (plan?.opinion_focus && normalizeComparableText(row?.speaker_role) !== 'user_sent') score += 0.07;
    if (plan?.idea_focus && /\b(plan|idea|propongo|podemos|seria|sería|montar|hacer)\b/i.test(row?.direct_text || '')) score += 0.06;
    if (plan?.summary_focus) score += 0.04;
    if (plan?.issue_focus && /\b(problema|pena|triste|agobio|preocup|mal|raro|tension)\b/i.test(row?.direct_text || '')) score += 0.06;

    return Number(score.toFixed(4));
}

function toAtomicEventEvidenceCandidate(row, recallScore = 0.82) {
    return {
        source_id: `atomic_event:${row.raw_message_id}`,
        source_kind: 'fact',
        directness: 'direct',
        evidence_text: row.event_timestamp
            ? `${String(row.event_timestamp).slice(0, 10)}: ${row.speaker}: ${row.direct_text}`
            : `${row.speaker}: ${row.direct_text}`,
        speaker: row.speaker || null,
        remote_id: row.remote_id || null,
        timestamp: row.event_timestamp || null,
        metadata: {
            fact_type: 'atomic_event',
            message_id: row.message_id || null,
            raw_message_id: row.raw_message_id || null,
            media_type: row.media_type || null,
            reply_to: row.reply_to || null,
            quoted_span: row.quoted_span || null,
            atomic_entities: Array.isArray(row.entities) ? row.entities : [],
            atomic_topics: Array.isArray(row.topics) ? row.topics : [],
            atomic_claims: Array.isArray(row.claims) ? row.claims : [],
            atomic_channels: ['memory', 'temporal', 'interaction']
        },
        recall_score: recallScore,
        score_rerank: 0,
        final_score: recallScore
    };
}

export async function searchAtomicEventCandidates({ clientId, queryText, plan = null, matchCount = 10 } = {}) {
    const entityContext = await resolveEntityContext(clientId, plan?.entities || []);
    const queryTokens = tokenizeQuery(queryText);

    let query = supabase
        .from('atomic_events')
        .select('*')
        .eq('client_id', clientId)
        .order('event_timestamp', { ascending: false })
        .limit(Math.max(matchCount * 25, 120));

    if (plan?.temporal_window?.start) {
        query = query.gte('event_timestamp', plan.temporal_window.start);
    }
    if (plan?.temporal_window?.end) {
        query = query.lte('event_timestamp', plan.temporal_window.end);
    }

    const { data: rows, error } = await query;
    if (error) {
        console.warn('[Atomic Events] Search skipped:', error.message);
        return [];
    }

    return (rows || [])
        .filter(row => isWhatsappLikeAtomicRow(row))
        .filter(row => atomicRowMatchesEntity(row, entityContext))
        .map(row => ({
            row,
            score: scoreAtomicRow(row, queryTokens, plan, entityContext)
        }))
        .sort((a, b) => b.score - a.score || String(b.row?.event_timestamp || '').localeCompare(String(a.row?.event_timestamp || '')))
        .slice(0, matchCount)
        .map(item => toAtomicEventEvidenceCandidate(item.row, item.score));
}

export async function fetchAtomicEventsForBundle({ clientId, plan = null, limit = 80 } = {}) {
    const entityContext = await resolveEntityContext(clientId, plan?.entities || []);
    let query = supabase
        .from('atomic_events')
        .select('*')
        .eq('client_id', clientId)
        .order('event_timestamp', { ascending: false })
        .limit(Math.max(limit, 40));

    if (plan?.temporal_window?.start) {
        query = query.gte('event_timestamp', plan.temporal_window.start);
    }
    if (plan?.temporal_window?.end) {
        query = query.lte('event_timestamp', plan.temporal_window.end);
    }

    const { data: rows, error } = await query;
    if (error) {
        console.warn('[Atomic Events] Bundle fetch skipped:', error.message);
        return [];
    }

    return (rows || [])
        .filter(row => isWhatsappLikeAtomicRow(row))
        .filter(row => atomicRowMatchesEntity(row, entityContext));
}
