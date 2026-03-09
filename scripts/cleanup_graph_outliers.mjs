import supabase from '../config/supabase.mjs';
import {
    hasLeadingArticleName,
    hasLowercaseArticleEntityShape,
    isPhoneLikeGraphName,
    isWeakEntityDescription,
    isWeakPersonDescription
} from '../utils/graph_admissibility_policy.mjs';
import { normalizeComparableText, pickBestHumanName, looksLikeWhatsAppRemoteId } from '../utils/message_guard.mjs';
import { classifyIdentityLikeName, looksHumanIdentityLabel } from '../utils/identity_policy.mjs';
import { computeEdgeStability } from '../utils/stable_graph_policy.mjs';

const clientId = process.argv[2];
const applyMode = process.argv.includes('--apply');
const WEAK_ORPHAN_TYPES = new Set(['OBJETO', 'ENTITY', 'EVENTO', 'TEMA']);
function isWeakCandidateNode(node) {
    const entityType = String(node?.entity_type || '').trim().toUpperCase();
    const entityName = String(node?.entity_name || '').trim();
    const description = String(node?.description || '').trim();
    const stableScore = Number(node?.stable_score || 0);
    const supportCount = Number(node?.support_count || 0);

    if (!entityName) return false;

    if (entityType === 'PERSONA') {
        return Boolean(
            supportCount <= 1
            && stableScore < 4
            && (
                isPhoneLikeGraphName(entityName)
                || (
                    hasLeadingArticleName(entityName)
                    && (
                        hasLowercaseArticleEntityShape(entityName)
                        || isWeakPersonDescription(description)
                        || isWeakEntityDescription(description)
                    )
                )
            )
        );
    }

    if (WEAK_ORPHAN_TYPES.has(entityType)) {
        return Boolean(
            supportCount <= 1
            && (
                stableScore < 5
                || isWeakEntityDescription(description)
                || (hasLeadingArticleName(entityName) && hasLowercaseArticleEntityShape(entityName))
            )
        );
    }

    if (entityType === 'LUGAR' || entityType === 'ORGANIZACION') {
        return Boolean(
            supportCount <= 1
            && stableScore < 4
            && hasLeadingArticleName(entityName)
            && (
                hasLowercaseArticleEntityShape(entityName)
                || isWeakEntityDescription(description)
            )
        );
    }

    return Boolean(supportCount <= 1 && stableScore < 2 && hasLeadingArticleName(entityName));
}

