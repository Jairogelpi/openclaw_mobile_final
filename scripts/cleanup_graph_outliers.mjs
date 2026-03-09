import supabase from '../config/supabase.mjs';
import { isPhoneLikeGraphName } from '../utils/graph_admissibility_policy.mjs';
import { pickBestHumanName, looksLikeWhatsAppRemoteId } from '../utils/message_guard.mjs';

const clientId = process.argv[2];
const applyMode = process.argv.includes('--apply');

if (!clientId) {
    console.error('Usage: node scripts/cleanup_graph_outliers.mjs <client_id> [--apply]');
    process.exit(1);
}

async function main() {
    const { data: nodes, error } = await supabase
        .from('knowledge_nodes')
        .select('id, entity_name, entity_type, stability_tier, stable_score, support_count')
        .eq('client_id', clientId);

    if (error) throw error;

    const allNodes = nodes || [];
    const nodeTypeByName = new Map(
        allNodes.map(node => [node.entity_name, String(node.entity_type || '').trim().toUpperCase()])
    );
    const phoneLikePeople = allNodes.filter(node => node.entity_type === 'PERSONA' && isPhoneLikeGraphName(node.entity_name));
    const nodeNames = [...new Set(phoneLikePeople.map(node => node.entity_name).filter(Boolean))];
    const { data: allEdges, error: edgeReadError } = await supabase
        .from('knowledge_edges')
        .select('id, source_node, relation_type, target_node')
        .eq('client_id', clientId);

    if (edgeReadError) throw edgeReadError;

    const { data: rawMessages, error: rawError } = await supabase
        .from('raw_messages')
        .select('remote_id, metadata')
        .eq('client_id', clientId)
        .like('remote_id', '%@g.us');

    if (rawError) throw rawError;

    const groupNames = new Set(
        (rawMessages || [])
            .flatMap(message => [
                message?.metadata?.conversationName,
                message?.metadata?.pushName
            ])
            .map(value => pickBestHumanName(value))
            .filter(value => value && !looksLikeWhatsAppRemoteId(value))
    );

    const groupTalkEdges = (allEdges || []).filter(edge =>
        String(edge.relation_type || '').trim() === '[HABLA_DE]'
        && (
            nodeTypeByName.get(edge.source_node) !== 'PERSONA'
            || groupNames.has(edge.source_node)
        )
        && nodeTypeByName.get(edge.target_node) === 'PERSONA'
    );

    let deletedEdges = 0;
    let deletedNodes = 0;

    if (applyMode) {
        const edgeIds = [
            ...(allEdges || [])
                .filter(edge => nodeNames.includes(edge.source_node) || nodeNames.includes(edge.target_node))
                .map(edge => edge.id),
            ...groupTalkEdges.map(edge => edge.id)
        ].filter(Boolean);

        if (edgeIds.length) {
            const { error: edgeDeleteError } = await supabase
                .from('knowledge_edges')
                .delete()
                .in('id', edgeIds);
            if (edgeDeleteError) throw edgeDeleteError;
            deletedEdges = edgeIds.length;
        }

        const nodeIds = phoneLikePeople.map(node => node.id).filter(Boolean);
        if (nodeIds.length) {
            const { error: nodeDeleteError } = await supabase
                .from('knowledge_nodes')
                .delete()
                .in('id', nodeIds);
            if (nodeDeleteError) throw nodeDeleteError;
            deletedNodes = nodeIds.length;
        }
    }

    console.log(JSON.stringify({
        client_id: clientId,
        apply: applyMode,
        phone_like_person_nodes: phoneLikePeople.map(node => ({
            id: node.id,
            entity_name: node.entity_name,
            stability_tier: node.stability_tier,
            stable_score: node.stable_score,
            support_count: node.support_count
        })),
        group_to_person_talk_edges: groupTalkEdges,
        group_labels: [...groupNames].slice(0, 20),
        deleted_nodes: deletedNodes,
        deleted_edges: deletedEdges
    }, null, 2));
}

main().catch(error => {
    console.error('[Cleanup Graph Outliers] Error:', error.message);
    process.exit(1);
});
