import {
    fallbackNameFromRemoteId,
    isGenericSpeakerLabel,
    normalizeComparableText,
    stripDecorativeText
} from './message_guard.mjs';

const OWNER_ALIASES = new Set([
    'usuario',
    'usuario principal',
    'user_sent',
    'yo',
    'me',
    'mi clon',
    'mi clon yo',
    'titular'
]);

const BLOCKED_ENTITY_PATTERNS = [
    /^\[.*\]$/,
    /^(audio|imagen|image|video|foto|sticker|documento|document|media|mensaje|voz)$/i,
    /^(assistant|asistente|system|contacto|persona|interlocutor|anonimo|anónimo)$/i
];

const BLOCKED_EXACT_ENTITY_NAMES = new Set([
    'el',
    'la',
    'los',
    'las',
    'lo',
    'un',
    'una',
    'uno',
    'unos',
    'unas',
    'alguien',
    'nadie',
    'otro',
    'otra',
    'otros',
    'otras',
    'el tipo',
    'la tia',
    'la tía',
    'el tio',
    'el tío',
    'el jefe',
    'la jefa',
    'medico',
    'médico',
    'doctor',
    'doctora',
    'psiquiatra',
    'terapeuta',
    'madre',
    'padre',
    'mi madre',
    'mi padre',
    'mi hermano',
    'mi hermana',
    'su madre',
    'su padre',
    'el medico',
    'casa',
    'mr',
    'él',
    'ella',
    'ellos',
    'ellas',
    'este',
    'esta',
    'esto',
    'ese',
    'esa',
    'eso'
]);

const ENTITY_TYPE_ALIASES = new Map([
    ['persona', 'PERSONA'],
    ['person', 'PERSONA'],
    ['contacto', 'PERSONA'],
    ['organizacion', 'ORGANIZACION'],
    ['organización', 'ORGANIZACION'],
    ['organization', 'ORGANIZACION'],
    ['empresa', 'ORGANIZACION'],
    ['lugar', 'LUGAR'],
    ['place', 'LUGAR'],
    ['ubicacion', 'LUGAR'],
    ['ubicación', 'LUGAR'],
    ['proyecto', 'PROYECTO'],
    ['project', 'PROYECTO'],
    ['tema', 'TEMA'],
    ['topic', 'TEMA'],
    ['asunto', 'TEMA'],
    ['evento', 'EVENTO'],
    ['event', 'EVENTO'],
    ['grupo', 'GRUPO'],
    ['chat_grupo', 'GRUPO'],
    ['group', 'GRUPO'],
    ['objeto', 'OBJETO'],
    ['object', 'OBJETO'],
    ['entity', 'ENTITY'],
    ['concepto', 'ENTITY']
]);

const PERSON_LIKE_ENTITY_TYPES = new Set(['PERSONA']);

const RELATION_TYPE_ALIASES = new Map([
    ['relacionado_con', 'RELACIONADO_CON'],
    ['related_to', 'RELACIONADO_CON'],
    ['menciona', 'HABLA_DE'],
    ['menciona', 'HABLA_DE'],
    ['habla_de', 'HABLA_DE'],
    ['talks_about', 'HABLA_DE'],
    ['familia', 'FAMILIA_DE'],
    ['familia_de', 'FAMILIA_DE'],
    ['family_of', 'FAMILIA_DE'],
    ['pareja', 'PAREJA_DE'],
    ['amor', 'PAREJA_DE'],
    ['pareja_de', 'PAREJA_DE'],
    ['partner_of', 'PAREJA_DE'],
    ['amistad', 'AMISTAD'],
    ['amigo_de', 'AMISTAD'],
    ['friend_of', 'AMISTAD'],
    ['trabajo', 'TRABAJA_EN'],
    ['trabaja_en', 'TRABAJA_EN'],
    ['works_at', 'TRABAJA_EN'],
    ['vive_en', 'VIVE_EN'],
    ['lives_in', 'VIVE_EN'],
    ['estudia_en', 'ESTUDIA_EN'],
    ['studies_at', 'ESTUDIA_EN'],
    ['usa', 'USA'],
    ['utiliza', 'USA'],
    ['uses', 'USA'],
    ['posee', 'POSEE'],
    ['owns', 'POSEE'],
    ['planea', 'PLANEA'],
    ['planifica', 'PLANEA'],
    ['plans', 'PLANEA'],
    ['prefiere', 'PREFIERE'],
    ['gusto', 'PREFIERE'],
    ['likes', 'PREFIERE'],
    ['evita', 'EVITA'],
    ['odio', 'EVITA'],
    ['avoids', 'EVITA'],
    ['evento_con', 'EVENTO_CON'],
    ['event_with', 'EVENTO_CON'],
    ['conoce_a', 'CONOCE_A'],
    ['knows', 'CONOCE_A']
]);

