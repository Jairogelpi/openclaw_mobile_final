import supabase from '../config/supabase.mjs';
import {
    evaluateEntityAdmissibility,
    evaluateRelationshipAdmissibility
} from '../utils/graph_admissibility_policy.mjs';

const clientId = process.argv[2];

if (!clientId) {
    console.error('Usage: node scripts/graph_metrics_report.mjs <client_id>');
    process.exit(1);
}

function increment(map, key) {
    const normalizedKey = key || 'unknown';
    map[normalizedKey] = (map[normalizedKey] || 0) + 1;
}

function sortCounts(map) {
    return Object.fromEntries(
        Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    );
}

function round(value) {
    return Number(Number(value || 0).toFixed(4));
}

async function countRows(table) {
    const { count, error } = await supabase
        .from(table)
        .select('*', { head: true, count: 'exact' })
        .eq('client_id', clientId);

    if (error) throw error;
    return Number(count || 0);
}

async function main() {
    const [
        rawMessages,
        pendingRawMessages,
        nodesResult,
        edgesResult,
        memories,
        identities,
        communities,
        nodeCommunities
    ] = await Promise.all([
        countRows('raw_messages'),
        supabase.from('raw_messages').select('*', { head: true, count: 'exact' }).eq('client_id', clientId).eq('processed', false),
        supabase.from('knowledge_nodes').select('id, entity_name, entity_type, description, stability_tier, support_count, stable_score, source_tags').eq('client_id', clientId),
        supabase.from('knowledge_edges').select('id, source_node, target_node, relation_type, context, stability_tier, support_count, stable_score, cognitive_flags, source_tags').eq('client_id', clientId),
        countRows('user_memories'),
        countRows('contact_identities'),
        countRows('knowledge_communities'),
        supabase.from('knowledge_communities').select('id').eq('client_id', clientId)
    ]);

    if (nodesResult.error) throw nodesResult.error;
    if (edgesResult.error) throw edgesResult.error;
    if (pendingRawMessages.error) throw pendingRawMessages.error;
    if (nodeCommunities.error) throw nodeCommunities.error;

    const nodes = nodesResult.data || [];
    const edges = edgesResult.data || [];
    const communityIds = (nodeCommunities.data || []).map(row => row.id).filter(Boolean);

    const nodeTierCounts = {};
    const nodeTypeCounts = {};
    const edgeTierCounts = {};
    const edgeTypeCounts = {};
    const weakNodes = [];
    const weakEdges = [];

    for (const node of nodes) {
        increment(nodeTierCounts, node.stability_tier || 'candidate');
        increment(nodeTypeCounts, node.entity_type || 'ENTITY');

        const verdict = evaluateEntityAdmissibility({
            name: node.entity_name,
            type: node.entity_type,
            desc: node.description,
            requireStrongAnchor: false
        });

        if (!verdict.allowed) {
            weakNodes.push({
                entity_name: node.entity_name,
                entity_type: node.entity_type,
                description: node.description,
                stability_tier: node.stability_tier || 'candidate',
                reason: verdict.reason,
                support_count: node.support_count || 0,
                stable_score: node.stable_score || 0
            });
        }
    }

    for (const edge of edges) {
        increment(edgeTierCounts, edge.stability_tier || 'candidate');
        increment(edgeTypeCounts, edge.relation_type || '[UNKNOWN]');

        const verdict = evaluateRelationshipAdmissibility({
            relationType: edge.relation_type,
            context: edge.context || '',
            sourceEntity: { name: edge.source_node },
            targetEntity: { name: edge.target_node }
        });

        if (!verdict.allowed) {
            weakEdges.push({
                source_node: edge.source_node,
                relationship_type: edge.relation_type,
                target_node: edge.target_node,
                context: edge.context,
                stability_tier: edge.stability_tier || 'candidate',
                reason: verdict.reason,
                support_count: edge.support_count || 0,
                stable_score: edge.stable_score || 0
            });
        }
    }

    const totalNodes = nodes.length || 0;
    const totalEdges = edges.length || 0;
    const personNodes = Number(nodeTypeCounts.PERSONA || 0);
    const genericEdges = Number(edgeTypeCounts['[RELACIONADO_CON]'] || 0);
    const genericTalkEdges = genericEdges + Number(edgeTypeCounts['[HABLA_DE]'] || 0);
    const candidateNodes = Number(nodeTierCounts.candidate || 0);
    const candidateEdges = Number(edgeTierCounts.candidate || 0);
    const provisionalStableNodes = totalNodes - candidateNodes;
    const provisionalStableEdges = totalEdges - candidateEdges;
    const stableEdges = edges.filter(edge => ['provisional', 'stable'].includes(String(edge.stability_tier || '').trim().toLowerCase()));
    const stableGenericEdges = stableEdges.filter(edge => ['[RELACIONADO_CON]', '[HABLA_DE]'].includes(edge.relation_type)).length;

    const nodeCommunityCount = communityIds.length
        ? await supabase.from('node_communities').select('*', { head: true, count: 'exact' }).in('community_id', communityIds)
        : { count: 0, error: null };

    if (nodeCommunityCount.error) throw nodeCommunityCount.error;

    console.log(JSON.stringify({
        client_id: clientId,
        totals: {
            raw_messages: rawMessages,
            pending_raw_messages: Number(pendingRawMessages.count || 0),
            user_memories: memories,
            knowledge_nodes: totalNodes,
            knowledge_edges: totalEdges,
            contact_identities: identities,
            knowledge_communities: communities,
            node_communities: Number(nodeCommunityCount.count || 0)
        },
        distributions: {
            node_types: sortCounts(nodeTypeCounts),
            node_tiers: sortCounts(nodeTierCounts),
            edge_types: sortCounts(edgeTypeCounts),
            edge_tiers: sortCounts(edgeTierCounts)
        },
        quality: {
            suspicious_nodes: weakNodes.length,
            suspicious_edges: weakEdges.length,
            suspicious_node_rate: totalNodes ? round(weakNodes.length / totalNodes) : 0,
            suspicious_edge_rate: totalEdges ? round(weakEdges.length / totalEdges) : 0,
            person_node_ratio: totalNodes ? round(personNodes / totalNodes) : 0,
            generic_relation_ratio: totalEdges ? round(genericEdges / totalEdges) : 0,
            generic_or_talk_relation_ratio: totalEdges ? round(genericTalkEdges / totalEdges) : 0,
            stable_generic_or_talk_relation_ratio: stableEdges.length ? round(stableGenericEdges / stableEdges.length) : 0,
            promoted_node_ratio: totalNodes ? round(provisionalStableNodes / totalNodes) : 0,
            promoted_edge_ratio: totalEdges ? round(provisionalStableEdges / totalEdges) : 0
        },
        samples: {
            suspicious_nodes: weakNodes.slice(0, 10),
            suspicious_edges: weakEdges.slice(0, 10)
        }
    }, null, 2));
}

main().catch(error => {
    console.error('[Graph Metrics] Error:', error.message);
    process.exit(1);
});