export async function cleanupGraphOutliers(targetClientId, { apply = false } = {}) {
    if (!targetClientId) {
        throw new Error('cleanupGraphOutliers requires a clientId');
    }

    const { data: nodes, error } = await supabase
        .from('knowledge_nodes')
        .select('id, entity_name, entity_type, description, stability_tier, stable_score, support_count')
        .eq('client_id', targetClientId);

    if (error) throw error;

    const allNodes = nodes || [];
    const nodeTypeByName = new Map(
        allNodes.map(node => [node.entity_name, String(node.entity_type || '').trim().toUpperCase()])
    );
    const phoneLikePeople = allNodes.filter(node => node.entity_type === 'PERSONA' && isPhoneLikeGraphName(node.entity_name));
    const phoneLikeNames = [...new Set(phoneLikePeople.map(node => node.entity_name).filter(Boolean))];

    const { data: allEdges, error: edgeReadError } = await supabase
        .from('knowledge_edges')
        .select('id, source_node, relation_type, target_node, context, support_count, weight, source_tags, cognitive_flags, stable_score, stability_tier')
        .eq('client_id', targetClientId);

    if (edgeReadError) throw edgeReadError;

    const { data: rawMessages, error: rawError } = await supabase
        .from('raw_messages')
        .select('remote_id, metadata')
        .eq('client_id', targetClientId)
        .like('remote_id', '%@g.us');

    if (rawError) throw rawError;

    const { data: identityRows, error: identityError } = await supabase
        .from('contact_identities')
        .select('canonical_name, aliases')
        .eq('client_id', targetClientId);

    if (identityError) throw identityError;

    const groupNames = new Set(
        (rawMessages || [])
            .flatMap(message => [
                message?.metadata?.conversationName,
                message?.metadata?.pushName
            ])
            .map(value => pickBestHumanName(value))
            .filter(value => value && !looksLikeWhatsAppRemoteId(value))
    );
    const identityAnchors = new Set(
        (identityRows || [])
            .flatMap(row => [row?.canonical_name, ...(Array.isArray(row?.aliases) ? row.aliases : [])])
            .map(value => normalizeComparableText(value))
            .filter(Boolean)
    );

    const groupTalkEdges = (allEdges || []).filter(edge =>
        String(edge.relation_type || '').trim() === '[HABLA_DE]'
        && (
            nodeTypeByName.get(edge.source_node) !== 'PERSONA'
            || groupNames.has(edge.source_node)
        )
        && nodeTypeByName.get(edge.target_node) === 'PERSONA'
    );

    const weakGenericEdges = (allEdges || []).filter(edge => {
        const relationType = String(edge.relation_type || '').trim();
        if (!['[RELACIONADO_CON]', '[HABLA_DE]', '[EVENTO_CON]', '[AMISTAD]', '[CONOCE_A]', '[PAREJA_DE]', '[FAMILIA_DE]'].includes(relationType)) return false;

        const normalizedContext = String(edge.context || '').toLowerCase();
        if (
            relationType === '[HABLA_DE]'
            && (
                normalizedContext.includes('hablar con')
                || normalizedContext.includes('quiere hablar con')
                || normalizedContext.includes('respuesta sobre')
                || normalizedContext.includes('respuesta a')
                || normalizedContext.includes('gracias')
                || normalizedContext.includes('expresion de afecto')
                || normalizedContext.includes('expresión de afecto')
            )
        ) {
            return true;
        }

        const stability = computeEdgeStability({
            relationType,
            context: edge.context || '',
            supportCount: edge.support_count || 1,
            weight: edge.weight || 1,
            sourceTags: edge.source_tags || [],
            flags: edge.cognitive_flags || [],
            existingScore: 0,
            existingTier: 'candidate'
        });

        return stability.tier === 'candidate';
    });

    const edgeIdsToDelete = new Set([
        ...(allEdges || [])
            .filter(edge => phoneLikeNames.includes(edge.source_node) || phoneLikeNames.includes(edge.target_node))
            .map(edge => edge.id),
        ...groupTalkEdges.map(edge => edge.id),
        ...weakGenericEdges.map(edge => edge.id)
    ].filter(Boolean));

    const survivingIncidentCounts = new Map();
    for (const edge of (allEdges || [])) {
        if (edgeIdsToDelete.has(edge.id)) continue;
        for (const endpoint of [edge.source_node, edge.target_node]) {
            const key = String(endpoint || '').trim();
            if (!key) continue;
            survivingIncidentCounts.set(key, (survivingIncidentCounts.get(key) || 0) + 1);
        }
    }

    const weakCandidateOrphanNodes = allNodes.filter(node =>
        String(node.stability_tier || '').trim().toLowerCase() === 'candidate'
        && !survivingIncidentCounts.has(String(node.entity_name || '').trim())
        && isWeakCandidateNode(node)
    );
    const weakUnanchoredPersonNodes = allNodes.filter(node => {
        const entityName = String(node?.entity_name || '').trim();
        if (String(node?.entity_type || '').trim().toUpperCase() !== 'PERSONA') return false;
        if (!entityName) return false;
        if (identityAnchors.has(normalizeComparableText(entityName))) return false;
        if ((survivingIncidentCounts.get(entityName) || 0) > 1) return false;
        if (Number(node?.support_count || 0) > 2) return false;

        const description = String(node?.description || '').trim();
        const identityKind = classifyIdentityLikeName(entityName);
        return Boolean(
            identityKind === 'role_mention'
            || identityKind === 'group_label'
            || isWeakPersonDescription(description)
            || (!looksHumanIdentityLabel(entityName) && (!description || isWeakEntityDescription(description)))
        );
    });
    const groupLabelPersonNodes = allNodes.filter(node =>
        String(node?.entity_type || '').trim().toUpperCase() === 'PERSONA'
        && classifyIdentityLikeName(String(node?.entity_name || '').trim()) === 'group_label'
    );

    let deletedEdges = 0;
    let deletedNodes = 0;

    if (apply) {
        for (const node of groupLabelPersonNodes) {
            const { error: retypeError } = await supabase
                .from('knowledge_nodes')
                .update({
                    entity_type: 'GRUPO',
                    updated_at: new Date().toISOString()
                })
                .eq('id', node.id);
            if (retypeError) throw retypeError;
        }

        const edgeIds = [...edgeIdsToDelete];
        if (edgeIds.length) {
            const { error: edgeDeleteError } = await supabase
                .from('knowledge_edges')
                .delete()
                .in('id', edgeIds);
            if (edgeDeleteError) throw edgeDeleteError;
            deletedEdges = edgeIds.length;
        }

        const nodeIds = [
            ...phoneLikePeople.map(node => node.id),
            ...weakCandidateOrphanNodes.map(node => node.id),
            ...weakUnanchoredPersonNodes.map(node => node.id)
        ].filter(Boolean);
        const uniqueNodeIds = [...new Set(nodeIds)];
        if (uniqueNodeIds.length) {
            const { error: nodeDeleteError } = await supabase
                .from('knowledge_nodes')
                .delete()
                .in('id', uniqueNodeIds);
            if (nodeDeleteError) throw nodeDeleteError;
            deletedNodes = uniqueNodeIds.length;
        }
    }

    return {
        client_id: targetClientId,
        apply,
        phone_like_person_nodes: phoneLikePeople.map(node => ({
            id: node.id,
            entity_name: node.entity_name,
            stability_tier: node.stability_tier,
            stable_score: node.stable_score,
            support_count: node.support_count
        })),
        group_to_person_talk_edges: groupTalkEdges,
        weak_generic_edges: weakGenericEdges.map(edge => ({
            id: edge.id,
            source_node: edge.source_node,
            relation_type: edge.relation_type,
            target_node: edge.target_node,
            context: edge.context,
            support_count: edge.support_count,
            stability_tier: edge.stability_tier
        })),
        weak_candidate_orphan_nodes: weakCandidateOrphanNodes.map(node => ({
            id: node.id,
            entity_name: node.entity_name,
            entity_type: node.entity_type,
            description: node.description,
            support_count: node.support_count,
            stable_score: node.stable_score,
            stability_tier: node.stability_tier
        })),
        weak_unanchored_person_nodes: weakUnanchoredPersonNodes.map(node => ({
            id: node.id,
            entity_name: node.entity_name,
            entity_type: node.entity_type,
            description: node.description,
            support_count: node.support_count,
            stable_score: node.stable_score,
            stability_tier: node.stability_tier
        })),
        retyped_group_label_person_nodes: groupLabelPersonNodes.map(node => ({
            id: node.id,
            entity_name: node.entity_name,
            entity_type: node.entity_type,
            description: node.description,
            support_count: node.support_count,
            stable_score: node.stable_score,
            stability_tier: node.stability_tier
        })),
        group_labels: [...groupNames].slice(0, 20),
        deleted_nodes: deletedNodes,
        deleted_edges: deletedEdges
    };
}

if (!clientId) {
    console.error('Usage: node scripts/cleanup_graph_outliers.mjs <client_id> [--apply]');
    process.exit(1);
}

async function main() {
    const report = await cleanupGraphOutliers(clientId, { apply: applyMode });
    console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
    console.error('[Cleanup Graph Outliers] Error:', error.message);
    process.exit(1);
});
