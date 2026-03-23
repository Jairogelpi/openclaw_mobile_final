import supabase from '../config/supabase.mjs';
import { fallbackNameFromRemoteId, normalizeComparableText, normalizeEntityLikeText } from '../utils/message_guard.mjs';
import { classifyIdentityLikeName } from '../utils/identity_policy.mjs';
import {
    evaluateEntityAdmissibility,
    evaluateRelationshipAdmissibility
} from '../utils/graph_admissibility_policy.mjs';

const clientId = String(process.argv[2] || '').trim();

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
    /^(el|la)\s+(jefe|jefa|nino|niño|china|chino|tipo|tio|tío|piky|moraga|azid)$/i
];

const ARTICLE_ACRONYM_ENTITY_PATTERN = /^(el|la|los|las)\s+[A-ZÁÉÍÓÚÑ0-9]{2,}(?:\s+[A-ZÁÉÍÓÚÑ0-9]{2,})*$/;

const SUSPICIOUS_CONTEXT_PATTERNS = [
    /\busuario\b/i,
    /\bcontacto\b/i,
    /\bassistant\b/i,
    /\banonim/i,
    /\binterlocutor\b/i
];

function normalize(value) {
    return normalizeComparableText(normalizeEntityLikeText(String(value || '')));
}

function describeError(error) {
    if (!error) return 'Unknown error';
    if (typeof error === 'string') return error;
    return error.message || error.details || JSON.stringify(error);
}

function isBlockedNodeName(value) {
    const raw = String(value || '').trim();
    if (ARTICLE_ACRONYM_ENTITY_PATTERN.test(raw)) return false;

    const normalized = normalize(value);
    if (!normalized) return true;
    if (BLOCKED_NODE_NAMES.has(normalized)) return true;
    if (/^\d{6,}$/.test(normalized)) return true;
    if (normalized.includes('@')) return true;
    if (ROLE_LIKE_NODE_PATTERNS.some(pattern => pattern.test(raw))) return true;
    return false;
}

function isWeakGenericDescription(value) {
    const normalized = normalize(value);
    if (!normalized) return true;

    return [
        'interlocutor',
        'usuario del chat',
        'mencionado en la conversacion',
        'mencionado en la conversación',
        'conversacion',
        'conversación'
    ].includes(normalized);
}

function buildIdentityAnchorSet(rows = []) {
    return new Set(
        (rows || [])
            .flatMap(row => [row?.canonical_name, ...(Array.isArray(row?.aliases) ? row.aliases : [])])
            .map(value => normalize(value))
            .filter(Boolean)
    );
}

function isSuspiciousEdge(edge) {
    if (!edge) return false;
    if (isBlockedNodeName(edge.source_node) || isBlockedNodeName(edge.target_node)) return true;
    const relationAdmissibility = evaluateRelationshipAdmissibility({
        relationType: edge.relation_type,
        sourceEntity: { name: edge.source_node, type: null, desc: '' },
        targetEntity: { name: edge.target_node, type: null, desc: '' },
        evidence: edge.context || '',
        context: edge.context || '',
        knownNames: new Set(),
        remoteId: null,
        isGroup: false
    });
    if (!relationAdmissibility.allowed) return true;
    const context = String(edge.context || '');
    if (SUSPICIOUS_CONTEXT_PATTERNS.some(pattern => pattern.test(context))) return true;
    if (!String(edge.relation_type || '').trim()) return true;
    return false;
}

function isFallbackNumericIdentity(row) {
    const remoteId = String(row?.remote_id || '').trim();
    if (!remoteId || String(remoteId).endsWith('@g.us')) return false;

    const fallbackName = fallbackNameFromRemoteId(remoteId);
    const canonical = String(row?.canonical_name || '').trim();
    const aliases = Array.isArray(row?.aliases) ? row.aliases.map(alias => String(alias || '').trim()).filter(Boolean) : [];

    if (!fallbackName || canonical !== fallbackName) return false;
    if (!/^\d{6,}$/.test(canonical)) return false;

    return aliases.length <= 1 && (!aliases.length || aliases[0] === fallbackName);
}

async function fetchRows(table, select, { pageSize = 1000 } = {}) {
    const rows = [];
    let from = 0;

    while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await supabase
            .from(table)
            .select(select)
            .eq('client_id', clientId)
            .range(from, to);

        if (error) throw error;
        const batch = data || [];
        rows.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
    }

    return rows;
}

