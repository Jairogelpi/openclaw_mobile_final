import { normalizeComparableText } from './message_guard.mjs';
import { extractDeterministicRelationships } from './knowledge_guard.mjs';

const EXPLICIT_GRAPH_PATTERNS = [
    /\b(te amo|mi amor|mi vida|amor mio)\b/i,
    /\b(eres mi amig[oa]|somos amig[oa]s|mi mejor amig[oa])\b/i,
    /\b(trabajo|curro|empresa|oficina|jefe|jefa)\b/i,
    /\b(vivo|vive|casa|piso|mud[ao]|mudarse)\b/i,
    /\b(estudio|estudia|universidad|instituto|master|curso)\b/i,
    /\b(conozco a|he hablado con|hable con|hablé con|quede con|quedé con)\b/i,
    /\b(prefiero|me gusta|me encanta|odio|evita|paso de)\b/i,
    /\b(voy a|quiero|planeo|plan)\b/i,
    /\b(usa|utiliza|tengo|posee|me he comprado|me he pillado)\b/i,
    /\b(habla de|hablar de|sobre|menciona|pregunta por|dice de)\b/i
];

const STRUCTURAL_GRAPH_PATTERNS = [
    /\b(te amo|mi amor|mi vida|amor mio)\b/i,
    /\b(eres mi amig[oa]|somos amig[oa]s|mi mejor amig[oa])\b/i,
    /\b(trabajo|curro|empresa|oficina|jefe|jefa)\b/i,
    /\b(vivo|vive|casa|piso|mud[ao]|mudarse)\b/i,
    /\b(estudio|estudia|universidad|instituto|master|curso)\b/i,
    /\b(conozco a|he hablado con|hable con|hablé con|quede con|quedé con)\b/i,
    /\b(voy a|quiero|planeo|plan)\b/i,
    /\b(usa|utiliza|tengo|posee|me he comprado|me he pillado)\b/i,
    /\b(habla de|hablar de|sobre|menciona|pregunta por|dice de)\b/i
];

const THIRD_PARTY_REFERENCE_PATTERNS = [
    /\b(mi|mis|su|sus|tu|tus)\s+(padre|madre|hermano|hermana|novio|novia|pareja|jefe|jefa|amigo|amiga)\b/i,
    /\b[A-ZÁÉÍÓÚÑ][\p{L}'-]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'-]{2,})*\b/u
];

function stripSpeakerPrefix(line = '') {
    const idx = String(line).indexOf(':');
    return idx > 0 ? line.slice(idx + 1).trim() : String(line).trim();
}

function extractSpeakerLabel(line = '') {
    const idx = String(line).indexOf(':');
    return idx > 0 ? line.slice(0, idx).trim() : null;
}

function normalizeName(value = '') {
    return normalizeComparableText(String(value || '').trim());
}

function bodyWithoutParticipants(text = '', ownerName = '', contactName = '') {
    let body = String(text || '');
    for (const label of [ownerName, contactName]) {
        const trimmed = String(label || '').trim();
        if (!trimmed) continue;
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        body = body.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' ');
    }
    return body;
}

export function analyzeGraphExtractionNeed({
    chunkText = '',
    ownerName = null,
    contactName = null,
    isGroup = false
} = {}) {
    const text = String(chunkText || '').trim();
    if (!text) {
        return { shouldRunLLM: false, reason: 'empty_chunk', deterministicRelationships: [] };
    }

    const deterministicRelationships = extractDeterministicRelationships({
        chunkText: text,
        ownerName,
        contactName,
        isGroup
    });

    if (deterministicRelationships.length > 0) {
        return {
            shouldRunLLM: false,
            reason: 'deterministic_relationship_only',
            deterministicRelationships
        };
    }

    const rawLines = text
        .split('\n')
        .map(line => String(line).trim())
        .filter(Boolean);
    const lines = rawLines.map(stripSpeakerPrefix).filter(Boolean);
    const speakers = rawLines.map(extractSpeakerLabel).filter(Boolean).map(normalizeName);
    const body = lines.join(' ');
    const normalizedBody = normalizeComparableText(body);
    if (!normalizedBody) {
        return { shouldRunLLM: false, reason: 'empty_body', deterministicRelationships };
    }

    const participantStrippedBody = bodyWithoutParticipants(body, ownerName, contactName);
    const ownerKey = normalizeName(ownerName);
    const contactKey = normalizeName(contactName);
    const participantSpeakerOnly =
        !isGroup
        && speakers.length > 0
        && speakers.every(speaker => [ownerKey, contactKey].includes(speaker));
    const onlyParticipantsMentioned =
        participantSpeakerOnly
        && !THIRD_PARTY_REFERENCE_PATTERNS.some(pattern => pattern.test(participantStrippedBody));

    if (onlyParticipantsMentioned && !STRUCTURAL_GRAPH_PATTERNS.some(pattern => pattern.test(body))) {
        return { shouldRunLLM: false, reason: 'participant_only_banter', deterministicRelationships };
    }

    if (EXPLICIT_GRAPH_PATTERNS.some(pattern => pattern.test(body))) {
        return { shouldRunLLM: true, reason: 'explicit_graph_cue', deterministicRelationships };
    }

    if (THIRD_PARTY_REFERENCE_PATTERNS.some(pattern => pattern.test(participantStrippedBody))) {
        return { shouldRunLLM: true, reason: 'third_party_reference', deterministicRelationships };
    }

    return { shouldRunLLM: false, reason: 'low_semantic_signal', deterministicRelationships };
}
