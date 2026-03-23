import {
    fallbackNameFromRemoteId,
    isGenericSpeakerLabel,
    normalizeEntityLikeText,
    normalizeComparableText,
    stripDecorativeText
} from './message_guard.mjs';
import { classifyIdentityLikeName } from './identity_policy.mjs';
import {
    compactDigits,
    evaluateEntityAdmissibility,
    evaluateRelationshipAdmissibility,
    isPhoneLikeGraphName
} from './graph_admissibility_policy.mjs';

const OWNER_ALIASES = new Set([
    'usuario',
    'usuario principal',
    'user_sent',
    'yo',
    'me',
    'mi clon',
    'mi clon (yo)',
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
    ['concepto', 'ENTITY'],
    ['rasgo', 'RASGO_PERSONALIDAD'],
    ['personalidad', 'RASGO_PERSONALIDAD'],
    ['valor', 'VALOR_CENTRAL'],
    ['creencia', 'VALOR_CENTRAL']
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
    ['knows', 'CONOCE_A'],
    ['siente', 'SIENTE'],
    ['emocion', 'SIENTE'],
    ['sentiment', 'SIENTE'],
    ['apoya', 'SIENTE'],
    ['cuida', 'SIENTE'],
    ['prioriza', 'PREFIERE'],
    ['valora', 'PREFIERE']
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
    'EVENTO_CON',
    'SIENTE'
]);

const EXPLICIT_RELATION_CUES = new Map([
    ['[FAMILIA_DE]', ['madre', 'padre', 'hijo', 'hija', 'hermano', 'hermana', 'familia', 'sobrino', 'sobrina', 'prima', 'primo']],
    ['[PAREJA_DE]', ['pareja', 'novia', 'novio', 'mi amor', 'te amo', 'amor', 'cariño', 'carino', 'beso']],
    ['[AMISTAD]', ['amigo', 'amiga', 'colega', 'bro', 'colegas']],
    ['[TRABAJA_EN]', ['trabajo', 'curro', 'empresa', 'oficina', 'jefe', 'jefa']],
    ['[HABLA_DE]', ['habla de', 'hablar de', 'sobre', 'menciona', 'comenta', 'pregunta por', 'dice de']],
    ['[RELACIONADO_CON]', ['relacionado con', 'conectado con', 'asociado con', 'vinculado con', 'tiene que ver con']],
    ['[EVENTO_CON]', ['con', 'junto a', 'acompanado de', 'acompañado de']],
    ['[SIENTE]', ['siente', 'se siente', 'siento', 'me siento', 'agobio', 'estrés', 'estres', 'feliz', 'miedo', 'triste', 'ilusion', 'ilusión', 'ganas']],
    ['[PLANEA]', ['voy a', 'quiero', 'planeo', 'plan', 'vamos a', 'tengo que', 'haré', 'hare']]
]);

const STRONG_FRIENDSHIP_PATTERNS = [
    /\bes mi amig[oa]\b/i,
    /\beres mi amig[oa]\b/i,
    /\bsois amig[oa]s\b/i,
    /\bsomos amig[oa]s\b/i,
    /\bmi mejor amig[oa]\b/i,
    /\bgran amig[oa]\b/i
];

const DETERMINISTIC_PRIVATE_RELATIONS = [
    {
        type: '[PAREJA_DE]',
        weight: 9,
        cues: ['te amo', 'mi amor', 'mi vida', 'amor mio']
    },
    {
        type: '[AMISTAD]',
        weight: 7,
        cues: ['eres mi amigo', 'eres mi amiga', 'somos amigos', 'somos amigas', 'mi mejor amigo', 'mi mejor amiga']
    }
];

const ROMANTIC_VOCATIVE_PATTERNS = [
    /(^|[,:;!?\-]\s*)mi vida([!,. ]|$)/i,
    /(^|[,:;!?\-]\s*)mi amor([!,. ]|$)/i,
    /(^|[,:;!?\-]\s*)amor mio([!,. ]|$)/i,
    /\bte amo\b/i
];

const ROMANTIC_SECOND_PERSON_PATTERNS = [
    /\bte\b/i,
    /\btu\b/i,
    /\bti\b/i,
    /\bcontigo\b/i,
    /\beres\b/i,
    /\bme estas\b/i,
    /\bme est[aá]s\b/i
];

