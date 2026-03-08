import supabase from '../config/supabase.mjs';
import { normalizeComparableText } from '../utils/message_guard.mjs';

const clientId = process.argv[2];

if (!clientId) {
    console.error('Usage: node scripts/audit_graph_quality.mjs <client_id>');
    process.exit(1);
}

const BLOCKED_NODE_NAMES = new Set([
    'usuario',
    'contacto',
    'assistant',
    'asistente',
    'system',
    'persona',
    'interlocutor',
    'anonimo',
    'anónimo',
    'el',
    'la',
    'los',
    'las',
    'lo',
    'un',
    'una',
    'alguien',
    'nadie',
    'otro',
    'otra',
    'él',
    'ella',
    'ellos',
    'ellas',
    'este',
    'esta',
    'esto',
    'ese',
    'esa',
    'eso',
    'el jefe',
    'la jefa',
    'doctor',
    'doctora',
    'medico',
    'médico',
    'psiquiatra',
    'terapeuta',
    'mr'
]);

const ROLE_LIKE_NODE_PATTERNS = [
    /^mi\s+(madre|padre|hermano|hermana|primo|prima|jefe|jefa|medico|médico)$/i,
    /^su\s+(madre|padre|hermano|hermana|primo|prima)$/i,
    /^(el|la)\s+[a-záéíóúñ]{3,}$/i
];

const SUSPICIOUS_CONTEXT_PATTERNS = [
    /\busuario\b/i,
    /\bcontacto\b/i,
    /\bassistant\b/i,
    /\banonim/i,
    /\binterlocutor\b/i
];

function normalize(value) {
    return normalizeComparableText(String(value || ''));
}

function isBlockedNodeName(value) {
    const normalized = normalize(value);
    if (!normalized) return true;
    if (BLOCKED_NODE_NAMES.has(normalized)) return true;
    if (/^\d{6,}$/.test(normalized)) return true;
    if (normalized.includes('@')) return true;
    if (ROLE_LIKE_NODE_PATTERNS.some(pattern => pattern.test(String(value || '').trim()))) return true;
    return false;
}

function isSuspiciousEdge(edge) {
    if (!edge) return false;
    if (isBlockedNodeName(edge.source_node) || isBlockedNodeName(edge.target_node)) return true;
    const context = String(edge.context || '');
    if (SUSPICIOUS_CONTEXT_PATTERNS.some(pattern => pattern.test(context))) return true;
    if (!String(edge.relation_type || '').trim()) return true;
    return false;
}

async function fetchRows(table, select) {
    const { data, error } = await supabase
        .from(table)
        .select(select)
        .eq('client_id', clientId);

    if (error) throw error;
    return data || [];
}

async function fetchNodeCommunityCount() {
    const { data: communities, error } = await supabase
        .from('knowledge_communities')
        .select('id')
        .eq('client_id', clientId);

    if (error) throw error;
    const ids = (communities || []).map(row => row.id).filter(Boolean);
    if (!ids.length) return 0;

    const { count, error: countError } = await supabase
        .from('node_communities')
        .select('*', { head: true, count: 'exact' })
        .in('community_id', ids);

    if (countError) throw countError;
    return Number(count || 0);
}

async function main() {
    const [
        rawMessages,
        userMemories,
        knowledgeNodes,
        knowledgeEdges,
        contactIdentities,
        knowledgeCommunities
    ] = await Promise.all([
        fetchRows('raw_messages', 'id, sender_role, remote_id, metadata, processed'),
        fetchRows('user_memories', 'id, sender, metadata'),
        fetchRows('knowledge_nodes', 'id, entity_name, entity_type, description'),
        fetchRows('knowledge_edges', 'id, source_node, target_node, relation_type, context, weight'),
        fetchRows('contact_identities', 'id, remote_id, canonical_name, aliases, source_details'),
        fetchRows('knowledge_communities', 'id, summary, size, density')
    ]);

    const nodeCommunityCount = await fetchNodeCommunityCount();

    const pendingRaw = rawMessages.filter(row => row.processed === false).length;
    const genericSenderRoles = rawMessages.reduce((acc, row) => {
        const role = String(row.sender_role || '').trim();
        if (!role) return acc;
        if (['Usuario', 'Contacto', 'assistant', 'usuario', 'contacto'].includes(role)) {
            acc[role] = (acc[role] || 0) + 1;
        }
        return acc;
    }, {});

    const suspiciousNodes = knowledgeNodes.filter(node => isBlockedNodeName(node.entity_name));
    const suspiciousEdges = knowledgeEdges.filter(edge => isSuspiciousEdge(edge));
    const suspiciousIdentities = contactIdentities.filter(row => {
        const aliases = Array.isArray(row.aliases) ? row.aliases : [];
        if (String(row.remote_id || '').endsWith('@g.us')) {
            return aliases.some(alias => {
                const normalized = normalize(alias);
                return normalized && normalized !== normalize(row.canonical_name) && !/grupo|chat/i.test(alias);
            });
        }
        return aliases.some(alias => isBlockedNodeName(alias));
    });

    const report = {
        client_id: clientId,
        totals: {
            raw_messages: rawMessages.length,
            pending_raw_messages: pendingRaw,
            user_memories: userMemories.length,
            knowledge_nodes: knowledgeNodes.length,
            knowledge_edges: knowledgeEdges.length,
            contact_identities: contactIdentities.length,
            knowledge_communities: knowledgeCommunities.length,
            node_communities: nodeCommunityCount
        },
        generic_sender_roles: genericSenderRoles,
        quality: {
            suspicious_nodes: suspiciousNodes.length,
            suspicious_edges: suspiciousEdges.length,
            suspicious_identities: suspiciousIdentities.length,
            suspicious_node_rate: knowledgeNodes.length ? Number((suspiciousNodes.length / knowledgeNodes.length).toFixed(4)) : 0,
            suspicious_edge_rate: knowledgeEdges.length ? Number((suspiciousEdges.length / knowledgeEdges.length).toFixed(4)) : 0,
            suspicious_identity_rate: contactIdentities.length ? Number((suspiciousIdentities.length / contactIdentities.length).toFixed(4)) : 0
        },
        samples: {
            suspicious_nodes: suspiciousNodes.slice(0, 20),
            suspicious_edges: suspiciousEdges.slice(0, 20),
            suspicious_identities: suspiciousIdentities.slice(0, 20)
        }
    };

    console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
    console.error('[Graph Audit] Error:', error.message);
    process.exit(1);
});