async function fetchCount(table) {
    const { count, error } = await supabase
        .from(table)
        .select('*', { head: true, count: 'exact' })
        .eq('client_id', clientId);

    if (error) throw error;
    return Number(count || 0);
}

async function fetchNodeCommunityCount() {
    const { data: communities, error } = await supabase
        .from('knowledge_communities')
        .select('id')
        .eq('client_id', clientId);

    if (error) throw error;
    const ids = (communities || []).map(row => row.id).filter(Boolean);
    if (!ids.length) return 0;

    const { data, error: countError } = await supabase
        .from('node_communities')
        .select('community_id')
        .in('community_id', ids);

    if (countError) throw countError;
    return Number((data || []).length);
}

async function main() {
    const [
        rawMessages,
        userMemories,
        knowledgeNodes,
        knowledgeEdges,
        contactIdentities,
        knowledgeCommunities,
        rawMessageCount,
        userMemoryCount,
        knowledgeNodeCount,
        knowledgeEdgeCount,
        contactIdentityCount,
        knowledgeCommunityCount
    ] = await Promise.all([
        fetchRows('raw_messages', 'id, sender_role, remote_id, metadata, processed'),
        fetchRows('user_memories', 'id, sender, metadata'),
        fetchRows('knowledge_nodes', 'id, entity_name, entity_type, description'),
        fetchRows('knowledge_edges', 'id, source_node, target_node, relation_type, context, weight'),
        fetchRows('contact_identities', 'id, remote_id, canonical_name, aliases, source_details'),
        fetchRows('knowledge_communities', 'id, community_name, summary, temporal_horizon, created_at'),
        fetchCount('raw_messages'),
        fetchCount('user_memories'),
        fetchCount('knowledge_nodes'),
        fetchCount('knowledge_edges'),
        fetchCount('contact_identities'),
        fetchCount('knowledge_communities')
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

    const identityAnchors = buildIdentityAnchorSet(contactIdentities);
    const suspiciousNodes = knowledgeNodes.filter(node => {
        if (isBlockedNodeName(node.entity_name)) return true;
        const identityKind = classifyIdentityLikeName(node.entity_name);
        const admissibility = evaluateEntityAdmissibility({
            name: node.entity_name,
            type: node.entity_type,
            desc: node.description || '',
            evidence: node.description || '',
            knownNames: identityAnchors,
            remoteId: null,
            isGroup: false,
            requireStrongAnchor: false
        });
        if (!admissibility.allowed) return true;
        if (
            String(node.entity_type || '').trim() === 'PERSONA'
            && identityAnchors.has(normalize(node.entity_name))
        ) {
            return false;
        }
        if (
            String(node.entity_type || '').trim() === 'PERSONA'
            && identityKind === 'human_alias'
        ) {
            return false;
        }
        return ['PERSONA', 'OBJETO', 'LUGAR', 'ORGANIZACION', 'EVENTO'].includes(String(node.entity_type || '').trim())
            && isWeakGenericDescription(node.description);
    });
    const suspiciousEdges = knowledgeEdges.filter(edge => isSuspiciousEdge(edge));
    const suspiciousIdentities = contactIdentities.filter(row => {
        if (isFallbackNumericIdentity(row)) return false;
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
            raw_messages: rawMessageCount,
            pending_raw_messages: pendingRaw,
            user_memories: userMemoryCount,
            knowledge_nodes: knowledgeNodeCount,
            knowledge_edges: knowledgeEdgeCount,
            contact_identities: contactIdentityCount,
            knowledge_communities: knowledgeCommunityCount,
            node_communities: nodeCommunityCount
        },
        generic_sender_roles: genericSenderRoles,
        quality: {
            suspicious_nodes: suspiciousNodes.length,
            suspicious_edges: suspiciousEdges.length,
            suspicious_identities: suspiciousIdentities.length,
            suspicious_node_rate: knowledgeNodeCount ? Number((suspiciousNodes.length / knowledgeNodeCount).toFixed(4)) : 0,
            suspicious_edge_rate: knowledgeEdgeCount ? Number((suspiciousEdges.length / knowledgeEdgeCount).toFixed(4)) : 0,
            suspicious_identity_rate: contactIdentityCount ? Number((suspiciousIdentities.length / contactIdentityCount).toFixed(4)) : 0
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
    console.error('[Graph Audit] Error:', describeError(error));
    process.exit(1);
});
