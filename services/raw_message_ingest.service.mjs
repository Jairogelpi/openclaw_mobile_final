import crypto from 'node:crypto';

const WHATSAPP_LIKE_REMOTE_ID_REGEX = /@s\.whatsapp\.net$|@g\.us$|@lid$/i;
const PLACEHOLDER_REGEX = /^\[(imagen|audio|video|documento|sticker|foto|archivo|pdf)(?::[^\]]+)?\]$/i;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MEDIA_PLACEHOLDER_LABELS = {
    image: 'Imagen',
    audio: 'Audio',
    video: 'Video',
    document: 'Documento',
    sticker: 'Sticker'
};

function cleanString(value, fallback = null) {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

export function normalizeUuid(value, fallback = null) {
    const normalized = cleanString(value, null);
    if (!normalized) return fallback;
    return UUID_REGEX.test(normalized) ? normalized : fallback;
}

export function normalizeIsoTimestamp(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'string') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
    }
    if (typeof value === 'number') {
        const millis = value > 1e12 ? value : value * 1000;
        const parsed = new Date(millis);
        return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
    }
    if (typeof value === 'object') {
        const candidate = Number(value.low ?? value.high ?? value.value ?? value.toString?.());
        if (Number.isFinite(candidate)) {
            const millis = candidate > 1e12 ? candidate : candidate * 1000;
            const parsed = new Date(millis);
            return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
        }
    }
    return fallback;
}

export function extractWhatsAppMediaPayload(message = null) {
    if (!message) return null;
    if (message.imageMessage) return { imageMessage: message.imageMessage };
    if (message.audioMessage) return { audioMessage: message.audioMessage };
    if (message.videoMessage) return { videoMessage: message.videoMessage };
    if (message.documentMessage) return { documentMessage: message.documentMessage };
    if (message.stickerMessage) return { stickerMessage: message.stickerMessage };
    return null;
}