const ALLOWED_RELATION_TYPES = new Set([
    'RELACIONADO_CON',
    'HABLA_DE',
    'CONOCE_A',
    'FAMILIA_DE',
    'PAREJA_DE',
    'AMISTAD',
    'TRABAJA_EN',
    'VIVE_EN',
    'ESTUDIA_EN',
    'USA',
    'POSEE',
    'PLANEA',
    'PREFIERE',
    'EVITA',
    'EVENTO_CON'
]);

const EXPLICIT_RELATION_CUES = new Map([
    ['[FAMILIA_DE]', ['madre', 'padre', 'hijo', 'hija', 'hermano', 'hermana', 'familia', 'sobrino', 'sobrina', 'prima', 'primo']],
    ['[PAREJA_DE]', ['pareja', 'novia', 'novio', 'mi amor', 'te amo', 'amor', 'cariño', 'carino', 'beso']],
    ['[AMISTAD]', ['amigo', 'amiga', 'colega', 'bro', 'colegas']],
    ['[TRABAJA_EN]', ['trabajo', 'curro', 'empresa', 'oficina', 'jefe', 'jefa']],
    ['[VIVE_EN]', ['vive', 'casa', 'piso', 'mudado', 'mudarse']],
    ['[ESTUDIA_EN]', ['estudia', 'universidad', 'instituto', 'master', 'máster', 'curso']],
    ['[CONOCE_A]', ['conoce', 'quedo con', 'quedé con', 'he hablado con', 'hablé con']],
    ['[USA]', ['usa', 'utiliza', 'con esto', 'me he comprado', 'me he pillado']],
    ['[POSEE]', ['tiene', 'tengo', 'posee', 'lleva', 'he pillado']],
    ['[PLANEA]', ['voy a', 'quiero', 'planeo', 'plan', 'vamos a']],
    ['[PREFIERE]', ['prefiero', 'me gusta', 'me encanta']],
    ['[EVITA]', ['evita', 'no quiero', 'odio', 'paso de']]
]);

