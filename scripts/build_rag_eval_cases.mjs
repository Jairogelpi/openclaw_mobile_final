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

function buildIdentityCases(identityRows, memoriesByRemoteId) {
    const cases = [];

    for (const row of identityRows) {
        const remoteId = row.remote_id;
        const name = row.canonical_name;
        const memories = memoriesByRemoteId.get(remoteId) || [];
        if (!name || !memories.length) continue;

        cases.push({
            category: 'identity_simple',
            query: `quien es ${name}`,
            expected_mode: 'answer',
            expected_entities: [name],
            expected_remote_ids: [remoteId],
            expected_substrings: [name],
            notes: { source: 'contact_identities', aliases: row.aliases || [] }
        });

        cases.push({
            category: 'identity_casefold',
            query: `que recuerdas de ${name.toUpperCase()}`,
            expected_mode: 'answer',
            expected_entities: [name],
            expected_remote_ids: [remoteId],
            expected_substrings: [name],
            notes: { source: 'contact_identities', aliases: row.aliases || [] }
        });

        cases.push({
            category: 'identity_lower',
            query: `que sabes de ${name.toLowerCase()}`,
            expected_mode: 'answer',
            expected_entities: [name],
            expected_remote_ids: [remoteId],
            expected_substrings: [name],
            notes: { source: 'contact_identities', aliases: row.aliases || [] }
        });

        const datedMemory = memories.find(memory => memory.created_at);
        if (datedMemory) {
            const window = toDayWindow(datedMemory.metadata?.date || datedMemory.created_at);
            if (window) {
                cases.push({
                    category: 'temporal_person',
                    query: `que paso con ${name} el ${weekdayEs(window.start)}`,
                    expected_mode: 'answer',
                    expected_entities: [name],
                    expected_remote_ids: [remoteId],
                    expected_substrings: [name],
                    expected_time_start: window.start,
                    expected_time_end: window.end,
                    notes: {
                        source: 'user_memories',
                        memory_id: datedMemory.id
                    }
                });
            }
        }

        const mediaMemory = memories.find(memory => /\[(media|image|audio|video)/i.test(memory.content || ''));
        if (mediaMemory) {
            cases.push({
                category: 'media_recall',
                query: `recuerdas la imagen o audio de ${name}`,
                expected_mode: 'answer',
                expected_entities: [name],
                expected_remote_ids: [remoteId],
                expected_substrings: [name],
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
            query: `que relacion hay entre ${edge.source_node} y ${edge.target_node}`,
            expected_mode: 'answer',
            expected_entities: [edge.source_node, edge.target_node],
            expected_remote_ids: [],
            expected_substrings: [edge.source_node, edge.target_node, edge.relation_type],
            notes: {
                relation_type: edge.relation_type,
                context: edge.context || null
            }
        }));
}

function buildAbstainCases(count = 24) {
    const cases = [];
    for (let i = 1; i <= count; i++) {
        const fakeName = buildAbstainName(i);
        cases.push({
            category: 'abstain_unknown',
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

    const [identityRows, memories, relationEdges] = await Promise.all([
        getIdentityRows(clientId),
        fetchRecentMemories(clientId),
        fetchRelationEdges(clientId)
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