const ROMANTIC_NEGATIVE_PATTERNS = [
    /\bde mi vida\b/i,
    /\bpeor etapa de mi vida\b/i,
    /\balegria a m[ií] vida\b/i,
    /\balegría a m[ií] vida\b/i
];

const ROMANTIC_REPORTED_CONTEXT_PATTERNS = [
    /\bnos dec[ií]amos te amo\b/i,
    /\bnos dijimos te amo\b/i,
    /\bdec[ií]amos te amo\b/i,
    /\b(dijo|dec[ií]a|decia)\s+te amo\b/i,
    /\bme dijo\s+te amo\b/i,
    /\ble dije\s+te amo\b/i,
    /\bse dijeron\s+te amo\b/i
];

const FRIENDSHIP_DIRECT_PATTERNS = [
    /\beres mi amig[oa]\b/i,
    /\bsomos amig[oa]s\b/i,
    /\bmi mejor amig[oa]\b/i
];

const AFFECTIONATE_PAIR_SIGNALS = [
    { key: 'te_como', pattern: /\bte como\b/i, score: 2 },
    { key: 'besitos', pattern: /\bbesitos?\b/i, score: 2 },
    { key: 'kiss', pattern: /\b(beso|besote|besazo)\b/i, score: 1 },
    { key: 'heart_emoji', pattern: /[❤❤️💖💘💝💞💕🥰😍]/u, score: 1 },
    { key: 'te_cuido', pattern: /\bte pienso cuidar\b/i, score: 2 },
    { key: 'me_encantas', pattern: /\bme encantas\b/i, score: 2 }
];

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

function hasNegativeTalkCue(evidenceText, contextText = '') {
    const haystack = normalizeComparableText(`${evidenceText || ''} ${contextText || ''}`);
    return [
        'hablar con',
        'quiere hablar con',
        'hablo con',
        'habló con',
        'respuesta sobre',
        'respuesta a',
        'contesta a',
        'contestó a',
        'gracias',
        'expresion de afecto',
        'expresión de afecto'
    ].some(cue => haystack.includes(normalizeComparableText(cue)));
}

function isReportedRomanticContext(text = '') {
    const raw = String(text || '');
    if (!raw) return false;
    return ROMANTIC_REPORTED_CONTEXT_PATTERNS.some(pattern => pattern.test(raw));
}

