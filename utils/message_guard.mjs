const BLOCKED_MEMORY_REMOTE_IDS = new Set([
    'terminal-admin',
    'test-terminal',
    'system_test',
    'system-test'
]);

/**
 * Level 6 Universal Bot Detection
 * Replaces static regex with generic logic.
 */
export function looksLikeBotText(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    
    // Bot markers tend to be very structured or use technical placeholders
    if (/^[\[(]IA:.*[\])]/.test(value)) return false; // This is our semantic text, NOT a bot message
    return /\[.*?\]/.test(value) && value.length > 50; 
}

export function normalizeComparableText(value) {
    return String(value || '')
        .normalize('NFKC')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

export function stripDecorativeText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u2600-\u27BF]/gu, ' ')
        .replace(/[*_~|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeEntityLikeText(value) {
    const cleaned = stripDecorativeText(value)
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned) return '';

    const tokens = cleaned.split(' ').filter(Boolean);
    if (tokens.length >= 2 && tokens.every(token => /^[\p{L}\p{N}]$/u.test(token))) {
        return tokens.join('');
    }

    return cleaned;
}

export function isGenericSpeakerLabel(value) {
    const normalized = normalizeComparableText(value);
    const generic = ['usuario', 'asistente', 'assistant', 'system', 'unknown', 'yo', 'me'];
    return !normalized || generic.includes(normalized) || normalized.length < 2;
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

/**
 * Level 6: Neural Density Evaluation
 * Uses reasoning to determine if a message contains extractable knowledge / emotional subtext.
 */
export async function evaluateInformationDensityNeural(messageText, metadata = {}) {
    if (!messageText || messageText.length < 5) return { score: 0, reason: 'too_short' };

    // This would be called by the memory worker during pre-processing
    // For now, we keep the signature ready for the brain integration
    const points = [
        { regex: /[?!.]{2,}/, score: 0.2, label: 'expressive' },
        { regex: /\b(quedamos|voy|quiero|creo|siento)\b/i, score: 0.3, label: 'intent_or_feel' },
        { regex: /\[IA:.*\]/, score: 0.5, label: 'media_semantic' }
    ];

    let score = points.reduce((acc, p) => acc + (p.regex.test(messageText) ? p.score : 0), 0.1);
    
    // If it looks like a bot, we penalize heavily
    if (looksLikeBotText(messageText)) score -= 0.8;

    return {
        score: Math.max(0, Math.min(1, score)),
        isHighDensity: score > 0.4,
        tags: points.filter(p => p.regex.test(messageText)).map(p => p.label)
    };
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

    // Check content quality (Heuristic for now, can be upgraded to full neural call)
    const density = 0.5; // Placeholder for sync call
    if (density < 0.1) return false;

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

export function renderConversationLine(message, ownerName, fallbackContactName = null, ownerId = null) {
    const semanticText = message?.semantic_text || message?.metadata?.semanticText;
    const cleanContent = stripMediaPlaceholders(message?.content);
    
    // Si es media, preferimos el texto semántico (lo que la IA "vio" u "oyó")
    const finalContent = semanticText 
        ? (cleanContent ? `${cleanContent} [IA: ${semanticText}]` : `[IA: ${semanticText}]`)
        : cleanContent;

    if (!finalContent) return null;

    const remoteId = message?.remote_id;
    let speaker = resolveStoredSpeakerName(message, ownerName, fallbackContactName);

    // Level 6: Neural Identity Anchor
    // If we have an ownerId (discovered behaviorally), use it to stabilize "Yo"
    if (ownerId && remoteId === ownerId) {
        speaker = ownerName || 'Yo';
    }

    return `${speaker}: ${finalContent}`;
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
