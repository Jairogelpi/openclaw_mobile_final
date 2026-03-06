const GENERIC_SPEAKER_LABELS = new Set([
    '',
    'usuario',
    'usuario principal',
    'contacto',
    'assistant',
    'asistente',
    'system',
    'system test',
    'system_test',
    'historial',
    'persona',
    'interlocutor',
    'anonimo',
    'anónimo',
    'desconocido',
    'unknown',
    'yo',
    'me',
    'mi clon (yo)',
    'openclaw ai'
]);

const BLOCKED_MEMORY_REMOTE_IDS = new Set([
    'terminal-admin',
    'test-terminal',
    'system_test',
    'system-test',
    'user-123',
    'user_sent'
]);

const BOT_TEXT_PATTERNS = [
    /^\[openclaw/i,
    /openclaw ai/i,
    /modo autoconsciencia openclaw/i,
    /tu asistente personal/i,
    /graphrag \+ memoria vectorial/i
];

export function normalizeComparableText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

export function stripDecorativeText(value) {
    return String(value || '')
        .replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u2600-\u27BF]/gu, ' ')
        .replace(/[*_~|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function isGenericSpeakerLabel(value) {
    const normalized = normalizeComparableText(value);
    return !normalized || GENERIC_SPEAKER_LABELS.has(normalized);
}

export function looksLikeWhatsAppRemoteId(remoteId) {
    return /(@s\.whatsapp\.net|@g\.us|@lid|@broadcast)$/i.test(String(remoteId || '').trim());
}

export function fallbackNameFromRemoteId(remoteId) {
    const base = String(remoteId || '').split('@')[0].trim();
    if (!base) return null;
    if (/^\d{5,}$/.test(base)) return base;
    const cleaned = base.replace(/[-_.]+/g, ' ').trim();
    if (!cleaned) return null;
    return cleaned.replace(/\b[a-z]/gi, match => match.toUpperCase());
}

export function pickBestHumanName(...candidates) {
    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (!value) continue;
        if (isGenericSpeakerLabel(value)) continue;
        return value;
    }
    return null;
}

export function deriveOwnerNameFromSlug(slug) {
    const parts = String(slug || '')
        .split('-')
        .filter(Boolean);

    if (!parts.length) return null;

    if (parts.length > 1 && /[0-9]/.test(parts[parts.length - 1])) {
        parts.pop();
    }

    const candidate = parts.join(' ').trim();
    if (!candidate) return null;
    return candidate.replace(/\b[a-z]/gi, match => match.toUpperCase());
}

export function stripMediaPlaceholders(text) {
    return String(text || '')
        .replace(/\[(audio|imagen|video|sticker|documento|media)(:\s*.*?)?\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function looksLikeBotText(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    return BOT_TEXT_PATTERNS.some(pattern => pattern.test(value));
}

export function isAssistantLikeRawMessage(message) {
    const senderRole = normalizeComparableText(message?.sender_role);
    const metadata = message?.metadata || {};
    const generatedBy = normalizeComparableText(metadata.generated_by || metadata.generatedBy);
    const source = normalizeComparableText(metadata.source);
    const channel = normalizeComparableText(metadata.channel);

    if (metadata.exclude_from_memory === true) return true;
    if (senderRole === 'assistant') return true;
    if (metadata.proactive || metadata.fast_path || metadata.assistant_echo) return true;
    if (metadata.reflection_approved !== undefined || metadata.reflection_attempts !== undefined) return true;
    if (['core_engine', 'pulse_worker', 'welcome_message', 'assistant'].includes(generatedBy)) return true;
    if (['onboarding', 'terminal', 'admin', 'system_test', 'assistant'].includes(source)) return true;
    if (channel && channel !== 'whatsapp') return true;
    if (senderRole === 'user_sent' && looksLikeBotText(message?.content)) return true;

    return false;
}

export function isMemoryEligibleRawMessage(message) {
    if (!message) return false;

    const metadata = message.metadata || {};
    const remoteId = String(message.remote_id || '').trim();
    const channel = normalizeComparableText(metadata.channel);
    const source = normalizeComparableText(metadata.source);
    const normalizedRemoteId = normalizeComparableText(remoteId);
    const hasContent = Boolean(stripMediaPlaceholders(message.content)) || metadata.hasMedia || metadata.mediaPayload;

    if (!hasContent) return false;
    if (metadata.allow_memory === true) return true;
    if (isAssistantLikeRawMessage(message)) return false;
    if (BLOCKED_MEMORY_REMOTE_IDS.has(normalizedRemoteId)) return false;
    if (['terminal', 'admin', 'system_test', 'onboarding'].includes(source)) return false;

    if (channel && channel !== 'whatsapp') return false;
    if (!channel && !looksLikeWhatsAppRemoteId(remoteId)) return false;

    return true;
}

export function resolveStoredSpeakerName(message, ownerName, fallbackContactName = null) {
    const metadata = message?.metadata || {};
    const senderRole = normalizeComparableText(message?.sender_role);

    if (['user_sent', 'usuario', 'usuario principal', 'yo', 'me'].includes(senderRole)) {
        return ownerName || 'Yo';
    }

    return pickBestHumanName(
        metadata.canonicalSenderName,
        metadata.contactName,
        message?.sender_role,
        metadata.pushName,
        fallbackContactName,
        fallbackNameFromRemoteId(metadata.participantJid || message?.remote_id)
    ) || ownerName || fallbackNameFromRemoteId(message?.remote_id) || 'Participante';
}

export function renderConversationLine(message, ownerName, fallbackContactName = null) {
    const cleanContent = stripMediaPlaceholders(message?.content);
    if (!cleanContent) return null;

    const speaker = resolveStoredSpeakerName(message, ownerName, fallbackContactName);
    return `${speaker}: ${cleanContent}`;
}

export function dominantExternalSpeaker(messages, ownerName, fallbackContactName = null) {
    const owner = normalizeComparableText(ownerName);
    const counts = new Map();

    for (const message of messages || []) {
        const speaker = resolveStoredSpeakerName(message, ownerName, fallbackContactName);
        const normalized = normalizeComparableText(speaker);
        if (!normalized || normalized === owner) continue;
        counts.set(speaker, (counts.get(speaker) || 0) + 1);
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])[0]?.[0]
        || pickBestHumanName(fallbackContactName)
        || ownerName
        || fallbackNameFromRemoteId(messages?.[0]?.remote_id)
        || 'Participante';
}
