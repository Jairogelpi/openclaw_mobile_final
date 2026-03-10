import { normalizeComparableText } from './message_guard.mjs';

const STRONG_ENTITY_TYPES = new Set(['PERSONA', 'GRUPO', 'PROYECTO', 'ORGANIZACION']);
const MEDIUM_ENTITY_TYPES = new Set(['LUGAR', 'EVENTO', 'TEMA']);
const WEAK_ENTITY_TYPES = new Set(['OBJETO', 'ENTITY']);

const GENERIC_DESCRIPTIONS = [
    'usuario del chat',
    'interlocutor',
    'participante',
    'mencionado en la conversacion',
    'mencionado en la conversación',
    'conversación',
    'chat'
];

const RELATION_TYPE_BONUS = new Map([
    ['[AMISTAD]', 3],
    ['[PAREJA_DE]', 4],
    ['[FAMILIA_DE]', 4],
    ['[TRABAJA_EN]', 3],
    ['[VIVE_EN]', 3],
    ['[ESTUDIA_EN]', 3],
    ['[USA]', 2],
    ['[POSEE]', 2],
    ['[CONOCE_A]', 1],
    ['[HABLA_DE]', -2],
    ['[RELACIONADO_CON]', -5],
    ['[EVENTO_CON]', -3]
]);

const MEDIA_CONTEXT_PATTERNS = [
    /\b(audio|nota de voz|voz|video|foto|imagen|documento|archivo|pdf|clip)\b/,
    /\bpersonaje de un video\b/,
    /\bconversacion sobre un video\b/,
    /\bconversación sobre un video\b/
];

const TEMPORAL_EPHEMERAL_PATTERNS = [
    /\b(hoy|ayer|anoche|mañana|manana|esta tarde|esta noche|este finde|este jueves|este viernes|este sabado|este sábado)\b/,
    /\b(esta semana|la semana pasada|el otro dia|el otro día)\b/
];

const RELATION_CONTEXT_CUES = new Map([
    ['[HABLA_DE]', ['habla de', 'hablar de', 'sobre', 'menciona', 'comenta', 'pregunta por', 'dice de']],
    ['[RELACIONADO_CON]', ['relacionado con', 'conectado con', 'asociado con', 'vinculado con', 'tiene que ver con']],
    ['[EVENTO_CON]', ['con', 'junto a', 'acompanado de', 'acompañado de']]
]);

const NEGATIVE_TALKS_ABOUT_PATTERNS = [
    /\bhablar con\b/,
    /\bquiere hablar con\b/,
    /\bhablo con\b/,
    /\bhabló con\b/,
    /\brespuesta sobre\b/,
    /\brespuesta a\b/,
    /\bcontesta a\b/,
    /\bcontestó a\b/,
    /\bgracias\b/,
    /\bexpresion de afecto\b/,
    /\bexpresión de afecto\b/
];

const GENERIC_RELATION_CONTEXT_PATTERNS = [
    /\breferencia a una persona\b/i,
    /\breferencia personal\b/i,
    /\binterlocutor\b/i,
    /\busuario del chat\b/i,
    /\bmencionado en la conversacion\b/i,
    /\bmencionado en la conversación\b/i,
    /\bintercambio de mensajes\b/i,
    /\bhablando\b/i
];

const STRONG_FRIENDSHIP_CONTEXT_PATTERNS = [
    /\bes mi amig[oa]\b/i,
    /\beres mi amig[oa]\b/i,
    /\bsois amig[oa]s\b/i,
    /\bsomos amig[oa]s\b/i,
    /\bmi mejor amig[oa]\b/i,
    /\bgran amig[oa]\b/i
];

function normalizedText(value) {
    return normalizeComparableText(String(value || ''));
}

function descriptionPenalty(description = '') {
    const normalized = normalizedText(description);
    if (!normalized) return -2;
    if (GENERIC_DESCRIPTIONS.includes(normalized)) return -3;
    if (normalized.length < 12) return -1;
    return 0;
}