export function detectMediaType(mediaPayload = null, fallbackText = '') {
    if (mediaPayload?.imageMessage) return 'image';
    if (mediaPayload?.audioMessage) return 'audio';
    if (mediaPayload?.videoMessage) return 'video';
    if (mediaPayload?.documentMessage) return 'document';
    if (mediaPayload?.stickerMessage) return 'sticker';

    const normalized = String(fallbackText || '').trim();
    if (/^\[(imagen|foto)/i.test(normalized)) return 'image';
    if (/^\[(audio|nota de voz)/i.test(normalized)) return 'audio';
    if (/^\[(video)/i.test(normalized)) return 'video';
    if (/^\[(documento|archivo|pdf)/i.test(normalized)) return 'document';
    if (/^\[(sticker)/i.test(normalized)) return 'sticker';
    return null;
}

export function extractMediaCaption(mediaPayload = null) {
    return cleanString(
        mediaPayload?.imageMessage?.caption
        || mediaPayload?.videoMessage?.caption
        || mediaPayload?.documentMessage?.caption,
        null
    );
}

export function extractMediaMimeType(mediaPayload = null) {
    return cleanString(
        mediaPayload?.imageMessage?.mimetype
        || mediaPayload?.audioMessage?.mimetype
        || mediaPayload?.videoMessage?.mimetype
        || mediaPayload?.documentMessage?.mimetype
        || mediaPayload?.stickerMessage?.mimetype,
        null
    );
}

export function extractMediaFilename(mediaPayload = null, fallback = null) {
    return cleanString(
        mediaPayload?.documentMessage?.fileName
        || mediaPayload?.imageMessage?.fileName
        || mediaPayload?.videoMessage?.fileName,
        fallback
    );
}

export function isPlaceholderOnlyText(value = '') {
    return PLACEHOLDER_REGEX.test(String(value || '').trim());
}

export function buildMediaPlaceholder(mediaType = null, messageId = null) {
    const label = MEDIA_PLACEHOLDER_LABELS[mediaType] || 'Media';
    const suffix = cleanString(messageId, null);
    return suffix ? `[${label}: ${suffix}]` : `[${label}]`;
}

export function normalizeRawText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

export function buildSemanticText({ text = '', mediaCaption = null } = {}) {
    const normalizedText = normalizeRawText(text);
    if (normalizedText && !isPlaceholderOnlyText(normalizedText)) {
        return normalizedText;
    }

    const normalizedCaption = normalizeRawText(mediaCaption || '');
    return normalizedCaption || null;
}

export function buildRawMessageRecord(params = {}) {
    const {
        id = params.id || crypto.randomUUID(),
        clientId = params.clientId || params.client_id,
        senderRole = params.senderRole || params.sender_role,
        content = params.content || '',
        remoteId = params.remoteId || params.remote_id,
        createdAt = params.createdAt || params.created_at || null,
        processed = params.processed ?? false,
        channel = params.channel || 'whatsapp',
        sourceMessageId = params.sourceMessageId || params.source_message_id || null,
        participantJid = params.participantJid || params.participant_jid || null,
        canonicalSenderName = params.canonicalSenderName || params.canonical_sender_name || null,
        conversationName = params.conversationName || params.conversation_name || null,
        isGroup = params.isGroup ?? params.is_group ?? false,
        isHistory = params.isHistory ?? params.is_history ?? false,
        quotedMessageId = params.quotedMessageId || params.quoted_message_id || null,
        pushName = params.pushName || null,
        avatarUrl = params.avatarUrl || null,
        deliveryStatus = params.deliveryStatus || params.delivery_status || null,
        mediaPayload = params.mediaPayload || null,
        mediaType = params.mediaType || params.media_type || null,
        mediaMimeType = params.mediaMimeType || params.media_mime_type || null,
        mediaFilename = params.mediaFilename || params.media_filename || null,
        excludeFromMemory = params.excludeFromMemory || params.exclude_from_memory || false,
        assistantEcho = params.assistantEcho || params.assistant_echo || false,
        generatedBy = params.generatedBy || params.generated_by || null,
        metadata = params.metadata || {},
        semanticText = params.semanticText || params.semantic_text || null
    } = params;
    const normalizedId = normalizeUuid(id, null) || crypto.randomUUID();
    const normalizedClientId = normalizeUuid(clientId, null);
    const timestamp = normalizeIsoTimestamp(createdAt, new Date().toISOString());
    const normalizedContent = normalizeRawText(content);
    const effectiveMediaType = mediaType || detectMediaType(mediaPayload, normalizedContent);
    const effectiveMediaCaption = extractMediaCaption(mediaPayload);
    const storedContent = normalizedContent || (effectiveMediaType ? buildMediaPlaceholder(effectiveMediaType, sourceMessageId) : '');
    const effectiveSemanticText = cleanString(semanticText, null) || buildSemanticText({
        text: storedContent,
        mediaCaption: effectiveMediaCaption
    });
    const hasMedia = Boolean(effectiveMediaType);
    const contentReady = Boolean(effectiveSemanticText) || !hasMedia;
    const enrichmentStatus = hasMedia ? 'pending' : 'ready';
    const mediaStatus = hasMedia ? 'captured' : 'none';
    const effectiveMimeType = mediaMimeType || extractMediaMimeType(mediaPayload);
    const effectiveFilename = extractMediaFilename(mediaPayload, mediaFilename);
    const messageType = effectiveMediaType || 'text';

    const nextMetadata = {
        ...(metadata || {}),
        channel,
        msgId: sourceMessageId || metadata?.msgId || null,
        timestamp,
        participantJid: participantJid || metadata?.participantJid || null,
        canonicalSenderName: canonicalSenderName || metadata?.canonicalSenderName || null,
        conversationName: conversationName || metadata?.conversationName || null,
        quotedMessageId: quotedMessageId || metadata?.quotedMessageId || null,
        pushName: pushName || metadata?.pushName || null,
        avatarUrl: avatarUrl || metadata?.avatarUrl || null,
        status: deliveryStatus || metadata?.status || null,
        isGroup: Boolean(isGroup || metadata?.isGroup),
        isHistory: Boolean(isHistory || metadata?.isHistory || metadata?.historical),
        hasMedia,
        mediaPayload: mediaPayload || metadata?.mediaPayload || null,
        mediaType: effectiveMediaType,
        mediaMimeType: effectiveMimeType,
        mediaFilename: effectiveFilename,
        mediaCaption: effectiveMediaCaption,
        semantic_text: effectiveSemanticText,
        content_ready: contentReady,
        media_status: mediaStatus,
        enrichment_status: enrichmentStatus,
        exclude_from_memory: Boolean(excludeFromMemory || metadata?.exclude_from_memory),
        assistant_echo: Boolean(assistantEcho || metadata?.assistant_echo),
        generated_by: generatedBy || metadata?.generated_by || null,
        schema_version: 2
    };

    return {
        id: normalizedId,
        client_id: normalizedClientId,
        sender_role: cleanString(senderRole, 'Contacto'),
        content: storedContent,
        semantic_text: effectiveSemanticText,
        processed: Boolean(processed),
        created_at: timestamp,
        remote_id: cleanString(remoteId, null),
        channel,
        source_message_id: sourceMessageId || null,
        event_timestamp: timestamp,
        participant_jid: participantJid || null,
        canonical_sender_name: canonicalSenderName || null,
        conversation_name: conversationName || null,
        is_group: Boolean(isGroup),
        is_history: Boolean(isHistory),
        message_type: messageType,
        quoted_message_id: quotedMessageId || null,
        has_media: hasMedia,
        media_type: effectiveMediaType,
        media_mime_type: effectiveMimeType,
        media_caption: effectiveMediaCaption,
        media_status: mediaStatus,
        enrichment_status: enrichmentStatus,
        content_ready: contentReady,
        delivery_status: deliveryStatus || null,
        metadata: nextMetadata
    };
}

export function buildWhatsAppDownloadableMessage({ remoteJid, messageId, fromMe = false, participantJid = null, mediaPayload = null } = {}) {
    return {
        key: {
            remoteJid,
            id: messageId,
            fromMe,
            participant: participantJid || undefined
        },
        message: mediaPayload
    };
}

export function looksLikeWhatsAppChannel(channel = '', remoteId = '', participantJid = '') {
    const normalizedChannel = cleanString(channel, '')?.toLowerCase?.() || '';
    if (normalizedChannel === 'whatsapp') return true;
    return WHATSAPP_LIKE_REMOTE_ID_REGEX.test(String(remoteId || '').trim())
        || WHATSAPP_LIKE_REMOTE_ID_REGEX.test(String(participantJid || '').trim());
}
