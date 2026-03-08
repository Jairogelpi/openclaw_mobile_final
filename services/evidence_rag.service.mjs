import groq from './groq.mjs';
import supabase from '../config/supabase.mjs';
import {
    exactEntityFactSearch,
    exactEntityMemorySearch,
    hybridSearchV2,
    exactRelationshipSearch,
    mediaMemorySearch,
    temporalMemorySearch,
    traverseGraphV2
} from './graph.service.mjs';
import {
    getIdentityRows,
    hydrateContactIdentities,
    resolveIdentityCandidates,
    resolveIdentityNames
} from './identity.service.mjs';
import { rerankEvidenceCandidates } from './reranker.mjs';
import { getConfig } from './config.service.mjs';
import { normalizeComparableText } from '../utils/message_guard.mjs';

const DEFAULT_PLAN = {
    intent: 'exploratory',
    entities: [],
    temporal_window: null,
    relation_filter: null,
    need_exact_entity_match: false,
    allow_graph_hops: true,
    allow_web: false
};

const RELATION_QUERY_EXPANSIONS = {
    FAMILIA_DE: ['familia', 'madre', 'padre', 'hermano', 'hermana', 'hijo', 'hija', 'primo'],
    PAREJA_DE: ['pareja', 'novia', 'novio', 'amor', 'esposa', 'esposo'],
    AMISTAD: ['amigo', 'amiga', 'colega', 'bro'],
    TRABAJA_EN: ['trabaja', 'curro', 'empleo', 'empresa'],
    VIVE_EN: ['vive', 'casa', 'ciudad'],
    ESTUDIA_EN: ['estudia', 'universidad', 'instituto']
};

const SIMPLE_IDENTITY_INTENT_REGEX = /\b(quien es|quien era|quien fue|como se llama|que sabes de|hablame de|dime de)\b/;
const SIMPLE_FACT_INTENT_REGEX = /\b(donde|vive|trabaja|estudia|edad|cumpleanos|cumpleaños|numero|número|direccion|dirección)\b/;

const SIMPLE_MEDIA_INTENT_REGEX = /\b(audio|nota de voz|voz|foto|imagen|video|documento|pdf|archivo|media)\b/;
const GENERIC_RELATION_INTENT_REGEX = /\b(que relacion hay entre|que relaci[oÃ³]n hay entre|como se relacionan|relacion entre|relaciona a)\b/;
const GHOST_NAME_PREFIXES = ['persona fantasma', 'personafantasma', 'ghost person', 'ghostperson'];