function articlePenalty(name = '') {
    const raw = String(name || '').trim();
    if (!/^(el|la|los|las|un|una)\s+/i.test(raw)) return 0;
    if (/^(el|la|los|las)\s+[A-ZÁÉÍÓÚÑ0-9]{2,}(?:\s+[A-ZÁÉÍÓÚÑ0-9]{2,})*$/u.test(raw)) return 0;
    return -2;
}

function entityTypeScore(entityType = '') {
    const type = String(entityType || '').trim().toUpperCase();
    if (STRONG_ENTITY_TYPES.has(type)) return 3;
    if (MEDIUM_ENTITY_TYPES.has(type)) return 2;
    if (WEAK_ENTITY_TYPES.has(type)) return 1;
    return 0;
}

function sourceBonus(source = '') {
    const normalized = normalizedText(source);
    if (!normalized) return 0;
    if (['auto_soul', 'owner_profile', 'identity_registry'].includes(normalized)) return 4;
    if (['grounded_extraction', 'whatsapp_grounded'].includes(normalized)) return 2;
    if (['dream_cycle', 'latent'].includes(normalized)) return -4;
    return 0;
}

function mediaPenalty(text = '') {
    const raw = String(text || '');
    if (!raw) return 0;
    return MEDIA_CONTEXT_PATTERNS.some(pattern => pattern.test(raw)) ? -3 : 0;
}

function temporalPenalty(text = '') {
    const raw = String(text || '');
    if (!raw) return 0;
    return TEMPORAL_EPHEMERAL_PATTERNS.some(pattern => pattern.test(raw)) ? -2 : 0;
}

function hasRelationCue(relationType = '', text = '') {
    const cues = RELATION_CONTEXT_CUES.get(String(relationType || '').trim());
    if (!cues?.length) return false;
    const haystack = normalizedText(text);
    return cues.some(cue => haystack.includes(normalizedText(cue)));
}

function hasNegativeTalkCue(text = '') {
    const raw = String(text || '');
    if (!raw) return false;
    return NEGATIVE_TALKS_ABOUT_PATTERNS.some(pattern => pattern.test(raw));
}

function hasGenericRelationContext(text = '') {
    const raw = String(text || '');
    if (!raw) return false;
    return GENERIC_RELATION_CONTEXT_PATTERNS.some(pattern => pattern.test(raw));
}

function hasStrongFriendshipContext(text = '') {
    const raw = String(text || '');
    if (!raw) return false;
    return STRONG_FRIENDSHIP_CONTEXT_PATTERNS.some(pattern => pattern.test(raw));
}

export function computeNodeStability({
    entityName,
    entityType,
    description,
    supportCount = 1,
    source = '',
    sourceTags = [],
    existingScore = 0,
    existingTier = 'candidate'
} = {}) {
    const normalizedName = normalizedText(entityName);
    if (!normalizedName) {
        return { score: 0, tier: 'candidate', promote: false };
    }

    let score = entityTypeScore(entityType);
    score += Math.min(Number(supportCount || 1), 5) - 1;
    score += sourceBonus(source);
    score += Math.min(new Set((sourceTags || []).map(normalizedText).filter(Boolean)).size, 3) - 1;
    score += descriptionPenalty(description);
    score += articlePenalty(entityName);
    score += mediaPenalty(description);
    score += temporalPenalty(description);

    if (description && description.startsWith('[ALMA]')) score += 5;
    if (normalizedName.length >= 5) score += 1;

    score = Math.max(score, Number(existingScore || 0));

    let tier = 'candidate';
    if (score >= 8) tier = 'stable';
    else if (score >= 4) tier = 'provisional';
    else if (existingTier === 'stable' || existingTier === 'provisional') tier = existingTier;

    return {
        score,
        tier,
        promote: tier !== 'candidate'
    };
}

