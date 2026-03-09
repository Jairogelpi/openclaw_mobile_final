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
    ['[HABLA_DE]', 0],
    ['[RELACIONADO_CON]', -2],
    ['[EVENTO_CON]', -1]
]);

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

export function computeNodeStability({
    entityName,
    entityType,
    description,
    supportCount = 1,
    source = '',
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
    score += descriptionPenalty(description);
    score += articlePenalty(entityName);

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
    flags = [],
    existingScore = 0,
    existingTier = 'candidate'
} = {}) {
    const normalizedRelation = String(relationType || '').trim();
    const normalizedContext = normalizedText(context);
    const flagsText = (Array.isArray(flags) ? flags : [flags]).map(normalizedText).filter(Boolean);

    let score = RELATION_TYPE_BONUS.get(normalizedRelation) ?? 0;
    score += Math.min(Number(weight || 1), 5) - 1;
    score += Math.min(Number(supportCount || 1), 5) - 1;
    score += sourceBonus(source);

    if (!normalizedContext) score -= 2;
    else if (normalizedContext.length >= 20) score += 1;
    else if (['conversacion', 'conversación', 'chat', 'comunicacion', 'comunicación'].includes(normalizedContext)) score -= 2;

    if (flagsText.some(flag => ['derived', 'latent', 'dream_cycle'].includes(flag))) score -= 4;
    if (flagsText.some(flag => ['direct', 'grounded'].includes(flag))) score += 1;

    score = Math.max(score, Number(existingScore || 0));

    let tier = 'candidate';
    if (score >= 9) tier = 'stable';
    else if (score >= 5) tier = 'provisional';
    else if (existingTier === 'stable' || existingTier === 'provisional') tier = existingTier;

    return {
        score,
        tier,
        promote: tier !== 'candidate'
    };
}

export function isStableTier(tier) {
    return ['provisional', 'stable'].includes(String(tier || '').trim().toLowerCase());
}