function hasDirectedRomanticAddress(text = '') {
    const raw = String(text || '');
    if (!raw) return false;
    if (ROMANTIC_NEGATIVE_PATTERNS.some(pattern => pattern.test(raw))) return false;
    if (isReportedRomanticContext(raw)) return false;

    if (!ROMANTIC_VOCATIVE_PATTERNS.some(pattern => pattern.test(raw))) return false;

    return ROMANTIC_SECOND_PERSON_PATTERNS.some(pattern => pattern.test(raw));
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
    const normalizedOwner = normalizeComparableText(ownerName);
    const normalizedContact = normalizeComparableText(contactName);
    const normalizedEntity = normalizeComparableText(sourceName);
    const normalizedTargetEntity = normalizeComparableText(targetName);
    const normalizedEvidence = normalizeComparableText(evidence);

    const isOwnerSource = normalizedEntity === normalizedOwner;
    const isOwnerTarget = normalizedTargetEntity === normalizedOwner;
    const isContactSource = normalizedEntity === normalizedContact;
    const isContactTarget = normalizedTargetEntity === normalizedContact;

    const ownerAliases = ['yo', 'mi ', 'mí ', 'me '];
    const contactAliases = ['tú', 'tu ', 'tío', 'tio', 'tía', 'tia', 'colega'];

    let mentionsSource = relationMentionsEntity(evidence, sourceName);
    let mentionsTarget = relationMentionsEntity(evidence, targetName);

    if (!mentionsSource) {
        if (isOwnerSource) mentionsSource = ownerAliases.some(a => normalizedEvidence.includes(a));
        if (isContactSource) mentionsSource = contactAliases.some(a => normalizedEvidence.includes(a));
    }
    if (!mentionsTarget) {
        if (isOwnerTarget) mentionsTarget = ownerAliases.some(a => normalizedEvidence.includes(a));
        if (isContactTarget) mentionsTarget = contactAliases.some(a => normalizedEvidence.includes(a));
    }
    const speakerMatchesSource = speakerKey && speakerKey === sourceKey;
    const speakerMatchesTarget = speakerKey && speakerKey === targetKey;
    const privatePair =
        !isGroup &&
        ownerKey &&
        contactKey &&
        new Set([sourceKey, targetKey]).size === 2 &&
        [sourceKey, targetKey].includes(ownerKey) &&
        [sourceKey, targetKey].includes(contactKey);
    const requiresDirectionalSpeakerAnchor = ['[PAREJA_DE]', '[AMISTAD]', '[FAMILIA_DE]', '[CONOCE_A]'].includes(relationType);

    if (speakerKey && requiresDirectionalSpeakerAnchor && privatePair) {
        if (relationType === '[PAREJA_DE]') {
            if (speakerMatchesSource) {
                return hasDirectedRomanticAddress(evidence);
            }

            if (speakerMatchesTarget) {
                return false;
            }
        }

        if (speakerMatchesSource) {
            if (relationType === '[AMISTAD]') {
                const friendshipText = `${evidence || ''} ${context || ''}`;
                return STRONG_FRIENDSHIP_PATTERNS.some(pattern => pattern.test(friendshipText))
                    && (mentionsTarget || hasExplicitCue(relationType, evidence, context));
            }
            return mentionsTarget || hasExplicitCue(relationType, evidence, context);
        }

        if (speakerMatchesTarget && !mentionsSource) {
            return false;
        }
    }

    if (relationType === '[HABLA_DE]') {
        if (hasNegativeTalkCue(evidence, context)) {
            return false;
        }
        return hasExplicitCue(relationType, evidence, context)
            && mentionsTarget
            && (mentionsSource || speakerMatchesSource);
    }

    if (relationType === '[SIENTE]' || relationType === '[PLANEA]' || relationType === '[VALOR_CENTRAL]') {
        // Relaciones de Nivel 5: Relaxed grounding
        // Permitimos si hay un cue explícito (ej: "me siento") aunque no se mencione el nombre del sujeto
        // ya que el contexto de "quién habla" suele ser implícito en el chat.
        const ok = hasExplicitCue(relationType, evidence, context);
        return ok && (mentionsSource || mentionsTarget || speakerMatchesSource || privatePair);
    }

    if (relationType === '[RELACIONADO_CON]' || relationType === '[EVENTO_CON]') {
        return hasExplicitCue(relationType, evidence, context)
            && (mentionsSource || speakerMatchesSource || speakerMatchesTarget)
            && mentionsTarget;
    }

    if (relationType === '[AMISTAD]') {
        const friendshipText = `${evidence || ''} ${context || ''}`;
        const hasStrongFriendshipCue = STRONG_FRIENDSHIP_PATTERNS.some(pattern => pattern.test(friendshipText));
        if (!hasStrongFriendshipCue) {
            return false;
        }

        if (mentionsSource && mentionsTarget) {
            return true;
        }

        if (privatePair && (speakerMatchesSource || speakerMatchesTarget)) {
            return true;
        }

        return speakerMatchesSource && mentionsTarget;
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

function hasLeadingArticle(value) {
    return /^(el|la|los|las|un|una)\s+/i.test(String(value || '').trim());
}

function hasLowercaseArticleEntityShape(value) {
    return /^(el|la|los|las|un|una)\s+[a-záéíóúñ]/.test(String(value || '').trim());
}

function isWeakEntityDescription(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) return true;
    return [
        'participante del chat',
        'participante',
        'debatido en la conversacion',
        'debatido en la conversación',
        'mencionado en la conversacion',
        'mencionado en la conversación',
        'comunicacion en el chat',
        'comunicación en el chat',
        'fenomeno meteorologico',
        'fenómeno meteorológico',
        'evento climatico',
        'evento climático',
        'lugar de descanso'
    ].includes(normalized);
}

function matchesWeakEntityDescriptionPattern(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) return true;

    return [
        /^lugar\b/,
        /^objeto\b/,
        /^tema\b/,
        /^asunto\b/,
        /^evento\b/,
        /^mascota\b/,
        /^animal\b/,
        /^fenomeno\b/,
        /^fenómeno\b/,
        /^sitio\b/
    ].some(pattern => pattern.test(normalized));
}