export function computeEdgeStability({
    relationType,
    context,
    weight = 1,
    supportCount = 1,
    source = '',
    sourceTags = [],
    flags = [],
    existingScore = 0,
    existingTier = 'candidate'
} = {}) {
    const normalizedRelation = String(relationType || '').trim();
    const normalizedContext = normalizedText(context);
    const flagsText = (Array.isArray(flags) ? flags : [flags]).map(normalizedText).filter(Boolean);
    const support = Number(supportCount || 1);

    let score = RELATION_TYPE_BONUS.get(normalizedRelation) ?? 0;
    score += Math.min(Number(weight || 1), 5) - 1;
    score += Math.min(support, 5) - 1;
    score += sourceBonus(source);
    score += Math.min(new Set((sourceTags || []).map(normalizedText).filter(Boolean)).size, 3) - 1;

    if (!normalizedContext) score -= 2;
    else if (normalizedContext.length >= 20) score += 1;
    else if (['conversacion', 'conversación', 'chat', 'comunicacion', 'comunicación'].includes(normalizedContext)) score -= 2;

    if (flagsText.some(flag => ['derived', 'latent', 'dream_cycle'].includes(flag))) score -= 4;
    if (flagsText.some(flag => ['direct', 'grounded'].includes(flag))) score += 1;
    if (flagsText.some(flag => ['conflicted', 'temporal_only', 'media_only'].includes(flag))) score -= 3;
    if (hasGenericRelationContext(context)) score -= 4;

    score += mediaPenalty(context);
    score += temporalPenalty(context);

    if (['[RELACIONADO_CON]', '[HABLA_DE]'].includes(normalizedRelation) && support < 2) {
        score -= 3;
    }

    if (normalizedRelation === '[RELACIONADO_CON]') {
        if (support < 3) score -= 4;
        if (!normalizedContext || normalizedContext.length < 24) score -= 2;
        if (!hasRelationCue(normalizedRelation, context)) score -= 4;
    }

    if (normalizedRelation === '[HABLA_DE]') {
        if (support < 3) score -= 2;
        if (!normalizedContext || normalizedContext.length < 16) score -= 1;
        if (!hasRelationCue(normalizedRelation, context)) score -= 3;
        if (hasNegativeTalkCue(context)) score -= 4;
    }

    if (normalizedRelation === '[EVENTO_CON]' && support < 2) {
        score -= 2;
        if (!hasRelationCue(normalizedRelation, context)) score -= 2;
    }

    if (['[AMISTAD]', '[CONOCE_A]', '[PAREJA_DE]', '[FAMILIA_DE]'].includes(normalizedRelation) && hasGenericRelationContext(context)) {
        score -= 3;
    }

    if (normalizedRelation === '[AMISTAD]' && !hasStrongFriendshipContext(context)) {
        score -= 4;
    }

    score = Math.max(score, Number(existingScore || 0));

    let tier = 'candidate';
    if (score >= 9) tier = 'stable';
    else if (score >= 5) tier = 'provisional';
    else if (
        !['[RELACIONADO_CON]', '[HABLA_DE]', '[EVENTO_CON]'].includes(normalizedRelation)
        && (existingTier === 'stable' || existingTier === 'provisional')
    ) {
        tier = existingTier;
    }

    if (normalizedRelation === '[RELACIONADO_CON]' && support < 3) {
        tier = 'candidate';
    }

    if (normalizedRelation === '[HABLA_DE]' && support < 2) {
        tier = 'candidate';
    }

    if (normalizedRelation === '[HABLA_DE]' && hasNegativeTalkCue(context)) {
        tier = 'candidate';
    }

    if (normalizedRelation === '[EVENTO_CON]' && support < 2) {
        tier = 'candidate';
    }

    if (
        ['[AMISTAD]', '[CONOCE_A]', '[PAREJA_DE]', '[FAMILIA_DE]'].includes(normalizedRelation)
        && hasGenericRelationContext(context)
        && support < 2
    ) {
        tier = 'candidate';
    }

    if (normalizedRelation === '[AMISTAD]' && !hasStrongFriendshipContext(context)) {
        tier = 'candidate';
    }

    return {
        score,
        tier,
        promote: tier !== 'candidate'
    };
}

export function isStableTier(tier) {
    return ['provisional', 'stable'].includes(String(tier || '').trim().toLowerCase());
}
