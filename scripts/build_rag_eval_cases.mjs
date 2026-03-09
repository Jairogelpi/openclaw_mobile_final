import 'dotenv/config';
import supabase from '../config/supabase.mjs';
import { hydrateContactIdentities, getIdentityRows } from '../services/identity.service.mjs';
import { normalizeComparableText } from '../utils/message_guard.mjs';

function getArg(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(arg => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function toDayWindow(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
}

function weekdayEs(value) {
    return ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'][new Date(value).getDay()];
}

function uniqueCases(cases) {
    const seen = new Set();
    return cases.filter(item => {
        const key = `${item.category}:${normalizeComparableText(item.query)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildAbstainName(seed) {
    return `PersonaFantasma${seed}`;
}

async function fetchRelationEdges(clientId, limit = 50) {
    const { data, error } = await supabase
        .from('knowledge_edges')
        .select('source_node, target_node, relation_type, context, last_seen, weight')
        .eq('client_id', clientId)
        .order('weight', { ascending: false })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

async function fetchRecentMemories(clientId, limit = 2500) {
    const { data, error } = await supabase
        .from('user_memories')
        .select('id, sender, content, metadata, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

async function fetchRelationMentions(clientId, limit = 80) {
    const { data, error } = await supabase
        .from('relation_mentions')
        .select('source_node, target_node, relation_type, context, last_seen, support_count, stable_score, stability_tier')
        .eq('client_id', clientId)
        .in('stability_tier', ['provisional', 'stable'])
        .order('stable_score', { ascending: false })
        .order('support_count', { ascending: false })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

function memoryRemoteId(memory) {
    return memory.metadata?.remoteId || memory.metadata?.remote_id || null;
}

function detectMediaKind(memory) {
    const haystack = normalizeComparableText([
        memory.content,
        memory.metadata?.mediaType,
        memory.metadata?.attachmentType,
        memory.metadata?.attachmentMime,
        memory.metadata?.caption
    ].filter(Boolean).join(' '));
    if (!haystack) return null;
    if (/\b(audio|nota de voz|voice)\b/.test(haystack)) return 'audio';
    if (/\b(foto|imagen|image)\b/.test(haystack)) return 'foto';
    if (/\b(video|clip)\b/.test(haystack)) return 'video';
    if (/\b(documento|archivo|pdf)\b/.test(haystack)) return 'documento';
    return null;
}

function buildIdentityCases(identityRows, memoriesByRemoteId) {
    const cases = [];

    for (const row of identityRows) {
        const remoteId = row.remote_id;
        const name = row.canonical_name;
        const memories = memoriesByRemoteId.get(remoteId) || [];
        if (!name || !memories.length) continue;

        cases.push({
            category: 'identity_simple',
            style_tag: 'direct_chat',
            query: `quien es ${name}`,
            expected_mode: 'answer',
            expected_entities: [name],
            expected_remote_ids: [remoteId],
            expected_substrings: [name],
            expected_evidence_kinds: ['fact'],
            notes: { source: 'contact_identities', aliases: row.aliases || [] }
        });

        cases.push({
            category: 'identity_casefold',
            style_tag: 'direct_chat',
            query: `que recuerdas de ${name.toUpperCase()}`,
            expected_mode: 'answer',
            expected_entities: [name],
            expected_remote_ids: [remoteId],
            expected_substrings: [name],
            expected_evidence_kinds: ['fact', 'memory_chunk'],
            notes: { source: 'contact_identities', aliases: row.aliases || [] }
        });

        cases.push({
            category: 'identity_lower',
            style_tag: 'direct_chat',
            query: `que sabes de ${name.toLowerCase()}`,
            expected_mode: 'answer',
            expected_entities: [name],
            expected_remote_ids: [remoteId],
            expected_substrings: [name],
            expected_evidence_kinds: ['fact', 'memory_chunk'],
            notes: { source: 'contact_identities', aliases: row.aliases || [] }
        });

        const extraAlias = (row.aliases || []).find(alias =>
            normalizeComparableText(alias) !== normalizeComparableText(name) &&
            String(alias || '').trim().length >= 3
        );
        if (extraAlias) {
            cases.push({
                category: 'identity_alias',
                style_tag: 'alias_heavy',
                query: `que sabes de ${extraAlias}`,
                expected_mode: 'answer',
                expected_entities: [name],
                expected_remote_ids: [remoteId],
                expected_substrings: [name],
                expected_evidence_kinds: ['fact', 'memory_chunk'],
                notes: { source: 'contact_identities', alias: extraAlias }
            });
        }

        const datedMemory = memories.find(memory => memory.created_at);
        if (datedMemory) {
            const window = toDayWindow(datedMemory.metadata?.date || datedMemory.created_at);
            if (window) {
                cases.push({
                    category: 'temporal_person',
                    style_tag: String(remoteId || '').endsWith('@g.us') ? 'group_chat' : 'temporal_dense',
                    query: `que paso con ${name} el ${weekdayEs(window.start)}`,
                    expected_mode: 'answer',
                    expected_entities: [name],
                    expected_remote_ids: [remoteId],
                    expected_substrings: [name],
                    expected_time_start: window.start,
                    expected_time_end: window.end,
                    expected_evidence_kinds: ['memory_chunk'],
                    expected_memory_ids: [datedMemory.id],
                    notes: {
                        source: 'user_memories',
                        memory_id: datedMemory.id
                    }
                });
            }
        }

        const mediaMemory = memories.find(memory => /\[(media|image|audio|video)/i.test(memory.content || ''));
        if (mediaMemory) {
            const mediaKind = detectMediaKind(mediaMemory) || 'media';
            cases.push({
                category: 'media_recall',
                style_tag: 'media_dense',
                query: `recuerdas el ${mediaKind} de ${name}`,
                expected_mode: 'answer',
                expected_entities: [name],
                expected_remote_ids: [remoteId],
                expected_substrings: [name],
                expected_evidence_kinds: ['memory_chunk'],
                expected_memory_ids: [mediaMemory.id],
                expected_media_kind: mediaKind,
                notes: {
                    source: 'user_memories',
                    memory_id: mediaMemory.id
                }
            });
        }
    }

    return cases;
}

function buildRelationCases(edges) {
    return edges
        .filter(edge => edge.source_node && edge.target_node && edge.relation_type)
        .map(edge => ({
            category: 'relationship_lookup',
            style_tag: 'relationship_graph',
            query: `que relacion hay entre ${edge.source_node} y ${edge.target_node}`,
            expected_mode: 'answer',
            expected_entities: [edge.source_node, edge.target_node],
            expected_remote_ids: [],
            expected_substrings: [edge.source_node, edge.target_node, edge.relation_type],
            expected_edge_keys: [`${edge.source_node}|${edge.relation_type}|${edge.target_node}`],
            expected_evidence_kinds: ['fact', 'graph_edge'],
            notes: {
                relation_type: edge.relation_type,
                context: edge.context || null
            }
        }));
}

function buildRelationMentionCases(mentions) {
    return mentions
        .filter(item => item.source_node && item.target_node && item.relation_type)
        .map(item => ({
            category: 'relationship_lookup',
            style_tag: item.support_count >= 2 ? 'relationship_graph' : 'relationship_memory',
            query: `que relacion hay entre ${item.source_node} y ${item.target_node}`,
            expected_mode: 'answer',
            expected_entities: [item.source_node, item.target_node],
            expected_remote_ids: [],
            expected_substrings: [item.source_node, item.target_node],
            expected_edge_keys: [`${item.source_node}|${item.relation_type}|${item.target_node}`],
            expected_evidence_kinds: ['fact'],
            notes: {
                relation_type: item.relation_type,
                context: item.context || null,
                support_count: item.support_count || 0,
                from_mentions: true
            }
        }));
}

function buildAbstainCases(count = 24) {
    const cases = [];
    for (let i = 1; i <= count; i++) {
        const fakeName = buildAbstainName(i);
        cases.push({
            category: 'abstain_unknown',
            style_tag: 'adversarial',
            query: `quien es ${fakeName}`,
            expected_mode: 'abstain',
            expected_entities: [fakeName],
            expected_remote_ids: [],
            expected_substrings: [],
            notes: { synthetic: true }
        });
    }
    return cases;
}

function buildGroupCases(memories = []) {
    const grouped = new Map();
    for (const memory of memories) {
        const remoteId = memoryRemoteId(memory);
        if (!String(remoteId || '').endsWith('@g.us')) continue;
        if (!grouped.has(remoteId)) grouped.set(remoteId, []);
        grouped.get(remoteId).push(memory);
    }

    const cases = [];
    for (const [remoteId, groupMemories] of grouped.entries()) {
        const sample = groupMemories.find(memory => memory.created_at);
        const groupName = sample?.metadata?.conversationName || sample?.sender;
        if (!sample || !groupName) continue;
        const window = toDayWindow(sample.metadata?.date || sample.created_at);
        if (!window) continue;
        cases.push({
            category: 'group_temporal',
            style_tag: 'group_chat',
            query: `que paso en ${groupName} el ${weekdayEs(window.start)}`,
            expected_mode: 'answer',
            expected_entities: [groupName],
            expected_remote_ids: [remoteId],
            expected_substrings: [groupName],
            expected_time_start: window.start,
            expected_time_end: window.end,
            expected_evidence_kinds: ['memory_chunk'],
            expected_memory_ids: [sample.id],
            notes: { source: 'user_memories', memory_id: sample.id }
        });
        if (cases.length >= 18) break;
    }
    return cases;
}

async function main() {
    const clientId = getArg('client') || process.env.CLIENT_ID;
    const targetCount = Number(getArg('count', '160'));
    const shouldReset = process.argv.includes('--reset');
    const shouldRehydrate = process.argv.includes('--rehydrate');

    if (!clientId) {
        throw new Error('Missing client id. Use --client=<uuid> or CLIENT_ID env.');
    }

    const { count: identityCount, error: identityCountError } = await supabase
        .from('contact_identities')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', clientId);

    if (identityCountError) throw identityCountError;

    if (shouldRehydrate || !identityCount) {
        console.log(`[RAG Eval Seed] Hydrating identities for ${clientId}...`);
        await hydrateContactIdentities(clientId, { force: true });
    } else {
        console.log(`[RAG Eval Seed] Reusing ${identityCount} existing identities for ${clientId}.`);
    }

    const [identityRows, memories, relationEdges, relationMentions] = await Promise.all([
        getIdentityRows(clientId),
        fetchRecentMemories(clientId),
        fetchRelationEdges(clientId),
        fetchRelationMentions(clientId)
    ]);

    const memoriesByRemoteId = new Map();
    for (const memory of memories) {
        const remoteId = memory.metadata?.remoteId;
        if (!remoteId) continue;
        if (!memoriesByRemoteId.has(remoteId)) memoriesByRemoteId.set(remoteId, []);
        memoriesByRemoteId.get(remoteId).push(memory);
    }

    const seededCases = uniqueCases([
        ...buildIdentityCases(identityRows.slice(0, 45), memoriesByRemoteId),
        ...buildRelationCases(relationEdges.slice(0, 50)),
        ...buildRelationMentionCases(relationMentions.slice(0, 80)),
        ...buildGroupCases(memories),
        ...buildAbstainCases(30)
    ]).slice(0, targetCount);

    if (shouldReset) {
        const { error: deleteError } = await supabase
            .from('rag_eval_cases')
            .delete()
            .eq('client_id', clientId);
        if (deleteError) throw deleteError;
    }

    if (!seededCases.length) {
        throw new Error('No eval cases could be generated from current data.');
    }

    const payload = seededCases.map(item => ({
        client_id: clientId,
        category: item.category,
        query: item.query,
        expected_mode: item.expected_mode,
        expected_entities: item.expected_entities,
        expected_remote_ids: item.expected_remote_ids,
        expected_substrings: item.expected_substrings,
        expected_time_start: item.expected_time_start || null,
        expected_time_end: item.expected_time_end || null,
        style_tag: item.style_tag || 'general',
        expected_citation_min: item.expected_citation_min || 1,
        expected_evidence_kinds: item.expected_evidence_kinds || [],
        expected_verdict_detail: item.expected_verdict_detail || null,
        expected_memory_ids: item.expected_memory_ids || [],
        expected_edge_keys: item.expected_edge_keys || [],
        expected_media_kind: item.expected_media_kind || null,
        expected_speaker: item.expected_speaker || null,
        notes: item.notes || {}
    }));

    const { error: insertError } = await supabase
        .from('rag_eval_cases')
        .insert(payload);

    if (insertError) throw insertError;

    const breakdown = payload.reduce((acc, item) => {
        acc[item.category] = (acc[item.category] || 0) + 1;
        return acc;
    }, {});

    console.log(`[RAG Eval Seed] Inserted ${payload.length} cases for ${clientId}.`);
    console.log(JSON.stringify({ total: payload.length, breakdown }, null, 2));
}

main().catch(error => {
    console.error('[RAG Eval Seed] Failed:', error.message);
    process.exitCode = 1;
});
