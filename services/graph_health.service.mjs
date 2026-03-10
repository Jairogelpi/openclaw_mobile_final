import supabase from '../config/supabase.mjs';

function toNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function countClientRows(clientId, tableName, extra = query => query) {
    const { count, error } = await extra(
        supabase
            .from(tableName)
            .select('*', { head: true, count: 'exact' })
            .eq('client_id', clientId)
    );

    if (error) throw error;
    return toNumber(count);
}

async function estimateDistinctRemotes(clientId) {
    try {
        const { data, error } = await supabase
            .from('raw_messages')
            .select('remote_id, metadata')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(3000);

        if (error) throw error;

        const remotes = new Set();
        for (const row of (data || [])) {
            const remoteId = String(row?.metadata?.participantJid || row?.remote_id || '').trim();
            if (remoteId) remotes.add(remoteId);
        }
        return remotes.size;
    } catch (error) {
        console.warn('[Graph Health] distinct remote estimate skipped:', error.message);
        return 0;
    }
}

export function assessGraphReliability(snapshot) {
    const totals = snapshot?.totals || {};
    const distinctRemotes = toNumber(snapshot?.derived?.distinct_remotes);
    const warnings = [];
    const failures = [];

    if (totals.raw_messages > 0 && totals.user_memories === 0) {
        failures.push('memories_empty');
    }

    if (totals.pending_raw_messages > 0) {
        warnings.push('pending_raw_messages');
    }

    const expectedIdentityFloor = distinctRemotes > 0
        ? Math.max(3, Math.floor(distinctRemotes * 0.5))
        : 0;

    if (totals.user_memories >= 25 && expectedIdentityFloor > 0 && totals.contact_identities < expectedIdentityFloor) {
        failures.push('underhydrated_identities');
    }

    if (totals.entity_mentions >= 30 && totals.relation_mentions === 0) {
        warnings.push('relation_pipeline_empty');
    }

    if (totals.knowledge_nodes >= 20 && totals.knowledge_communities === 0) {
        warnings.push('communities_missing');
    }

    if (totals.entity_mentions > 0 && totals.knowledge_nodes === 0) {
        failures.push('mentions_not_promoted');
    }

    return {
        reliable: failures.length === 0,
        failures,
        warnings
    };
}

export async function collectGraphHealthSnapshot(clientId) {
    const [
        rawMessages,
        pendingRawMessages,
        userMemories,
        entityMentions,
        relationMentions,
        knowledgeNodes,
        knowledgeEdges,
        contactIdentities,
        knowledgeCommunities,
        distinctRemotes
    ] = await Promise.all([
        countClientRows(clientId, 'raw_messages'),
        countClientRows(clientId, 'raw_messages', query => query.eq('processed', false)),
        countClientRows(clientId, 'user_memories'),
        countClientRows(clientId, 'entity_mentions'),
        countClientRows(clientId, 'relation_mentions'),
        countClientRows(clientId, 'knowledge_nodes'),
        countClientRows(clientId, 'knowledge_edges'),
        countClientRows(clientId, 'contact_identities'),
        countClientRows(clientId, 'knowledge_communities'),
        estimateDistinctRemotes(clientId)
    ]);

    const snapshot = {
        client_id: clientId,
        totals: {
            raw_messages: rawMessages,
            pending_raw_messages: pendingRawMessages,
            user_memories: userMemories,
            entity_mentions: entityMentions,
            relation_mentions: relationMentions,
            knowledge_nodes: knowledgeNodes,
            knowledge_edges: knowledgeEdges,
            contact_identities: contactIdentities,
            knowledge_communities: knowledgeCommunities
        },
        derived: {
            distinct_remotes: distinctRemotes
        }
    };

    return {
        ...snapshot,
        assessment: assessGraphReliability(snapshot)
    };
}

export function formatGraphHealthStatus(snapshot) {
    const assessment = snapshot?.assessment || { reliable: true, failures: [], warnings: [] };
    const pending = toNumber(snapshot?.totals?.pending_raw_messages);

    if (pending > 0) {
        const warningSuffix = assessment.failures.length
            ? ` | salud: ${assessment.failures.join(',')}`
            : '';
        return `◦ Cerebro en reposo (${pending} pendientes${warningSuffix})`;
    }

    if (!assessment.reliable) {
        return `⚠ Grafo no confiable: ${assessment.failures.join(', ')}`;
    }

    if (assessment.warnings.length) {
        return `◦ Cerebro en reposo (grafo consistente, avisos: ${assessment.warnings.join(', ')})`;
    }

    return '◦ Cerebro en reposo (grafo consistente)';
}