async function groqJsonWithTimeout({ systemPrompt, userPrompt }, trace = null, {
    model = 'llama-3.1-8b-instant',
    temperature = 0,
    timeoutMs = 12_000
} = {}) {
    trace?.addLLMCall?.();
    const response = await Promise.race([
        groq.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            response_format: { type: 'json_object' },
            temperature
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Groq timeout after ${timeoutMs}ms`)), timeoutMs))
    ]);

    return parseLLMJson(response.choices[0].message.content, null);
}

function parseLLMJson(text, fallback = null) {
    try {
        const cleaned = String(text || '').replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);
    } catch (error) {
        return fallback;
    }
}

function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function toIso(date, boundary = 'start') {
    const value = new Date(date);
    if (boundary === 'start') value.setHours(0, 0, 0, 0);
    if (boundary === 'end') value.setHours(23, 59, 59, 999);
    return value.toISOString();
}

function inferTemporalWindow(queryText) {
    const q = normalizeComparableText(queryText);
    if (!q) return null;

    const now = new Date();
    const dayOfWeek = ['domingo', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'viernes', 'sabado', 'sábado'];

    if (q.includes('hoy')) {
        return { label: 'hoy', start: toIso(now, 'start'), end: toIso(now, 'end') };
    }
    if (q.includes('ayer')) {
        const yesterday = addDays(now, -1);
        return { label: 'ayer', start: toIso(yesterday, 'start'), end: toIso(yesterday, 'end') };
    }
    if (q.includes('anoche')) {
        const yesterday = addDays(now, -1);
        const start = new Date(yesterday);
        start.setHours(18, 0, 0, 0);
        const end = new Date(now);
        end.setHours(3, 0, 0, 0);
        return { label: 'anoche', start: start.toISOString(), end: end.toISOString() };
    }
    if (q.includes('semana pasada') || q.includes('la semana pasada')) {
        const end = addDays(now, -7);
        const start = addDays(end, -6);
        return { label: 'semana_pasada', start: toIso(start, 'start'), end: toIso(end, 'end') };
    }
    if (q.includes('este mes')) {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        return { label: 'este_mes', start: toIso(start, 'start'), end: toIso(end, 'end') };
    }

    const matchedDay = dayOfWeek.find(day => q.includes(day));
    if (matchedDay) {
        const target = new Date(now);
        const normalizedDay = matchedDay.replace('miércoles', 'miercoles').replace('sábado', 'sabado');
        const currentDay = dayOfWeek[now.getDay()].replace('miércoles', 'miercoles').replace('sábado', 'sabado');
        let delta = dayOfWeek.findIndex(day => day.replace('miércoles', 'miercoles').replace('sábado', 'sabado') === normalizedDay) -
            dayOfWeek.findIndex(day => day.replace('miércoles', 'miercoles').replace('sábado', 'sabado') === currentDay);
        if (delta > 0) delta -= 7;
        target.setDate(target.getDate() + delta);
        return { label: matchedDay, start: toIso(target, 'start'), end: toIso(target, 'end') };
    }

    return null;
}

function inferTemporalWindowStable(queryText) {
    const q = normalizeComparableText(queryText);
    if (!q) return null;

    const now = new Date();
    const dayIndexMap = new Map([
        ['domingo', 0],
        ['lunes', 1],
        ['martes', 2],
        ['miercoles', 3],
        ['miércoles', 3],
        ['jueves', 4],
        ['viernes', 5],
        ['sabado', 6],
        ['sábado', 6]
    ]);

    if (q.includes('hoy')) {
        return { label: 'hoy', start: toIso(now, 'start'), end: toIso(now, 'end') };
    }
    if (q.includes('ayer')) {
        const yesterday = addDays(now, -1);
        return { label: 'ayer', start: toIso(yesterday, 'start'), end: toIso(yesterday, 'end') };
    }
    if (q.includes('anoche')) {
        const yesterday = addDays(now, -1);
        const start = new Date(yesterday);
        start.setHours(18, 0, 0, 0);
        const end = new Date(now);
        end.setHours(3, 0, 0, 0);
        return { label: 'anoche', start: start.toISOString(), end: end.toISOString() };
    }
    if (q.includes('semana pasada') || q.includes('la semana pasada')) {
        const end = addDays(now, -7);
        const start = addDays(end, -6);
        return { label: 'semana_pasada', start: toIso(start, 'start'), end: toIso(end, 'end') };
    }
    if (q.includes('este mes')) {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        return { label: 'este_mes', start: toIso(start, 'start'), end: toIso(end, 'end') };
    }

    const matchedDay = [...dayIndexMap.keys()].find(day => q.includes(day));
    if (matchedDay) {
        const target = new Date(now);
        let delta = Number(dayIndexMap.get(matchedDay)) - now.getDay();
        if (delta > 0) delta -= 7;
        target.setDate(target.getDate() + delta);
        return { label: matchedDay, start: toIso(target, 'start'), end: toIso(target, 'end') };
    }

    return null;
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholePhrase(text, phrase) {
    const normalizedText = normalizeComparableText(text);
    const normalizedPhrase = normalizeComparableText(phrase);
    if (!normalizedText || !normalizedPhrase || normalizedPhrase.length < 3) return false;
    const regex = new RegExp(`(^|\\b)${escapeRegex(normalizedPhrase)}(\\b|$)`, 'i');
    return regex.test(normalizedText);
}

async function detectIdentityMatchesFromQuery(clientId, userQuery) {
    const rows = await getIdentityRows(clientId).catch(() => []);
    const matches = [];

    for (const row of rows) {
        const aliases = [...new Set([row.canonical_name, ...(row.aliases || [])].filter(Boolean))];
        const matched = aliases.some(alias => containsWholePhrase(userQuery, alias));
        if (!matched) continue;
        matches.push({
            ...row,
            aliases
        });
    }

    return matches
        .sort((a, b) => {
            const aOwner = a.remote_id === 'self' || a.source_details?.owner_identity ? 1 : 0;
            const bOwner = b.remote_id === 'self' || b.source_details?.owner_identity ? 1 : 0;
            const aLen = Math.max(...a.aliases.map(alias => normalizeComparableText(alias).length));
            const bLen = Math.max(...b.aliases.map(alias => normalizeComparableText(alias).length));
            return bOwner - aOwner || bLen - aLen || Number(b.confidence || 0) - Number(a.confidence || 0);
        })
        .slice(0, 8);
}

async function detectIdentityMatchesFromQueryFast(clientId, userQuery) {
    const matches = [];
    const seen = new Set();
    let soulRow = null;
    try {
        const { data } = await supabase
            .from('user_souls')
            .select('soul_json')
            .eq('client_id', clientId)
            .maybeSingle();
        soulRow = data || null;
    } catch (error) {
        soulRow = null;
    }

    const ownerAliases = [
        soulRow?.soul_json?.nombre,
        soulRow?.soul_json?.profile?.name,
        soulRow?.soul_json?.profile?.nombre
    ].filter(Boolean);

    if (ownerAliases.some(alias => containsWholePhrase(userQuery, alias))) {
        matches.push({
            client_id: clientId,
            remote_id: 'self',
            canonical_name: ownerAliases[0],
            aliases: ownerAliases,
            confidence: 1
        });
        seen.add(normalizeComparableText(ownerAliases[0]));
    }

    const rows = await getIdentityRows(clientId).catch(() => []);
    for (const row of rows) {
        const aliases = [...new Set([row.canonical_name, ...(row.aliases || [])].filter(Boolean))];
        const matched = aliases.some(alias => containsWholePhrase(userQuery, alias));
        if (!matched) continue;
        const key = normalizeComparableText(row.canonical_name);
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
            ...row,
            aliases
        });
    }

    return matches
        .sort((a, b) => {
            const aLen = Math.max(...a.aliases.map(alias => normalizeComparableText(alias).length));
            const bLen = Math.max(...b.aliases.map(alias => normalizeComparableText(alias).length));
            return bLen - aLen || Number(b.confidence || 0) - Number(a.confidence || 0);
        })
        .slice(0, 8);
}

function fallbackIntent(queryText) {
    const q = normalizeComparableText(queryText);
    if (/\b(quien es|quién es|como se llama|quien era)\b/.test(q)) return 'identity_lookup';
    if (/\b(madre|padre|novia|novio|pareja|familia|relacion|relación|amigo|conoce)\b/.test(q)) return 'relationship_lookup';
    if (/\b(ayer|hoy|anoche|semana pasada|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/.test(q)) return 'temporal_lookup';
    if (/\b(trabaja|vive|estudia|cumpleanos|cumpleaños|edad|numero|número|direccion|dirección)\b/.test(q)) return 'fact_lookup';
    return 'exploratory';
}

function isSimpleExactLookup(queryText, identityMatches = [], inferredEntities = []) {
    const q = normalizeComparableText(queryText);
    if (!q) return false;
    const hasEntityAnchor = Boolean(identityMatches.length || inferredEntities.length);
    if (!hasEntityAnchor) return false;
    if (hasTemporalSignal(queryText) || relationFromQueryV2(queryText)) return false;
    return SIMPLE_IDENTITY_INTENT_REGEX.test(q) || SIMPLE_FACT_INTENT_REGEX.test(q) || SIMPLE_MEDIA_INTENT_REGEX.test(q);
}

function determineFallbackIntent(queryText, identityMatches = []) {
    const q = normalizeComparableText(queryText);
    if (identityMatches.length) {
        if (SIMPLE_IDENTITY_INTENT_REGEX.test(q) || /\bque recuerdas de\b/.test(q)) return 'identity_lookup';
        if (SIMPLE_FACT_INTENT_REGEX.test(q)) return 'fact_lookup';
    }
    return fallbackIntent(queryText);
}

function relationFromQuery(queryText) {
    const q = normalizeComparableText(queryText);
    if (/\b(madre|padre|hermano|hermana|hijo|hija|familia)\b/.test(q)) return 'FAMILIA_DE';
    if (/\b(novia|novio|pareja|esposa|esposo)\b/.test(q)) return 'PAREJA_DE';
    if (/\b(amigo|amistad)\b/.test(q)) return 'AMISTAD';
    if (/\b(trabaja)\b/.test(q)) return 'TRABAJA_EN';
    if (/\b(vive)\b/.test(q)) return 'VIVE_EN';
    if (/\b(estudia)\b/.test(q)) return 'ESTUDIA_EN';
    return null;
}

function hasTemporalSignal(queryText) {
    const q = normalizeComparableText(queryText);
    return /\b(hoy|ayer|anoche|semana pasada|este mes|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(q);
}

function hasMediaSignal(queryText) {
    return SIMPLE_MEDIA_INTENT_REGEX.test(normalizeComparableText(queryText));
}

function fallbackIntentV2(queryText) {
    const q = normalizeComparableText(queryText);
    if (/\b(quien es|quiÃ©n es|como se llama|quien era)\b/.test(q)) return 'identity_lookup';
    if (SIMPLE_MEDIA_INTENT_REGEX.test(q)) return 'media_lookup';
    if (/\b(madre|padre|novia|novio|pareja|familia|relacion|relaciÃ³n|amigo|conoce)\b/.test(q)) return 'relationship_lookup';
    if (/\b(ayer|hoy|anoche|semana pasada|martes|miercoles|miÃ©rcoles|jueves|viernes|sabado|sÃ¡bado|domingo)\b/.test(q)) return 'temporal_lookup';
    if (/\b(trabaja|vive|estudia|cumpleanos|cumpleaÃ±os|edad|numero|nÃºmero|direccion|direcciÃ³n)\b/.test(q)) return 'fact_lookup';
    return 'exploratory';
}

function determineFallbackIntentV2(queryText, identityMatches = []) {
    const q = normalizeComparableText(queryText);
    if (SIMPLE_MEDIA_INTENT_REGEX.test(q)) return 'media_lookup';
    if (identityMatches.length) {
        if (SIMPLE_IDENTITY_INTENT_REGEX.test(q) || /\bque recuerdas de\b/.test(q)) return 'identity_lookup';
        if (SIMPLE_FACT_INTENT_REGEX.test(q)) return 'fact_lookup';
    }
    return fallbackIntentV2(queryText);
}

function relationFromQueryV2(queryText) {
    const q = normalizeComparableText(queryText);
    if (GENERIC_RELATION_INTENT_REGEX.test(q) || /\brelacion\b/.test(q)) return 'ANY_RELATION';
    if (/\b(madre|padre|hermano|hermana|hijo|hija|familia)\b/.test(q)) return 'FAMILIA_DE';
    if (/\b(novia|novio|pareja|esposa|esposo)\b/.test(q)) return 'PAREJA_DE';
    if (/\b(amigo|amistad)\b/.test(q)) return 'AMISTAD';
    if (/\b(trabaja)\b/.test(q)) return 'TRABAJA_EN';
    if (/\b(vive)\b/.test(q)) return 'VIVE_EN';
    if (/\b(estudia)\b/.test(q)) return 'ESTUDIA_EN';
    return null;
}

function inferRawEntitiesFromQuery(queryText) {
    const source = String(queryText || '');
    if (!source.trim()) return [];

    const patterns = [
        /\bquien es\s+(.+?)$/i,
        /\bque sabes de\s+(.+?)$/i,
        /\bque recuerdas de\s+(.+?)$/i,
        /\brecuerdas (?:el|la|los|las)?\s*(?:audio|nota de voz|foto|imagen|video|documento|pdf|archivo)?\s*(?:de|sobre)?\s+(.+?)$/i,
        /\bque paso con\s+(.+?)\s+(?:el|la)?\s*(hoy|ayer|anoche|semana pasada|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/i,
        /\bque relacion hay entre\s+(.+?)\s+y\s+(.+?)$/i,
        /\bcomo se relacionan\s+(.+?)\s+y\s+(.+?)$/i
    ];

    const entities = [];
    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (!match) continue;
        for (const group of match.slice(1)) {
            const cleaned = String(group || '')
                .replace(/\b(hoy|ayer|anoche|semana pasada|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/gi, '')
                .replace(/[?!.,"']/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (cleaned.length >= 2) entities.push(cleaned);
        }
    }

    return [...new Set(entities)];
}

function isGhostName(entity) {
    const normalized = normalizeComparableText(entity);
    if (!normalized) return false;
    return GHOST_NAME_PREFIXES.some(prefix => normalized.startsWith(prefix)) || /fantasma\d+/i.test(entity);
}

function buildRetrievalQueries(queryText, plan, maxVariants = 4) {
    const exactLookup = Boolean(
        plan.need_exact_entity_match &&
        (plan.entities || []).length &&
        ['identity_lookup', 'fact_lookup'].includes(plan.intent)
    );
    const variants = [];
    const addVariant = value => {
        const normalized = normalizeComparableText(value);
        if (!normalized || normalized.length < 2) return;
        if (variants.some(item => normalizeComparableText(item) === normalized)) return;
        variants.push(String(value).trim());
    };

    addVariant(queryText);

    if (exactLookup) {
        for (const entity of (plan.entities || []).slice(0, 2)) addVariant(entity);
        return variants.slice(0, Math.max(1, Math.min(maxVariants, 2)));
    }

    for (const entity of (plan.entities || [])) {
        addVariant(entity);
        if (plan.intent === 'relationship_lookup' || plan.intent === 'temporal_lookup') {
            addVariant(`que sabes de ${entity}`);
        }
    }

    if (plan.relation_filter) {
        const expandedTerms = RELATION_QUERY_EXPANSIONS[plan.relation_filter] || [plan.relation_filter];
        const entitySpan = (plan.entities || []).join(' ').trim();
        if (entitySpan) {
            addVariant(`${entitySpan} ${expandedTerms.slice(0, 3).join(' ')}`);
        }
        for (const term of expandedTerms.slice(0, 3)) addVariant(term);
    }

    if (plan.temporal_window?.label) {
        const entitySpan = (plan.entities || []).join(' ').trim();
        if (entitySpan) addVariant(`${entitySpan} ${plan.temporal_window.label}`);
    }

    if ((plan.intent === 'relationship_lookup' || plan.intent === 'media_lookup') && (plan.entities || []).length >= 2) {
        addVariant((plan.entities || []).join(' '));
    }

    if (plan.intent === 'media_lookup') {
        const entitySpan = (plan.entities || []).join(' ').trim();
        if (entitySpan) addVariant(`${entitySpan} audio foto video`);
    }

    return variants.slice(0, Math.max(1, maxVariants));
}

async function collectHybridRecall(clientId, queryText, queryVector, queryVariants, perVariantCount) {
    const collected = [];

    for (const variant of queryVariants) {
        // Reuse the base query embedding for lexical variants to avoid redundant local embedding cost.
        const rows = await hybridSearchV2(clientId, variant, queryVector, perVariantCount).catch(() => []);
        collected.push(...rows.map(row => ({
            ...row,
            retrieval_query: variant
        })));
    }

    return collected;
}

function dedupeCandidates(candidates) {
    const seen = new Set();
    return (candidates || []).filter(candidate => {
        let key = `${candidate.source_kind}:${candidate.source_id}`;
        if (candidate?.source_kind === 'memory_chunk') {
            const remoteId = normalizeComparableText(candidate.remote_id || candidate.metadata?.remoteId || candidate.metadata?.remote_id || '');
            const timestamp = String(candidate.timestamp || '').slice(0, 19);
            const signature = normalizeComparableText(
                String(candidate.evidence_text || '')
                    .replace(/\[[^\]]+\]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
            ).slice(0, 260);
            if (signature) {
                key = `${candidate.source_kind}:${remoteId}:${timestamp}:${signature}`;
            }
        }
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function assignCitationLabels(candidates) {
    return (candidates || []).map((candidate, index) => ({
        ...candidate,
        citation_label: `E${index + 1}`
    }));
}

function buildIdentityResolutionMapFromMatches(identityMatches = []) {
    const resolved = new Map();
    for (const row of (identityMatches || [])) {
        const aliases = [...new Set([row.canonical_name, ...(row.aliases || [])].filter(Boolean))];
        for (const alias of aliases) {
            const normalized = normalizeComparableText(alias);
            if (!normalized || resolved.has(normalized)) continue;
            resolved.set(normalized, {
                canonicalName: row.canonical_name,
                remoteId: row.remote_id,
                aliases
            });
        }
    }
    return resolved;
}

export async function buildRagQueryPlan(clientId, userQuery, trace = null) {
    await hydrateContactIdentities(clientId).catch(() => null);

    const identityMatches = await detectIdentityMatchesFromQueryFast(clientId, userQuery);
    const inferredEntities = inferRawEntitiesFromQuery(userQuery);
    const identityHints = identityMatches
        .slice(0, 8)
        .map(match => `${match.canonical_name} (${match.remote_id})`)
        .join(', ');

    const systemPrompt = `Eres un planificador de retrieval para un RAG evidence-first.

Devuelve SOLO JSON con:
{
  "intent": "identity_lookup|relationship_lookup|fact_lookup|temporal_lookup|media_lookup|exploratory",
  "entities": ["nombre canonico"],
  "temporal_window": { "label": "string", "start": "ISO8601|null", "end": "ISO8601|null" } | null,
  "relation_filter": "string|null",
  "need_exact_entity_match": boolean,
  "allow_graph_hops": boolean,
  "allow_web": boolean
}

Reglas:
- Prioriza exactitud sobre cobertura.
- allow_web debe ser false salvo que la pregunta sea claramente sobre hechos publicos externos.
- Para preguntas sobre personas, activa need_exact_entity_match.
- Para preguntas temporales, rellena temporal_window si se puede inferir.
 - Para preguntas relacionales, usa relation_filter si procede.
 - Para preguntas sobre audios, fotos, videos o documentos, usa intent=media_lookup y evita graph hops.

Ejemplo valido:
{
  "intent": "identity_lookup",
  "entities": ["Mireya"],
  "temporal_window": null,
  "relation_filter": null,
  "need_exact_entity_match": true,
  "allow_graph_hops": false,
  "allow_web": false
}`;

    const userPrompt = `Pregunta del usuario: ${userQuery}
Identidades candidatas ya vistas: ${identityHints || 'ninguna relevante'}
Responde solo con el JSON del plan.`;

    const fallbackPlan = {
        ...DEFAULT_PLAN,
        intent: determineFallbackIntentV2(userQuery, identityMatches),
        entities: [...new Set([
            ...identityMatches.map(match => match.canonical_name),
            ...inferredEntities
        ])].slice(0, 3),
        temporal_window: inferTemporalWindowStable(userQuery) || inferTemporalWindow(userQuery),
        relation_filter: relationFromQueryV2(userQuery),
        need_exact_entity_match: identityMatches.length > 0 || inferredEntities.length > 0,
        allow_graph_hops: !hasMediaSignal(userQuery),
        allow_web: false,
        identity_match_count: identityMatches.length
    };

    let plan = null;
    if (!isSimpleExactLookup(userQuery, identityMatches, inferredEntities)) {
        try {
            plan = await groqJsonWithTimeout({ systemPrompt, userPrompt }, trace, { temperature: 0, timeoutMs: 8_000 });
        } catch (error) {
            console.warn('[Evidence RAG] Planner fallback:', error.message);
        }
    }

    const nextPlan = {
        ...fallbackPlan,
        ...(plan || {})
    };

    if (!nextPlan.temporal_window) {
        nextPlan.temporal_window = inferTemporalWindowStable(userQuery) || inferTemporalWindow(userQuery);
    }
    const deterministicTemporalWindow = inferTemporalWindowStable(userQuery) || inferTemporalWindow(userQuery);
    if (deterministicTemporalWindow && hasTemporalSignal(userQuery)) {
        nextPlan.temporal_window = deterministicTemporalWindow;
    }
    if (!nextPlan.relation_filter) {
        nextPlan.relation_filter = relationFromQueryV2(userQuery);
    }
    if ((!nextPlan.entities || !nextPlan.entities.length) && identityMatches.length) {
        nextPlan.entities = identityMatches.map(match => match.canonical_name).slice(0, 3);
    }
    if ((!nextPlan.entities || !nextPlan.entities.length)) {
        nextPlan.entities = inferredEntities.slice(0, 3);
    }
    nextPlan.need_exact_entity_match = Boolean(nextPlan.need_exact_entity_match || nextPlan.entities?.length || identityMatches.length);
    if (isSimpleExactLookup(userQuery, identityMatches, inferredEntities)) {
        const normalizedQuery = normalizeComparableText(userQuery);
        nextPlan.intent = SIMPLE_MEDIA_INTENT_REGEX.test(normalizedQuery)
            ? 'media_lookup'
            : (SIMPLE_FACT_INTENT_REGEX.test(normalizedQuery) ? 'fact_lookup' : 'identity_lookup');
        nextPlan.allow_graph_hops = false;
    }
    if (hasMediaSignal(userQuery)) {
        nextPlan.intent = 'media_lookup';
        nextPlan.allow_graph_hops = false;
    }
    if (GENERIC_RELATION_INTENT_REGEX.test(normalizeComparableText(userQuery)) && (nextPlan.entities || []).length >= 2) {
        nextPlan.intent = 'relationship_lookup';
        nextPlan.allow_graph_hops = false;
        nextPlan.need_exact_entity_match = true;
        nextPlan.relation_filter = 'ANY_RELATION';
    }

    let identityMap = buildIdentityResolutionMapFromMatches(identityMatches);
    const unresolvedEntities = (nextPlan.entities || []).filter(entity => !identityMap.has(normalizeComparableText(entity)));
    if (unresolvedEntities.length) {
        const resolvedIdentityMap = await resolveIdentityNames(clientId, unresolvedEntities).catch(() => new Map());
        for (const [key, value] of resolvedIdentityMap.entries()) {
            if (!identityMap.has(key)) identityMap.set(key, value);
        }
    }
    nextPlan.entities = [...new Set((nextPlan.entities || []).map(entity => {
        const normalized = normalizeComparableText(entity);
        return identityMap.get(normalized)?.canonicalName || entity;
    }).filter(Boolean))];
    nextPlan.identity_match_count = Number(identityMatches.length || nextPlan.identity_match_count || 0);

    return nextPlan;
}

async function collectGraphRecall(clientId, queryText, queryVector, plan, maxCandidates) {
    const graphCandidates = await traverseGraphV2(clientId, queryText, queryVector, maxCandidates).catch(() => []);
    return graphCandidates.filter(candidate => {
        if (!plan.allow_graph_hops && candidate.hop > 1) return false;
        if (plan.relation_filter && plan.relation_filter !== 'ANY_RELATION' && candidate.relation_type) {
            const relation = normalizeComparableText(candidate.relation_type);
            const expected = normalizeComparableText(plan.relation_filter);
            if (!relation.includes(expected) && !expected.includes(relation)) {
                return false;
            }
        }
        if (plan.intent === 'relationship_lookup' && (plan.entities || []).length >= 2) {
            const nodes = [candidate.metadata?.source_node, candidate.metadata?.target_node, candidate.metadata?.entity_name]
                .filter(Boolean)
                .map(value => normalizeComparableText(value));
            const required = (plan.entities || []).slice(0, 2).map(value => normalizeComparableText(value));
            if (!required.every(entity => nodes.some(node => node === entity))) return false;
        }
        return true;
    });
}

function hasDirectFactSupport(plan, factCandidates = []) {
    const directFacts = (factCandidates || []).filter(candidate => candidate.directness === 'direct');
    if (!directFacts.length) return false;

    if (plan.intent === 'identity_lookup') {
        return directFacts.some(candidate =>
            ['owner_identity', 'contact_identity', 'knowledge_node'].includes(candidate.metadata?.fact_type)
        );
    }

    if (plan.relation_filter) {
        const expected = normalizeComparableText(plan.relation_filter);
        if (expected === 'any_relation') {
            return directFacts.some(candidate => Boolean(candidate.relation_type || candidate.metadata?.relation_type));
        }
        return directFacts.some(candidate => {
            const relation = normalizeComparableText(candidate.relation_type || candidate.metadata?.relation_type || '');
            return relation && (relation.includes(expected) || expected.includes(relation));
        });
    }

    return directFacts.length >= 1;
}

function filterFactCandidatesForPlan(plan, factCandidates = []) {
    if (plan?.intent === 'media_lookup') {
        return (factCandidates || []).filter(candidate => !['owner_identity', 'contact_identity', 'knowledge_node'].includes(candidate.metadata?.fact_type));
    }
    if (!plan?.temporal_window) return factCandidates;
    return (factCandidates || []).filter(candidate => !['owner_identity', 'contact_identity'].includes(candidate.metadata?.fact_type));
}

function hasDirectTemporalSupport(plan, temporalCandidates = []) {
    if (!plan?.temporal_window) return false;
    return (temporalCandidates || []).some(candidate =>
        candidate.directness === 'direct' &&
        candidate.source_kind === 'memory_chunk'
    );
}

export async function collectEvidenceCandidates(clientId, queryText, queryVector, plan, trace = null) {
    const retrievalStart = Date.now();
    const ragMaxCandidates = Number(await getConfig('rag_max_candidates')) || 24;
    const queryExpansionEnabled = await getConfig('rag_query_expansion_enabled');
    const semanticRerankEnabled = await getConfig('rag_semantic_rerank_enabled');
    const semanticRerankMaxCandidates = Number(await getConfig('rag_semantic_rerank_max_candidates')) || 8;
    const maxQueryVariants = Number(await getConfig('rag_max_query_variants')) || 4;
    const rerankerEnabled = await getConfig('rag_reranker_enabled');
    const entities = plan.entities || [];
    const rawEntityMatchCount = Number(plan.identity_match_count || 0);
    const strictUnknownExactLookup = Boolean(
        plan.need_exact_entity_match &&
        ['identity_lookup', 'fact_lookup', 'media_lookup'].includes(plan.intent) &&
        entities.length &&
        rawEntityMatchCount === 0
    );
    const ghostOnlyExactLookup = Boolean(
        plan.need_exact_entity_match &&
        entities.length &&
        rawEntityMatchCount === 0 &&
        entities.every(entity => isGhostName(entity))
    );
    if (ghostOnlyExactLookup) {
        trace?.logRetrieval?.({
            hybridMemories: [],
            graphKnowledge: [],
            uniqueCandidates: [],
            top7: [],
            confidenceLevel: 'NONE',
            avgScore: 0,
            elapsedMs: Date.now() - retrievalStart
        });
        trace?.setCandidateSummary?.({
            total: 0,
            direct: 0,
            derived: 0,
            beforeRerank: [],
            afterRerank: []
        });
        return [];
    }
    const rawFactCandidates = plan.need_exact_entity_match && entities.length
        ? await exactEntityFactSearch(clientId, entities, Math.min(ragMaxCandidates, 12)).catch(() => [])
        : [];
    const relationshipCandidates = plan.intent === 'relationship_lookup' && entities.length >= 2
        ? await exactRelationshipSearch(clientId, entities, Math.min(ragMaxCandidates, 10)).catch(() => [])
        : [];
    const factCandidates = filterFactCandidatesForPlan(plan, rawFactCandidates);
    const exactLookupMode = Boolean(
        plan.need_exact_entity_match &&
        entities.length &&
        ['identity_lookup', 'fact_lookup'].includes(plan.intent)
    );
    const fastPathStructured = exactLookupMode && hasDirectFactSupport(plan, factCandidates);
    const temporalCandidates = plan.temporal_window
        ? await temporalMemorySearch(clientId, plan.temporal_window, entities, ragMaxCandidates).catch(() => [])
        : [];
    const mediaCandidates = plan.intent === 'media_lookup'
        ? await mediaMemorySearch(clientId, entities, queryText, Math.min(ragMaxCandidates, 12)).catch(() => [])
        : [];
    const fastPathTemporal = hasDirectTemporalSupport(plan, temporalCandidates);
    const fastPathRelationship = plan.intent === 'relationship_lookup' && relationshipCandidates.some(candidate => candidate.directness === 'direct');
    const fastPathMedia = plan.intent === 'media_lookup' && mediaCandidates.some(candidate => candidate.directness === 'direct');
    const strictRelationshipLookup = Boolean(plan.intent === 'relationship_lookup' && entities.length >= 2);
    if (strictUnknownExactLookup && !factCandidates.length && !mediaCandidates.length && !temporalCandidates.length) {
        trace?.logRetrieval?.({
            hybridMemories: [],
            graphKnowledge: [],
            uniqueCandidates: [],
            top7: [],
            confidenceLevel: 'NONE',
            avgScore: 0,
            elapsedMs: Date.now() - retrievalStart
        });
        trace?.setCandidateSummary?.({
            total: 0,
            direct: 0,
            derived: 0,
            beforeRerank: [],
            afterRerank: []
        });
        return [];
    }
    const queryVariants = (queryExpansionEnabled && !fastPathStructured && !fastPathTemporal && !fastPathRelationship && !fastPathMedia && !ghostOnlyExactLookup && !strictUnknownExactLookup && !strictRelationshipLookup)
        ? buildRetrievalQueries(queryText, plan, maxQueryVariants)
        : buildRetrievalQueries(queryText, plan, 2);
    const perVariantCount = Math.max(5, Math.ceil(ragMaxCandidates / Math.max(queryVariants.length, 1)) + 1);

    const exactCandidates = (!fastPathStructured && !fastPathTemporal && !fastPathRelationship && !fastPathMedia && !ghostOnlyExactLookup && !strictUnknownExactLookup && plan.need_exact_entity_match && entities.length)
        ? await exactEntityMemorySearch(clientId, entities, ragMaxCandidates).catch(() => [])
        : [];

    const semanticCandidates = (fastPathStructured || fastPathTemporal || fastPathRelationship || fastPathMedia || ghostOnlyExactLookup || strictUnknownExactLookup || strictRelationshipLookup)
        ? []
        : await collectHybridRecall(
            clientId,
            queryText,
            queryVector,
            queryVariants,
            perVariantCount
        ).catch(() => []);

    const graphCandidates = [];
    if (!fastPathStructured && !fastPathTemporal && !fastPathRelationship && !fastPathMedia && !ghostOnlyExactLookup && !strictUnknownExactLookup && !strictRelationshipLookup) {
        const graphQueryVariants = queryVariants.slice(0, Math.min(exactLookupMode ? 1 : 2, queryVariants.length));
        for (const variant of graphQueryVariants) {
            const rows = await collectGraphRecall(
                clientId,
                variant,
                queryVector,
                plan,
                Math.max(4, Math.ceil(ragMaxCandidates / Math.max(graphQueryVariants.length, 1)))
            ).catch(() => []);
            graphCandidates.push(...rows.map(row => ({
                ...row,
                retrieval_query: variant
            })));
        }
    }

    const merged = dedupeCandidates([
        ...factCandidates,
        ...relationshipCandidates,
        ...exactCandidates,
        ...temporalCandidates,
        ...mediaCandidates,
        ...semanticCandidates,
        ...graphCandidates
    ]);

    const rankedBase = rerankerEnabled
        ? await rerankEvidenceCandidates({
            queryText,
            queryVector,
            plan,
            candidates: merged,
            maxCandidates: ragMaxCandidates,
            semanticEnabled: Boolean(semanticRerankEnabled && !fastPathStructured && !fastPathTemporal && !fastPathRelationship && !fastPathMedia && !ghostOnlyExactLookup && !strictUnknownExactLookup && !strictRelationshipLookup),
            semanticMaxCandidates: semanticRerankMaxCandidates
        })
        : merged
            .slice()
            .sort((a, b) => Number(b.recall_score || 0) - Number(a.recall_score || 0))
            .slice(0, ragMaxCandidates)
            .map(candidate => ({
                ...candidate,
                score_rerank: 0,
                final_score: Number(candidate.recall_score || candidate.final_score || 0)
            }));

    const ranked = assignCitationLabels(rankedBase);

    trace?.logRetrieval?.({
        hybridMemories: semanticCandidates,
        graphKnowledge: graphCandidates,
        uniqueCandidates: merged,
        top7: ranked.slice(0, 7),
        confidenceLevel: ranked.filter(candidate => candidate.directness === 'direct').length >= 3 ? 'HIGH' : (ranked.length ? 'LOW' : 'NONE'),
        avgScore: ranked.length
            ? ranked.reduce((sum, candidate) => sum + (candidate.final_score || 0), 0) / ranked.length
            : 0,
        elapsedMs: Date.now() - retrievalStart
    });

    trace?.setCandidateSummary?.(
        plan.intent === 'media_lookup'
            ? {
                total: ranked.length,
                direct: ranked.filter(candidate => candidate.directness === 'direct').length,
                derived: ranked.filter(candidate => candidate.directness !== 'direct').length,
                beforeRerank: merged.slice(0, 6).map(candidate => ({
                    source_id: candidate.source_id,
                    source_kind: candidate.source_kind,
                    recall_score: candidate.recall_score
                })),
                afterRerank: ranked.slice(0, 6).map(candidate => ({
                    citation_label: candidate.citation_label,
                    source_id: candidate.source_id,
                    source_kind: candidate.source_kind,
                    final_score: candidate.final_score
                }))
            }
            : {
                total: ranked.length,
                direct: ranked.filter(candidate => candidate.directness === 'direct').length,
                derived: ranked.filter(candidate => candidate.directness !== 'direct').length,
                beforeRerank: merged.slice(0, 12).map(candidate => ({
                    source_id: candidate.source_id,
                    source_kind: candidate.source_kind,
                    directness: candidate.directness,
                    recall_score: candidate.recall_score,
                    evidence_text: String(candidate.evidence_text || '').slice(0, 140)
                })),
                afterRerank: ranked.slice(0, 12).map(candidate => ({
                    citation_label: candidate.citation_label,
                    source_id: candidate.source_id,
                    source_kind: candidate.source_kind,
                    directness: candidate.directness,
                    final_score: candidate.final_score,
                    evidence_text: String(candidate.evidence_text || '').slice(0, 140)
                }))
            }
    );

    return ranked;
}

function buildEvidenceBlock(candidates) {
    return (candidates || []).map(candidate => {
        const datePrefix = candidate.timestamp ? `[${candidate.timestamp}] ` : '';
        const relation = candidate.relation_type ? ` relation=${candidate.relation_type}` : '';
        const speaker = candidate.speaker ? ` speaker=${candidate.speaker}` : '';
        const source = `${candidate.citation_label} kind=${candidate.source_kind} directness=${candidate.directness}${relation}${speaker}`;
        return `${source}\n${datePrefix}${candidate.evidence_text}`;
    }).join('\n\n');
}

function normalizeSentence(text, maxLength = 220) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function normalizeReadableSnippetText(text = '') {
    return String(text || '')
        .replace(/\bde(ll[a-záéíóúñ]+)/gi, 'de $1')
        .replace(/\s+,/g, ',')
        .replace(/\s+\./g, '.')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanConversationLines(text) {
    return String(text || '')
        .split('\n')
        .map(line => line.replace(/\[[^\]]+\]/g, '').trim())
        .filter(Boolean)
        .filter(line => {
            const normalized = normalizeComparableText(line);
            if (!normalized) return false;
            if (normalized.includes('fragmento conversacional')) return false;
            if (normalized.startsWith('contacto:')) return false;
            if (normalized.startsWith('id:')) return false;
            if (normalized.startsWith('fecha:')) return false;
            return true;
        });
}

function isWeakConversationLine(line) {
    const normalized = normalizeComparableText(line);
    if (!normalized) return true;
    if (normalized.length < 8) return true;
    if (/^(ja|jaja|jajaja|ajaj|ajajaja|xd)+$/i.test(normalized.replace(/\s+/g, ''))) return true;
    return [
        'hola',
        'venga',
        'acho',
        'claro',
        'bueno',
        'vale',
        'si',
        'no',
        'ok',
        'okey',
        'juato',
        'justooo',
        'bieeeeeen',
        'perdon'
    ].includes(normalized);
}

function scoreConversationLine(line) {
    const normalized = normalizeComparableText(line);
    if (!normalized) return -10;

    let score = 0;
    const hasSpeakerPrefix = /^[^:\n]{2,32}:/.test(String(line || '').trim());
    if (hasSpeakerPrefix) score += 4;

    if (normalized.length >= 20) score += 2;
    if (normalized.length >= 45) score += 2;
    if (normalized.length >= 90) score += 1;

    if (/\b(te amo|te quiero|feliz|triste|llorar|ansiedad|madre|padres|trabaj|curro|comiendo|cenado|ceno|comer|pueblo|badajoz|caceres|caceres|verte|llame|dormir|estabilidad|amor|gracias)\b/i.test(normalized)) {
        score += 4;
    }

    if (/\b(hoy|ayer|jueves|viernes|lunes|martes|miercoles|miércoles|sabado|sábado|domingo)\b/i.test(normalized)) {
        score += 2;
    }

    if (isWeakConversationLine(line)) score -= 6;
    return score;
}

function scoreTemporalSnippetForPlan(plan, candidate) {
    if (!(plan?.temporal_window && candidate?.source_kind === 'memory_chunk')) return -1;

    const snippet = extractMemorySnippet(candidate.evidence_text, candidate.speaker, 220);
    const normalizedSnippet = normalizeComparableText(snippet);
    let score = scoreConversationLine(snippet);

    const requestedDay = normalizeComparableText(plan.temporal_window?.label || '');
    const weekdays = ['lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'viernes', 'sabado', 'sábado', 'domingo'];

    if (requestedDay && normalizedSnippet.includes(requestedDay)) {
        score += 3;
    }

    for (const weekday of weekdays) {
        if (!normalizedSnippet.includes(weekday)) continue;
        if (weekday !== requestedDay) score -= 5;
    }

    if (/\b(te amo|amor|feliz|triste|llorar|verte|abrazarte|gracias|estabilidad|ansiedad|padres|madre|trabaj|curro|comer|cena|dormir)\b/i.test(normalizedSnippet)) {
        score += 2;
    }

    return score;
}

function extractMemorySnippet(text, speaker = null, maxLength = 180) {
    const lines = cleanConversationLines(text);
    if (!lines.length) return '';

    const scored = lines
        .map((line, index) => ({
            line,
            index,
            score: scoreConversationLine(line)
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index);

    const lead = scored[0] || null;
    const chosenIndexes = new Set();
    if (lead) chosenIndexes.add(lead.index);

    if (lead) {
        const adjacentIndexes = [lead.index - 1, lead.index + 1]
            .filter(index => index >= 0 && index < lines.length);

        for (const index of adjacentIndexes) {
            const adjacentLine = lines[index];
            if (isWeakConversationLine(adjacentLine)) continue;
            if (scoreConversationLine(adjacentLine) < Math.max(1, lead.score - 4)) continue;
            chosenIndexes.add(index);
            if (chosenIndexes.size >= 2) break;
        }
    }

    const preferred = [...chosenIndexes]
        .sort((a, b) => a - b)
        .map(index => lines[index])
        .join(' ') || lines.slice(0, 2).join(' ');

    let snippet = normalizeSentence(preferred, maxLength);

    if (speaker) {
        const speakerName = String(speaker).trim();
        const firstToken = speakerName.split(/\s+/)[0];
        const speakerPattern = new RegExp(`^${escapeRegex(firstToken)}\\s*:`, 'i');
        if (speakerPattern.test(snippet) && !new RegExp(`^${escapeRegex(speakerName)}\\s*:`, 'i').test(snippet)) {
            snippet = snippet.replace(speakerPattern, `${speakerName}:`);
        }
    }

    return snippet;
}

function extractMediaSnippet(text, speaker = null, maxLength = 180) {
    const lines = cleanConversationLines(text);
    const mediaLine = lines.find(line => /\b(audio|nota de voz|voz|foto|imagen|video|documento|pdf|archivo)\b/i.test(line));
    if (mediaLine) {
        return extractMemorySnippet(mediaLine, speaker, maxLength);
    }
    return extractMemorySnippet(text, speaker, maxLength);
}

function inferMediaKind(candidate) {
    const source = normalizeComparableText([
        ...(candidate?.metadata?.mediaMatchedTerms || []),
        candidate?.metadata?.mediaType,
        candidate?.metadata?.attachmentType,
        candidate?.metadata?.attachmentMime,
        candidate?.metadata?.mediaSnippet,
        candidate?.evidence_text
    ].filter(Boolean).join(' '));

    if (/\b(foto|imagen|image)\b/.test(source)) return 'foto';
    if (/\b(video|clip)\b/.test(source)) return 'video';
    if (/\b(documento|pdf|archivo)\b/.test(source)) return 'documento';
    return 'audio';
}

function extractSpeakersFromDialog(snippet = '') {
    const matches = [...String(snippet || '').matchAll(/(?:^|\s)([^:\n]{2,40}):/g)];
    return [...new Set(matches
        .map(match => normalizeSentence(match[1], 40))
        .filter(Boolean)
        .filter(label => normalizeComparableText(label).split(' ').length <= 4))].slice(0, 2);
}

function buildMediaClaimText(candidate) {
    const mediaKind = inferMediaKind(candidate);
    const snippet = String(candidate?.metadata?.mediaSnippet || '').trim() || extractMediaSnippet(candidate?.evidence_text, candidate?.speaker, 180);
    const speakers = (candidate?.metadata?.mediaParticipants || []).length
        ? candidate.metadata.mediaParticipants.slice(0, 2)
        : extractSpeakersFromDialog(snippet);
    const datePrefix = candidate?.timestamp ? `El ${String(candidate.timestamp).slice(0, 10)}` : 'En tus recuerdos';

    if (speakers.length >= 2) {
        return `${datePrefix} aparece una conversación sobre un ${mediaKind} entre ${speakers[0]} y ${speakers[1]}.`;
    }
    if (speakers.length === 1) {
        return `${datePrefix} ${speakers[0]} menciona un ${mediaKind}.`;
    }
    if (candidate?.speaker) {
        return `${datePrefix} ${candidate.speaker} menciona un ${mediaKind}.`;
    }
    return `${datePrefix} aparece un recuerdo sobre un ${mediaKind}.`;
}

function extractMediaBody(candidate) {
    const mediaSnippet = normalizeReadableSnippetText(
        String(candidate?.metadata?.mediaSnippet || '').trim()
    ) || extractMediaSnippet(candidate?.evidence_text, candidate?.speaker, 220);
    if (!mediaSnippet) return '';

    const participants = (candidate?.metadata?.mediaParticipants || []).filter(Boolean);
    const speakerHints = [...new Set([
        ...participants,
        candidate?.speaker
    ].filter(Boolean))];

    let body = mediaSnippet;
    for (const speaker of speakerHints) {
        body = stripRepeatedSpeakerPrefixes(body, speaker);
    }

    return normalizeReadableSnippetText(body
        .replace(/\b(audio|nota de voz|voz|foto|imagen|video|documento|pdf|archivo)\b\s*(de|del)?\s*/gi, match => match.trim())
        .replace(/\s+/g, ' ')
        .trim());
}

function isWeakMediaClause(clause = '') {
    const normalized = normalizeComparableText(clause);
    if (!normalized) return true;
    if (normalized.length < 12) return true;
    if (/^(y|pero|pues|bueno|ah|ay)\b/.test(normalized) && normalized.length < 40) return true;
    return [
        'audio',
        'el audio',
        'nota de voz',
        'foto',
        'video',
        'archivo',
        'documento',
        'pdf',
        'mira el audio',
        'esto era al audio'
    ].includes(normalized);
}

function scoreMediaClause(clause = '') {
    const normalized = normalizeComparableText(clause);
    if (!normalized) return -10;

    let score = 0;
    if (normalized.length >= 20) score += 1;
    if (normalized.length >= 45) score += 2;
    if (/\b(audio|nota de voz|escuchaste|grabacion|grabación|voz)\b/.test(normalized)) score += 4;
    if (/\b(llor|amor|te amo|gracias|feliz|triste|ayudas|problemas|comuniquemos)\b/.test(normalized)) score += 2;
    if (/^(y|pero|pues|bueno|ah|ay)\b/.test(normalized)) score -= 3;
    if (isWeakMediaClause(clause)) score -= 6;
    return score;
}

function summarizeMediaCandidates(mediaCandidates = []) {
    const candidates = (mediaCandidates || []).filter(Boolean);
    if (!candidates.length) return null;

    const lead = candidates[0];
    const mediaKind = inferMediaKind(lead);
    const speakers = (lead?.metadata?.mediaParticipants || []).length
        ? lead.metadata.mediaParticipants.slice(0, 2)
        : extractSpeakersFromDialog(lead?.metadata?.mediaSnippet || lead?.evidence_text || '');
    const datePrefix = lead?.timestamp ? `El ${String(lead.timestamp).slice(0, 10)}` : 'En tus recuerdos';

    const clauses = [];
    for (const candidate of candidates.slice(0, 2)) {
        const body = extractMediaBody(candidate);
        const parts = String(body || '')
            .split(/\s*[.;]\s*/g)
            .map(part => normalizeSentence(part, 120))
            .filter(Boolean)
            .filter(part => !isWeakMediaClause(part));

        for (const part of parts) {
            const normalized = normalizeComparableText(part);
            if (!normalized) continue;
            if (clauses.some(item => normalizeComparableText(item) === normalized)) continue;
            clauses.push(part);
        }
    }

    const bestClauses = clauses
        .slice()
        .sort((a, b) => scoreMediaClause(b) - scoreMediaClause(a))
        .slice(0, 2);

    if (!bestClauses.length) return buildMediaClaimText(lead);

    if (speakers.length >= 2) {
        return `${datePrefix}, ${speakers[0]} y ${speakers[1]} hablan sobre un ${mediaKind}: ${bestClauses.join('; ')}.`;
    }
    if (speakers.length === 1) {
        return `${datePrefix}, ${speakers[0]} menciona un ${mediaKind}: ${bestClauses.join('; ')}.`;
    }
    if (lead?.speaker) {
        return `${datePrefix}, ${lead.speaker} menciona un ${mediaKind}: ${bestClauses.join('; ')}.`;
    }
    return `${datePrefix} aparece un ${mediaKind}: ${bestClauses.join('; ')}.`;
}

function humanizeRelationType(relationType) {
    const normalized = normalizeComparableText(String(relationType || '').replace(/[\[\]]/g, ' '));
    if (!normalized) return 'tiene relacion con';
    if (normalized.includes('amor')) return 'expresa afecto hacia';
    if (normalized.includes('felicidad')) return 'expresa felicidad con';
    if (normalized.includes('tranquilidad')) return 'expresa tranquilidad con';
    if (normalized.includes('estabilidad')) return 'expresa estabilidad con';
    if (normalized.includes('gusto')) return 'muestra gusto por';
    if (normalized.includes('dependencia')) return 'expresa dependencia hacia';
    if (normalized.includes('familia')) return 'tiene un vinculo familiar con';
    if (normalized.includes('amistad')) return 'muestra amistad con';
    if (normalized.includes('trabaja')) return 'trabaja con';
    if (normalized.includes('vive')) return 'vive con';
    if (normalized.includes('estudia')) return 'estudia con';
    return 'tiene relacion con';
}

function buildDeterministicClaims(plan, directCandidates) {
    const preferred = (directCandidates || [])
        .slice()
        .sort((a, b) => {
            const candidatePriority = candidate => {
                if (plan.temporal_window) {
                    if (candidate.source_kind === 'memory_chunk') return 0;
                    if (candidate.source_kind === 'graph_edge') return 1;
                    if (candidate.source_kind === 'graph_node') return 2;
                    if (candidate.source_kind === 'fact' && ['owner_identity', 'contact_identity'].includes(candidate.metadata?.fact_type)) return 8;
                    if (candidate.source_kind === 'fact') return 3;
                    return 9;
                }
                if (plan.relation_filter) {
                    if (candidate.source_kind === 'fact' && candidate.metadata?.fact_type === 'relationship_edge') return 0;
                    if (candidate.source_kind === 'graph_edge') return 0;
                    if (candidate.source_kind === 'fact' && candidate.metadata?.relation_type) return 1;
                    if (candidate.source_kind === 'memory_chunk') return 2;
                    if (candidate.source_kind === 'graph_node') return 3;
                }
                if (plan.intent === 'media_lookup') {
                    if (candidate.source_kind === 'memory_chunk') return 0;
                    if (candidate.source_kind === 'fact') return 1;
                    if (candidate.source_kind === 'graph_edge') return 2;
                    if (candidate.source_kind === 'graph_node') return 3;
                }
                if (candidate.source_kind === 'fact' && candidate.metadata?.owner_identity) return 0;
                if (candidate.source_kind === 'fact' && candidate.metadata?.fact_type === 'contact_identity') return 1;
                if (candidate.source_kind === 'fact') return 2;
                if (candidate.source_kind === 'graph_edge') return 3;
                if (candidate.source_kind === 'graph_node') return 4;
                if (candidate.source_kind === 'memory_chunk') return 5;
                return 9;
            };
            return candidatePriority(a) - candidatePriority(b)
                || scoreTemporalSnippetForPlan(plan, b) - scoreTemporalSnippetForPlan(plan, a)
                || Number(b.final_score || 0) - Number(a.final_score || 0);
        });

        if (plan.intent === 'media_lookup') {
            const mediaCandidates = preferred.filter(candidate => candidate.source_kind === 'memory_chunk').slice(0, 3);
            if (mediaCandidates.length) {
                const citationLabels = [...new Set(mediaCandidates.map(candidate => candidate.citation_label))].slice(0, 2);
                return [{
                    text: normalizeSentence(summarizeMediaCandidates(mediaCandidates), 220),
                    citations: citationLabels
                }];
        }
    }

    const claims = [];
    const seen = new Set();

    for (const candidate of preferred) {
        let text = null;

        if (candidate.source_kind === 'fact') {
            if (plan.intent === 'relationship_lookup' && candidate.metadata?.source_node && candidate.metadata?.target_node && candidate.metadata?.relation_type) {
                text = `${candidate.metadata.source_node} ${humanizeRelationType(candidate.metadata.relation_type)} ${candidate.metadata.target_node}.`;
            } else {
                text = normalizeSentence(candidate.evidence_text);
            }
        } else if (
            candidate.source_kind === 'graph_edge' &&
            candidate.metadata?.source_node &&
            candidate.metadata?.target_node &&
            candidate.metadata?.relation_type
        ) {
            text = `${candidate.metadata.source_node} ${humanizeRelationType(candidate.metadata.relation_type)} ${candidate.metadata.target_node}.`;
        } else if (candidate.source_kind === 'graph_node' && candidate.metadata?.context && candidate.metadata?.entity_name) {
            text = normalizeSentence(`${candidate.metadata.entity_name}: ${candidate.metadata.context}`);
        } else if (plan.temporal_window && candidate.source_kind === 'memory_chunk') {
            const prefix = candidate.timestamp ? `${String(candidate.timestamp).slice(0, 10)}: ` : '';
            text = normalizeSentence(`${prefix}${extractMemorySnippet(candidate.evidence_text, candidate.speaker)}`, 180);
        } else if (plan.intent === 'media_lookup' && candidate.source_kind === 'memory_chunk') {
            const prefix = candidate.timestamp ? `${String(candidate.timestamp).slice(0, 10)}: ` : '';
            text = normalizeSentence(`${prefix}${extractMemorySnippet(candidate.evidence_text, candidate.speaker)}`, 180);
        }

        if (!text || seen.has(text)) continue;
        seen.add(text);
        claims.push({ text, citations: [candidate.citation_label] });
        if (claims.length >= (plan.intent === 'relationship_lookup' ? 3 : 2)) break;
    }

    return claims;
}

function locallySupportedClaims(claims, evidenceByLabel) {
    return (claims || []).filter(claim => {
        if (!Array.isArray(claim.citations) || !claim.citations.length) return false;
        const normalizedClaim = normalizeComparableText(claim.text);

        return claim.citations.every(label => {
            const candidate = evidenceByLabel.get(label);
            if (!candidate) return false;

            if (candidate.source_kind === 'fact') {
                return normalizeComparableText(candidate.evidence_text).includes(normalizedClaim) ||
                    normalizedClaim.includes(normalizeComparableText(candidate.evidence_text));
            }

            if (candidate.source_kind === 'graph_edge') {
                const relationBits = [
                    candidate.metadata?.source_node,
                    candidate.metadata?.relation_type,
                    candidate.metadata?.target_node
                ].filter(Boolean).map(value => normalizeComparableText(value));
                return relationBits.every(bit => normalizedClaim.includes(bit));
            }

            if (candidate.source_kind === 'graph_node') {
                const context = normalizeComparableText(`${candidate.metadata?.entity_name || ''} ${candidate.metadata?.context || ''}`);
                return context && normalizedClaim && (context.includes(normalizedClaim) || normalizedClaim.includes(context));
            }

            if (candidate.source_kind === 'memory_chunk') {
                const strippedClaim = normalizedClaim.replace(/^\d{4}-\d{2}-\d{2}:\s*/, '').trim();
                const rawEvidence = normalizeComparableText(candidate.evidence_text);
                const snippetEvidence = normalizeComparableText(extractMemorySnippet(candidate.evidence_text, candidate.speaker, 260));
                return rawEvidence.includes(strippedClaim) || snippetEvidence.includes(strippedClaim);
            }

            return normalizeComparableText(candidate.evidence_text).includes(normalizedClaim);
        });
    });
}

export async function draftEvidenceAnswer(queryText, plan, candidates, trace = null) {
    const directCandidates = (candidates || []).filter(candidate => candidate.directness === 'direct').slice(0, 8);
    if (!directCandidates.length) {
        return {
            verdict: 'abstain',
            answer: 'No tengo evidencia suficiente en tus recuerdos para afirmarlo.',
            claims: []
        };
    }

    const systemPrompt = `Eres un redactor evidence-first.

Devuelve SOLO JSON con:
{
  "verdict": "answer|abstain|conflict",
  "answer": "respuesta breve",
  "claims": [
    { "text": "afirmacion corta", "citations": ["E1", "E2"] }
  ]
}

Reglas:
- Usa solo la evidencia disponible.
- Toda claim debe tener al menos una cita valida.
- Si la evidencia es insuficiente, verdict=abstain.
- Si hay evidencia incompatible para la misma pregunta, verdict=conflict.
 - No inventes nombres, fechas ni relaciones.`;

    const userPrompt = `Pregunta: ${queryText}
Plan: ${JSON.stringify(plan)}

EVIDENCIA DISPONIBLE:
${buildEvidenceBlock(directCandidates)}`;

    const deterministicClaims = buildDeterministicClaims(plan, directCandidates);
    const forceDeterministicIdentity = plan.intent === 'identity_lookup' &&
        directCandidates.some(candidate => candidate.source_kind === 'fact' &&
            (candidate.metadata?.owner_identity || candidate.metadata?.fact_type === 'contact_identity'));
    const forceDeterministicTemporal = Boolean(plan.temporal_window && deterministicClaims.length > 0);
    const forceDeterministicMedia = plan.intent === 'media_lookup' && deterministicClaims.length > 0;
    const forceDeterministicRelationship = plan.intent === 'relationship_lookup' && deterministicClaims.length > 0;

    if ((forceDeterministicIdentity || forceDeterministicTemporal || forceDeterministicMedia || forceDeterministicRelationship) && deterministicClaims.length) {
        return {
            verdict: 'answer',
            answer: '',
            claims: deterministicClaims
        };
    }

    try {
        const response = await groqJsonWithTimeout({ systemPrompt, userPrompt }, trace, { temperature: 0.1, timeoutMs: 10_000 });
        if (!response?.claims?.length && deterministicClaims.length) {
            return {
                verdict: 'answer',
                answer: '',
                claims: deterministicClaims
            };
        }
        if (response?.verdict === 'abstain' && deterministicClaims.length) {
            return {
                verdict: 'answer',
                answer: '',
                claims: deterministicClaims
            };
        }
        return response || {
            verdict: 'abstain',
            answer: 'No tengo evidencia suficiente en tus recuerdos para afirmarlo.',
            claims: []
        };
    } catch (error) {
        console.warn('[Evidence RAG] Draft fallback:', error.message);
        const deterministicClaims = buildDeterministicClaims(plan, directCandidates);
        if (deterministicClaims.length) {
            return {
                verdict: 'answer',
                answer: '',
                claims: deterministicClaims
            };
        }
        return {
            verdict: 'abstain',
            answer: 'No tengo evidencia suficiente en tus recuerdos para afirmarlo.',
            claims: []
        };
    }
}

export async function verifyDraftedClaims(queryText, draft, candidates, trace = null) {
    const evidenceByLabel = new Map((candidates || []).map(candidate => [candidate.citation_label, candidate]));
    const claims = (draft.claims || []).slice(0, 8).filter(claim => Array.isArray(claim.citations) && claim.citations.length > 0);

    if (!claims.length) {
        return {
            verdict: draft.verdict || 'abstain',
            supportedClaims: [],
            citationCoverage: 0
        };
    }

    const localSupported = locallySupportedClaims(claims, evidenceByLabel);
    const locallyVerifiableDirectClaims = claims.every(claim =>
        claim.citations.every(label => {
            const candidate = evidenceByLabel.get(label);
            return candidate &&
                candidate.directness === 'direct' &&
                ['fact', 'graph_edge', 'memory_chunk'].includes(candidate.source_kind);
        })
    );

    if (localSupported.length === claims.length && locallyVerifiableDirectClaims) {
        return {
            verdict: draft.verdict === 'conflict' ? 'conflict' : 'answer',
            supportedClaims: localSupported,
            citationCoverage: 1
        };
    }

    const systemPrompt = `Eres un verificador de claims.

Devuelve SOLO JSON:
{
  "verdict": "answer|abstain|conflict",
  "claims": [
    { "text": "claim", "citations": ["E1"], "supported": true, "reason": "string corto" }
  ]
}

Reglas:
- supported=true solo si la evidencia citada sostiene literalmente la claim.
- Si ninguna claim queda sostenida, verdict=abstain.
- Si hay claims sostenidas pero incompatibles entre si, verdict=conflict.`;

    const userPrompt = `Pregunta original: ${queryText}

Claims propuestas:
${claims.map((claim, index) => `${index + 1}. ${claim.text} | citas=${claim.citations.join(', ')}`).join('\n')}

EVIDENCIA:
${buildEvidenceBlock(
        [...new Set(claims.flatMap(claim => claim.citations))]
            .map(label => evidenceByLabel.get(label))
            .filter(Boolean)
    )}`;

    try {
        const verification = await groqJsonWithTimeout({ systemPrompt, userPrompt }, trace, { temperature: 0, timeoutMs: 8_000 });
        const supportedClaims = (verification?.claims || [])
            .filter(claim => claim.supported && Array.isArray(claim.citations) && claim.citations.every(label => evidenceByLabel.has(label)));

        const finalSupportedClaims = supportedClaims.length ? supportedClaims : localSupported;
        const finalVerdict = finalSupportedClaims.length
            ? (verification?.verdict === 'conflict' ? 'conflict' : 'answer')
            : 'abstain';

        return {
            verdict: finalVerdict,
            supportedClaims: finalSupportedClaims,
            citationCoverage: finalSupportedClaims.length / Math.max(claims.length, 1)
        };
    } catch (error) {
        console.warn('[Evidence RAG] Claim verification fallback:', error.message);
        const supportedClaims = locallySupportedClaims(claims, evidenceByLabel);
        return {
            verdict: supportedClaims.length ? (draft.verdict || 'answer') : 'abstain',
            supportedClaims,
            citationCoverage: supportedClaims.length / Math.max(claims.length, 1)
        };
    }
}

function composeFinalReply(verification) {
    const claims = verification.supportedClaims || [];
    if (!claims.length) {
        return 'No tengo evidencia suficiente en tus recuerdos para afirmarlo.';
    }

    if (verification.verdict === 'conflict') {
        return `Veo evidencia contradictoria sobre esto:\n${claims.map(claim => `- ${claim.text} ${claim.citations.map(label => `[${label}]`).join(' ')}`).join('\n')}`;
    }

    const temporalReply = composeTemporalReply(verification);
    if (temporalReply) return temporalReply;

    if (claims.length === 1) {
        return `${claims[0].text} ${claims[0].citations.map(label => `[${label}]`).join(' ')}`.trim();
    }

    return `Segun tus recuerdos:\n${claims.map(claim => `- ${claim.text} ${claim.citations.map(label => `[${label}]`).join(' ')}`).join('\n')}`;
}

function parseTemporalClaim(claimText = '') {
    const raw = String(claimText || '').trim();
    const match = raw.match(/^(\d{4}-\d{2}-\d{2}):\s*([^:]+):\s*(.+)$/);
    if (!match) return null;

    const [, date, speaker, body] = match;
    return {
        date: String(date).trim(),
        speaker: normalizeSentence(speaker, 40),
        body: normalizeSentence(body, 220)
    };
}

function shortenTemporalBody(body = '') {
    const text = normalizeReadableSnippetText(body);
    if (!text) return '';

    const clauses = text
        .split(/\s*[.;]\s*/g)
        .map(part => normalizeSentence(part, 140))
        .filter(Boolean)
        .filter(part => !isWeakConversationLine(part));

    const picked = [];
    for (const clause of clauses) {
        const normalized = normalizeComparableText(clause);
        if (!normalized) continue;
        if (picked.some(item => normalizeComparableText(item) === normalized)) continue;
        picked.push(clause);
        if (picked.length >= 2) break;
    }

    return normalizeReadableSnippetText(picked.join('; ') || normalizeSentence(text, 160));
}

function stripRepeatedSpeakerPrefixes(body = '', speaker = '') {
    let next = String(body || '').trim();
    const speakerName = String(speaker || '').trim();
    if (!next || !speakerName) return next;

    const variants = [...new Set([
        speakerName,
        speakerName.split(/\s+/)[0]
    ].filter(Boolean))];

    for (const variant of variants) {
        const pattern = new RegExp(`(?:^|\\s+|;\\s*)${escapeRegex(variant)}\\s*:`, 'gi');
        next = next.replace(pattern, '; ');
    }

    return next
        .replace(/\s*;\s*/g, '; ')
        .replace(/^;\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function detectTemporalThemes(bodies = []) {
    const haystack = normalizeComparableText((bodies || []).join(' '));
    if (!haystack) return [];

    const themes = [];
    const pushTheme = (id, text) => {
        if (themes.some(theme => theme.id === id)) return;
        themes.push({ id, text });
    };

    if (/\b(discutiendo|discuten|discuten|discutir|problemas|agobio|agobias|mierda)\b/.test(haystack)) {
        pushTheme('discussion', 'habla de discusiones o problemas');
    }
    if (/\b(te amo|amarme|amemos|amor|te quiero|quererte)\b/.test(haystack)) {
        pushTheme('affection', 'expresa afecto');
    }
    if (/\b(estabilidad|tranquilidad|bien contigo|feliz|felicidad)\b/.test(haystack)) {
        pushTheme('stability', 'transmite estabilidad o bienestar');
    }
    if (/\b(comuniquemos|comunicarnos|hablando|comunicativo)\b/.test(haystack)) {
        pushTheme('communication', 'destaca la importancia de comunicarse');
    }
    if (/\b(llorar|ansiedad|triste|espalda fatal)\b/.test(haystack)) {
        pushTheme('distress', 'menciona malestar emocional o cansancio');
    }

    return themes;
}

function joinNaturalLanguage(parts = []) {
    const values = (parts || []).filter(Boolean);
    if (!values.length) return '';
    if (values.length === 1) return values[0];
    if (values.length === 2) return `${values[0]} y ${values[1]}`;
    return `${values.slice(0, -1).join(', ')} y ${values[values.length - 1]}`;
}

function composeTemporalReply(verification) {
    const claims = verification.supportedClaims || [];
    if (!claims.length) return null;

    const parsed = claims
        .map(claim => ({
            claim,
            parsed: parseTemporalClaim(claim.text)
        }))
        .filter(item => item.parsed);

    if (!parsed.length) return null;

    const sameDate = parsed.every(item => item.parsed.date === parsed[0].parsed.date);
    const sameSpeaker = parsed.every(item => normalizeComparableText(item.parsed.speaker) === normalizeComparableText(parsed[0].parsed.speaker));
    const allCitations = [...new Set(parsed.flatMap(item => item.claim.citations || []).filter(Boolean))].slice(0, 3);
    const citationText = allCitations.map(label => `[${label}]`).join(' ');

    const bodies = parsed
        .map(item => stripRepeatedSpeakerPrefixes(
            shortenTemporalBody(item.parsed.body),
            item.parsed.speaker
        ))
        .filter(Boolean);

    if (!bodies.length) return null;

    const uniqueBodies = [];
    for (const body of bodies) {
        const normalized = normalizeComparableText(body);
        if (uniqueBodies.some(item => normalizeComparableText(item) === normalized)) continue;
        uniqueBodies.push(body);
        if (uniqueBodies.length >= 2) break;
    }

    const themes = detectTemporalThemes(uniqueBodies);
    if (sameDate && sameSpeaker && themes.length >= 2) {
        return `El ${parsed[0].parsed.date}, ${parsed[0].parsed.speaker} ${joinNaturalLanguage(themes.slice(0, 3).map(theme => theme.text))}. ${citationText}`.trim();
    }

    if (sameDate && sameSpeaker) {
        return `El ${parsed[0].parsed.date}, ${parsed[0].parsed.speaker} dice: ${uniqueBodies.join('; ')}. ${citationText}`.trim();
    }

    if (sameDate) {
        return `El ${parsed[0].parsed.date} aparece esto en la conversación: ${uniqueBodies.join('; ')}. ${citationText}`.trim();
    }

    return null;
}

function compactSupportedClaims(plan, claims = []) {
    const maxClaims = plan?.intent === 'relationship_lookup'
        ? 2
        : (plan?.intent === 'temporal_lookup' ? 2 : 1);
    const maxCitations = plan?.intent === 'media_lookup' ? 2 : 3;
    return (claims || [])
        .slice(0, maxClaims)
        .map(claim => ({
            ...claim,
            citations: [...new Set((claim.citations || []).filter(Boolean))].slice(0, maxCitations)
        }));
}

export async function runEvidenceFirstRag({ clientId, queryText, queryVector, trace = null, precomputedPlan = null }) {
    const plan = precomputedPlan || await buildRagQueryPlan(clientId, queryText, trace);
    const claimVerifierEnabled = await getConfig('rag_claim_verifier_enabled');
    trace?.setMode?.('evidence_first');
    trace?.setQueryPlan?.(plan);
    const candidates = await collectEvidenceCandidates(clientId, queryText, queryVector, plan, trace);
    const draft = await draftEvidenceAnswer(queryText, plan, candidates, trace);
    const bypassClaimVerifier = ['temporal_lookup', 'media_lookup', 'relationship_lookup'].includes(plan.intent);
    const verification = (claimVerifierEnabled && !bypassClaimVerifier)
        ? await verifyDraftedClaims(queryText, draft, candidates, trace)
        : {
            verdict: draft.verdict || 'abstain',
            supportedClaims: (draft.claims || []).filter(claim => Array.isArray(claim.citations) && claim.citations.length > 0),
            citationCoverage: (draft.claims || []).length ? 1 : 0
        };
    const compactClaims = compactSupportedClaims(plan, verification.supportedClaims || []);
    const finalVerification = {
        ...verification,
        supportedClaims: compactClaims
    };
    const reply = composeFinalReply(finalVerification);

    trace?.setAnswerVerdict?.({
        verdict: verification.verdict || draft.verdict || 'abstain',
        citationCoverage: verification.citationCoverage || 0,
        supportedClaims: compactClaims
    });

    return {
        reply,
        plan,
        candidates,
        draft,
        verification: finalVerification,
        verdict: verification.verdict || draft.verdict || 'abstain',
        cacheEligible: !plan.need_exact_entity_match && !plan.temporal_window && !plan.relation_filter && !plan.entities?.length && plan.intent === 'exploratory',
        citationCoverage: verification.citationCoverage || 0
    };
}
