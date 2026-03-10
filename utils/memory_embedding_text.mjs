function compactText(value = '', maxLength = 1200) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

export function buildCompactMemoryEmbeddingText(chunkText, {
    contactName,
    remoteId,
    date,
    speakers = []
} = {}) {
    const compactSpeakers = [...new Set((speakers || []).filter(Boolean))].slice(0, 6).join(', ');
    const compactBody = compactText(chunkText, 1200);

    return [
        '[WA_MEMORY]',
        contactName ? `contact=${contactName}` : null,
        remoteId ? `remote=${remoteId}` : null,
        date ? `date=${date}` : null,
        compactSpeakers ? `speakers=${compactSpeakers}` : null,
        compactBody
    ].filter(Boolean).join('\n');
}

export function buildCompactMemoryEmbeddingTextFromStoredMemory(memory = {}) {
    const metadata = memory.metadata || {};
    const content = String(memory.content || '');
    const body = content.includes('\n') ? content.slice(content.indexOf('\n') + 1) : content;

    return buildCompactMemoryEmbeddingText(body, {
        contactName: metadata.contactName || metadata.contact_name || null,
        remoteId: metadata.remoteId || metadata.remote_id || null,
        date: metadata.date || memory.created_at || null,
        speakers: Array.isArray(metadata.speakers) ? metadata.speakers : []
    });
}