function matchesWeakPersonDescriptionPattern(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) return true;

    return [
        /^interlocutor\b/,
        /^usuario del chat\b/,
        /^mencionado en la conversacion\b/,
        /^mencionado en la conversación\b/,
        /^persona que\b/,
        /^(hijo|hija|hermano|hermana|novio|novia|pareja|amigo|amiga)\b/
    ].some(pattern => pattern.test(normalized));
}

function isWeakRelationshipContext(value) {
    const normalized = normalizeComparableText(value);
    if (!normalized) return true;

    return [
        'conversacion',
        'conversación',
        'chat',
        'mensaje',
        'mensajes',
        'hablan',
        'comentario'
    ].includes(normalized);
}

function isWeakStandaloneEntity({
    name,
    type,
    desc,
    evidence,
    knownNames,
    remoteId,
    isGroup,
    chunkText = '',
    groundedBySpeaker = false,
    groundedByEvidence = false,
    groundedByMention = false
}) {
    const admissibility = evaluateEntityAdmissibility({
        name,
        type: sanitizeEntityType(type),
        desc,
        evidence,
        knownNames,
        remoteId,
        isGroup,
        chunkText,
        groundedBySpeaker,
        groundedByEvidence,
        groundedByMention
    });
    return !admissibility.allowed;
}