function trimEntityEdges(value) {
    return String(value || '')
        .replace(/^["'`´“”‘’@#\s]+/, '')
        .replace(/["'`´“”‘’.,;:!?@#\s]+$/, '')
        .replace(/[_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function clampText(value, maxLength = 500) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function normalizeRelationKey(value) {
    return normalizeComparableText(String(value || '').replace(/[\[\]()]/g, ' '))
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function buildKnownNameMap({ ownerName, contactName, remoteId, speakers = [] }) {
    const map = new Map();
    const register = (candidate) => {
        const normalized = normalizeEntityName(candidate, ownerName);
        if (!normalized) return;
        const key = normalizeComparableText(normalized);
        if (!map.has(key)) {
            map.set(key, normalized);
        }
    };

    register(ownerName);
    register(contactName);
    register(fallbackNameFromRemoteId(remoteId));
    for (const speaker of (speakers || [])) {
        register(speaker);
    }

    return map;
}

function snippetExistsInText(text, snippet) {
    const normalizedText = normalizeComparableText(text);
    const normalizedSnippet = normalizeComparableText(snippet);
    if (!normalizedText || !normalizedSnippet) return false;
    return normalizedText.includes(normalizedSnippet);
}

function pickEvidence(record) {
    return clampText(
        record?.evidence
        || record?.quote
        || record?.context
        || record?.snippet
    );
}

function relationMentionsEntity(evidenceText, entityName) {
    const normalizedEvidence = normalizeComparableText(evidenceText);
    const normalizedEntity = normalizeComparableText(entityName);
    if (!normalizedEvidence || !normalizedEntity) return false;
    return normalizedEvidence.includes(normalizedEntity);
}

function extractEvidenceSpeaker(evidenceText, ownerName = null) {
    const raw = String(evidenceText || '');
    const idx = raw.indexOf(':');
    if (idx <= 0) return null;
    return normalizeEntityName(raw.slice(0, idx).trim(), ownerName);
}

function hasExplicitCue(relationType, evidenceText, contextText = '') {
    const cues = EXPLICIT_RELATION_CUES.get(relationType);
    if (!cues?.length) return false;
    const haystack = normalizeComparableText(`${evidenceText || ''} ${contextText || ''}`);
    return cues.some(cue => haystack.includes(normalizeComparableText(cue)));
}

function relationshipHasStrongEvidence({
    relationType,
    sourceName,
    targetName,
    evidence,
    context,
    ownerName,
    contactName,
    isGroup
}) {
    const speaker = extractEvidenceSpeaker(evidence, ownerName);
    const speakerKey = normalizeComparableText(speaker);
    const ownerKey = normalizeComparableText(ownerName);
    const contactKey = normalizeComparableText(contactName);
    const sourceKey = normalizeComparableText(sourceName);
    const targetKey = normalizeComparableText(targetName);
    const mentionsSource = relationMentionsEntity(evidence, sourceName);
    const mentionsTarget = relationMentionsEntity(evidence, targetName);
    const speakerMatchesSource = speakerKey && speakerKey === sourceKey;
    const speakerMatchesTarget = speakerKey && speakerKey === targetKey;
    const privatePair =
        !isGroup &&
        ownerKey &&
        contactKey &&
        new Set([sourceKey, targetKey]).size === 2 &&
        [sourceKey, targetKey].includes(ownerKey) &&
        [sourceKey, targetKey].includes(contactKey);

    if (relationType === '[HABLA_DE]') {
        return mentionsTarget;
    }

    if (relationType === '[RELACIONADO_CON]' || relationType === '[EVENTO_CON]') {
        return (mentionsSource || speakerMatchesSource || speakerMatchesTarget) && mentionsTarget;
    }

    if (mentionsSource && mentionsTarget) {
        return true;
    }

    if (!hasExplicitCue(relationType, evidence, context)) {
        return false;
    }

    if (privatePair && (speakerMatchesSource || speakerMatchesTarget || mentionsSource || mentionsTarget)) {
        return true;
    }

    return (speakerMatchesSource || speakerMatchesTarget) && (mentionsSource || mentionsTarget);
}

function resolveKnownEntity(name, entityMap, knownNames, ownerName) {
    const normalized = normalizeEntityName(name, ownerName);
    if (!normalized) return null;
    const key = normalizeComparableText(normalized);
    if (entityMap.has(key)) return entityMap.get(key);

    const knownName = knownNames.get(key);
    if (!knownName) return null;

    const entity = {
        name: knownName,
        type: 'PERSONA',
        desc: ''
    };
    entityMap.set(key, entity);
    return entity;
}

export function normalizeEntityName(value, ownerName = null) {
    const rawValue = trimEntityEdges(stripDecorativeText(value));
    if (!rawValue) return null;

    const comparable = normalizeComparableText(rawValue);
    if (!comparable) return null;
    if (ownerName && OWNER_ALIASES.has(comparable)) return ownerName;
    if (isGenericSpeakerLabel(rawValue)) return null;
    if (BLOCKED_ENTITY_PATTERNS.some(pattern => pattern.test(rawValue))) return null;
    if (BLOCKED_EXACT_ENTITY_NAMES.has(comparable)) return null;
    if (rawValue.length < 2 && !/^[A-Z0-9]{2,}$/.test(rawValue)) return null;

    return rawValue;
}

export function sanitizeEntityType(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) return 'ENTITY';
    return ENTITY_TYPE_ALIASES.get(normalized) || 'ENTITY';
}

export function sanitizeRelationType(value) {
    const normalized = normalizeRelationKey(value);
    if (!normalized) return null;
    const mapped = RELATION_TYPE_ALIASES.get(normalized) || normalized.toUpperCase();
    if (!ALLOWED_RELATION_TYPES.has(mapped)) return null;
    return `[${mapped}]`;
}

export function normalizeWeight(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 5;
    if (numeric >= 1 && numeric <= 10) return Math.round(numeric);
    if (numeric >= 0 && numeric <= 1) return Math.min(10, Math.max(1, Math.round(numeric * 10)));
    return Math.min(10, Math.max(1, Math.round(numeric)));
}

export function isPersonLikeEntityType(type) {
    return PERSON_LIKE_ENTITY_TYPES.has(sanitizeEntityType(type));
}

export function extractSpeakersFromLines(lines) {
    return [...new Set((lines || [])
        .map(line => {
            const idx = String(line || '').indexOf(':');
            return idx > 0 ? line.slice(0, idx).trim() : null;
        })
        .filter(Boolean))];
}

export function validateGroundedGraph({
    entities = [],
    relationships = [],
    chunkText = '',
    ownerName = null,
    contactName = null,
    remoteId = null,
    isGroup = false,
    speakers = []
}) {
    const knownNames = buildKnownNameMap({
        ownerName,
        contactName: isGroup ? null : contactName,
        remoteId,
        speakers
    });
    const normalizedChunkText = normalizeComparableText(chunkText);
    const entityMap = new Map();
    const relationshipMap = new Map();

    for (const entity of (entities || [])) {
        const normalizedName = normalizeEntityName(entity?.name, ownerName);
        if (!normalizedName) continue;

        const nameKey = normalizeComparableText(normalizedName);
        const evidence = pickEvidence(entity);
        const groundedBySpeaker = knownNames.has(nameKey);
        const groundedByEvidence = evidence ? snippetExistsInText(chunkText, evidence) : false;
        const groundedByMention = normalizedChunkText.includes(nameKey);

        if (!groundedBySpeaker && !groundedByEvidence && !groundedByMention) {
            continue;
        }

        const existing = entityMap.get(nameKey);
        const nextEntity = {
            name: knownNames.get(nameKey) || normalizedName,
            type: sanitizeEntityType(entity?.type),
            desc: clampText(entity?.desc || entity?.description || evidence, 300)
        };

        if (!existing || nextEntity.desc.length > existing.desc.length) {
            entityMap.set(nameKey, nextEntity);
        }
    }

    for (const relationship of (relationships || [])) {
        const sourceEntity = resolveKnownEntity(relationship?.source, entityMap, knownNames, ownerName);
        const targetEntity = resolveKnownEntity(relationship?.target, entityMap, knownNames, ownerName);
        if (!sourceEntity || !targetEntity) continue;
        if (sourceEntity.name === targetEntity.name) continue;

        const relationType = sanitizeRelationType(relationship?.type);
        if (!relationType) continue;

        const evidence = pickEvidence(relationship);
        if (!evidence || !snippetExistsInText(chunkText, evidence)) continue;
        if (!relationshipHasStrongEvidence({
            relationType,
            sourceName: sourceEntity.name,
            targetName: targetEntity.name,
            evidence,
            context: relationship?.context,
            ownerName,
            contactName,
            isGroup
        })) {
            continue;
        }

        if (
            isGroup
            && isPersonLikeEntityType(sourceEntity.type)
            && isPersonLikeEntityType(targetEntity.type)
        ) {
            const ownerKey = normalizeComparableText(ownerName);
            const sourceKey = normalizeComparableText(sourceEntity.name);
            const targetKey = normalizeComparableText(targetEntity.name);
            const evidenceText = normalizeComparableText(evidence);
            const involvesOwner = ownerKey && (sourceKey === ownerKey || targetKey === ownerKey);
            const mentionsBothPeople = evidenceText.includes(sourceKey) && evidenceText.includes(targetKey);

            if (!involvesOwner && !mentionsBothPeople) {
                continue;
            }
        }

        const relationKey = [
            normalizeComparableText(sourceEntity.name),
            relationType,
            normalizeComparableText(targetEntity.name)
        ].join('::');

        if (relationshipMap.has(relationKey)) continue;

        relationshipMap.set(relationKey, {
            source: sourceEntity.name,
            target: targetEntity.name,
            type: relationType,
            weight: normalizeWeight(relationship?.weight),
            context: clampText(relationship?.context || evidence, 300),
            evidence
        });
    }

    return {
        entities: [...entityMap.values()],
        relationships: [...relationshipMap.values()]
    };
}

export function expandDetectedNamesConservatively(detectedNames, knownNames) {
    const expanded = new Set((detectedNames || []).filter(Boolean));
    const exactMatches = new Map();
    const tokenIndex = new Map();

    for (const knownName of (knownNames || [])) {
        const cleaned = normalizeEntityName(knownName);
        if (!cleaned) continue;

        const normalized = normalizeComparableText(cleaned);
        if (!normalized) continue;

        if (!exactMatches.has(normalized) || cleaned.length < exactMatches.get(normalized).length) {
            exactMatches.set(normalized, cleaned);
        }

        for (const token of normalized.split(' ')) {
            if (token.length < 4) continue;
            if (!tokenIndex.has(token)) tokenIndex.set(token, new Set());
            tokenIndex.get(token).add(cleaned);
        }
    }

    for (const detectedName of (detectedNames || [])) {
        const cleanedDetected = normalizeEntityName(detectedName);
        if (!cleanedDetected) continue;

        const normalizedDetected = normalizeComparableText(cleanedDetected);
        if (exactMatches.has(normalizedDetected)) {
            expanded.add(exactMatches.get(normalizedDetected));
        }

        for (const token of normalizedDetected.split(' ')) {
            if (token.length < 4) continue;
            const candidates = [...(tokenIndex.get(token) || [])];
            if (candidates.length === 1) {
                expanded.add(candidates[0]);
            }
        }
    }

    return [...expanded];
}