export function normalizeEntityName(value, ownerName = null) {
    const rawValue = trimEntityEdges(normalizeEntityLikeText(value));
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

export function deriveEffectiveEntityType(entityName, entityType) {
    const normalizedType = sanitizeEntityType(entityType);
    const identityKind = classifyIdentityLikeName(entityName);

    if (normalizedType === 'PERSONA' && identityKind === 'group_label') {
        return 'GRUPO';
    }

    if (normalizedType === 'PERSONA' && identityKind === 'role_mention') {
        return null;
    }

    return normalizedType;
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

        if (isWeakStandaloneEntity({
            name: normalizedName,
            type: entity?.type,
            desc: entity?.desc || entity?.description || '',
            evidence,
            knownNames,
            remoteId,
            isGroup,
            chunkText,
            groundedBySpeaker,
            groundedByEvidence,
            groundedByMention
        })) {
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
        const relationAdmissibility = evaluateRelationshipAdmissibility({
            relationType,
            sourceEntity,
            targetEntity,
            evidence,
            context: relationship?.context,
            knownNames,
            remoteId,
            isGroup
        });
        if (!relationAdmissibility.allowed) continue;
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

        if (
            relationType === '[HABLA_DE]'
            && isGroup
            && (
                !isPersonLikeEntityType(sourceEntity.type)
                || sanitizeEntityType(sourceEntity.type) === 'GRUPO'
                || normalizeComparableText(sourceEntity.name) === normalizeComparableText(contactName)
            )
            && isPersonLikeEntityType(targetEntity.type)
        ) {
            continue;
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

export function extractDeterministicRelationships({
    chunkText = '',
    ownerName = null,
    contactName = null,
    isGroup = false
}) {
    if (isGroup || !ownerName || !contactName) return [];

    const owner = normalizeEntityName(ownerName, ownerName);
    const contact = normalizeEntityName(contactName, ownerName);
    if (!owner || !contact || owner === contact) return [];

    const lines = String(chunkText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    const results = [];
    const seen = new Set();
    const romanticScores = new Map([
        [owner, { score: 0, lines: [], signals: new Set(), hasDirectedCue: false }],
        [contact, { score: 0, lines: [], signals: new Set(), hasDirectedCue: false }]
    ]);

    for (const line of lines) {
        const normalizedLine = normalizeComparableText(line);
        if (!normalizedLine) continue;
        const speaker = extractEvidenceSpeaker(line, ownerName);
        const speakerKey = normalizeComparableText(speaker);
        const ownerKey = normalizeComparableText(owner);
        const contactKey = normalizeComparableText(contact);

        if (!speakerKey) continue;
        if (![ownerKey, contactKey].includes(speakerKey)) continue;
        if (speakerKey === ownerKey && contactKey.includes(ownerKey)) continue;
        if (speakerKey === contactKey && ownerKey.includes(contactKey)) continue;

        const source = speakerKey === ownerKey ? owner : contact;
        const target = speakerKey === ownerKey ? contact : owner;

        for (const relation of DETERMINISTIC_PRIVATE_RELATIONS) {
            const matchedCue = relation.cues.find(cue => normalizedLine.includes(normalizeComparableText(cue)));
            if (!matchedCue) continue;
            if (relation.type === '[PAREJA_DE]' && !ROMANTIC_VOCATIVE_PATTERNS.some(pattern => pattern.test(line))) {
                continue;
            }
            if (relation.type === '[PAREJA_DE]' && ROMANTIC_NEGATIVE_PATTERNS.some(pattern => pattern.test(line))) {
                continue;
            }
            if (relation.type === '[PAREJA_DE]' && !hasDirectedRomanticAddress(line)) {
                continue;
            }
            if (relation.type === '[AMISTAD]' && !FRIENDSHIP_DIRECT_PATTERNS.some(pattern => pattern.test(line))) {
                continue;
            }

            const key = `${normalizeComparableText(source)}::${relation.type}::${normalizeComparableText(target)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
                source,
                target,
                type: relation.type,
                weight: relation.weight,
                context: clampText(`cue:${matchedCue} | ${line}`, 300),
                evidence: clampText(line, 300)
            });

            if (relation.type === '[PAREJA_DE]') {
                const current = romanticScores.get(source);
                if (current) {
                    current.score += 3;
                    current.lines.push(line);
                    current.signals.add('explicit_romantic');
                    current.hasDirectedCue = true;
                }
            }
        }

        if (hasDirectedRomanticAddress(line)) {
            const current = romanticScores.get(source);
            if (current) {
                current.score += 1;
                current.lines.push(line);
                current.signals.add('vocative');
                current.hasDirectedCue = true;
            }
        }

        if (!ROMANTIC_NEGATIVE_PATTERNS.some(pattern => pattern.test(line)) && !isReportedRomanticContext(line)) {
            const current = romanticScores.get(source);
            if (current) {
                if (ROMANTIC_SECOND_PERSON_PATTERNS.some(pattern => pattern.test(line))) {
                    current.hasDirectedCue = true;
                }
                for (const signal of AFFECTIONATE_PAIR_SIGNALS) {
                    if (!signal.pattern.test(line)) continue;
                    current.score += signal.score;
                    current.lines.push(line);
                    current.signals.add(signal.key);
                }
            }
        }
    }

    const ownerRomantic = romanticScores.get(owner) || { score: 0, lines: [], signals: new Set(), hasDirectedCue: false };
    const contactRomantic = romanticScores.get(contact) || { score: 0, lines: [], signals: new Set(), hasDirectedCue: false };
    const ownerToContactKey = `${normalizeComparableText(owner)}::[PAREJA_DE]::${normalizeComparableText(contact)}`;
    const contactToOwnerKey = `${normalizeComparableText(contact)}::[PAREJA_DE]::${normalizeComparableText(owner)}`;

    if (
        !seen.has(ownerToContactKey)
        && ownerRomantic.hasDirectedCue
        && ownerRomantic.score >= 4
        && ownerRomantic.signals.size >= 2
        && ownerRomantic.lines.some(line => hasDirectedRomanticAddress(line))
    ) {
        seen.add(ownerToContactKey);
        results.push({
            source: owner,
            target: contact,
            type: '[PAREJA_DE]',
            weight: 9,
            context: clampText(`aggregate_romantic_score:${ownerRomantic.score}`, 300),
            evidence: clampText(ownerRomantic.lines[0] || '', 300)
        });
    }

    if (
        !seen.has(contactToOwnerKey)
        && contactRomantic.hasDirectedCue
        && contactRomantic.score >= 4
        && contactRomantic.signals.size >= 2
        && contactRomantic.lines.some(line => hasDirectedRomanticAddress(line))
    ) {
        seen.add(contactToOwnerKey);
        results.push({
            source: contact,
            target: owner,
            type: '[PAREJA_DE]',
            weight: 9,
            context: clampText(`aggregate_romantic_score:${contactRomantic.score}`, 300),
            evidence: clampText(contactRomantic.lines[0] || '', 300)
        });
    }

    return results;
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
