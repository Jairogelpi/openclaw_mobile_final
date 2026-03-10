import supabase from '../config/supabase.mjs';
import { distillAndVectorize } from '../memory_worker.mjs';
import { hydrateContactIdentities, repairOwnerIdentity } from '../services/identity.service.mjs';
import { detectAndSaveCommunities } from '../services/community.service.mjs';
import { backfillDeferredMemoryEmbeddings } from '../services/memory_embedding_backfill.service.mjs';
import { getEmbeddingRuntimeStats, resetEmbeddingRuntimeStats } from '../services/local_ai.mjs';
import { cleanupGraphOutliers } from './cleanup_graph_outliers.mjs';
import { collectGraphHealthSnapshot, formatGraphHealthStatus } from '../services/graph_health.service.mjs';

const clientId = process.argv[2];
const resumeMode = process.argv.includes('--resume');
const forceReprocessMode = process.argv.includes('--force-reprocess');

if (!clientId) {
    console.error('Usage: node scripts/rebuild_whatsapp_relations.mjs <client_id> [--resume] [--force-reprocess]');
    process.exit(1);
}

const tablesToClear = [
    'node_communities',
    'knowledge_edges',
    'knowledge_nodes',
    'relation_mentions',
    'entity_mentions',
    'user_memories',
    'contact_personas',
    'contact_identities',
    'inbox_summaries',
    'knowledge_communities'
];

async function clearClientTable(tableName) {
    if (tableName === 'node_communities') {
        const { data: communities, error: communityError } = await supabase
            .from('knowledge_communities')
            .select('id')
            .eq('client_id', clientId);

        if (communityError) {
            console.warn(`[Rebuild] No se pudo leer knowledge_communities: ${communityError.message}`);
            return;
        }

        const communityIds = (communities || []).map(row => row.id).filter(Boolean);
        if (!communityIds.length) {
            console.log('[Rebuild] node_communities sin registros que limpiar.');
            return;
        }

        const { error: nodeError } = await supabase
            .from('node_communities')
            .delete()
            .in('community_id', communityIds);

        if (nodeError) {
            console.warn(`[Rebuild] No se pudo limpiar node_communities: ${nodeError.message}`);
            return;
        }

        console.log('[Rebuild] node_communities limpiada.');
        return;
    }

    const { error } = await supabase.from(tableName).delete().eq('client_id', clientId);
    if (error) {
        console.warn(`[Rebuild] No se pudo limpiar ${tableName}: ${error.message}`);
        return;
    }
    console.log(`[Rebuild] ${tableName} limpiada.`);
}

async function remainingRawMessages() {
    const { count, error } = await supabase
        .from('raw_messages')
        .select('*', { head: true, count: 'exact' })
        .eq('client_id', clientId)
        .eq('processed', false);

    if (error) {
        throw error;
    }

    return count || 0;
}

async function countClientRows(tableName) {
    const { count, error } = await supabase
        .from(tableName)
        .select('*', { head: true, count: 'exact' })
        .eq('client_id', clientId);

    if (error) {
        throw error;
    }

    return Number(count || 0);
}

async function rebuild() {
    console.log(`[Rebuild] Iniciando saneado de relaciones para ${clientId}${resumeMode ? ' (resume)' : ''}${forceReprocessMode ? ' (force-reprocess)' : ''}...`);
    resetEmbeddingRuntimeStats();

    await supabase
        .from('user_souls')
        .update({ is_processing: true, worker_status: (resumeMode && !forceReprocessMode) ? 'Rebuild phase A: resuming clean WhatsApp rebuild...' : 'Rebuild phase A: rebuilding clean WhatsApp relations...' })
        .eq('client_id', clientId);

    let effectiveResumeMode = resumeMode && !forceReprocessMode;
    if (forceReprocessMode) {
        console.log('[Rebuild] Modo force-reprocess activo: se reprocesara todo el corpus.');
    }
    if (resumeMode) {
        const [entityMentions, relationMentions, pending] = await Promise.all([
            countClientRows('entity_mentions').catch(() => 0),
            countClientRows('relation_mentions').catch(() => 0),
            remainingRawMessages().catch(() => 0)
        ]);

        if (pending === 0 && entityMentions === 0 && relationMentions === 0) {
            console.log('[Rebuild] Resume invalido para backfill: no hay menciones y no quedan raw_messages pendientes. Cambio automatico a rebuild completo.');
            effectiveResumeMode = false;
        }
    }

    if (!effectiveResumeMode) {
        for (const tableName of tablesToClear) {
            await clearClientTable(tableName);
        }

        const { error: resetError } = await supabase
            .from('raw_messages')
            .update({ processed: false })
            .eq('client_id', clientId);

        if (resetError) {
            throw resetError;
        }
    }

    await supabase
        .from('user_souls')
        .update({ is_processing: true, worker_status: effectiveResumeMode ? 'Rebuild phase A: resuming clean WhatsApp rebuild...' : 'Rebuild phase A: rebuilding clean WhatsApp relations...' })
        .eq('client_id', clientId);

    let remaining = await remainingRawMessages();
    console.log(`[Rebuild] raw_messages pendientes: ${remaining}`);
    let iteration = 0;

    while (remaining > 0) {
        iteration += 1;
        await distillAndVectorize(clientId, {
            mode: 'rebuild',
            skipAutonomousDistillation: true,
            skipCommunityDetection: true,
            skipIdentityHydration: true
        });
        remaining = await remainingRawMessages();
        await supabase
            .from('user_souls')
            .update({
                is_processing: true,
                worker_status: `Rebuild phase A loop ${iteration}: ${remaining} raw_messages pendientes`
            })
            .eq('client_id', clientId);
        console.log(`[Rebuild] raw_messages pendientes: ${remaining}`);
    }

    await supabase
        .from('user_souls')
        .update({
            is_processing: true,
            worker_status: 'Rebuild phase B: embedding backfill, identities and cleanup...'
        })
        .eq('client_id', clientId);

    await hydrateContactIdentities(clientId, { force: true });
    const embeddingBackfill = await backfillDeferredMemoryEmbeddings(clientId, { batchSize: 120, maxRows: 2000, prioritizeConsolidated: true });
    console.log(`[Rebuild] Backfill de embeddings completado. Filas revisadas: ${embeddingBackfill.processed}. Filas actualizadas: ${embeddingBackfill.updated}.`);
    await repairOwnerIdentity(clientId);
    const cleanupReport = await cleanupGraphOutliers(clientId, { apply: true });
    console.log(`[Rebuild] Cleanup automatico completado. Nodos borrados: ${cleanupReport.deleted_nodes}. Edges borrados: ${cleanupReport.deleted_edges}.`);
    await detectAndSaveCommunities(clientId);

    const health = await collectGraphHealthSnapshot(clientId);
    const embeddingStats = getEmbeddingRuntimeStats();
    await supabase
        .from('user_souls')
        .update({
            is_processing: false,
            worker_status: `${formatGraphHealthStatus(health)} | rebuild cleanup: ${cleanupReport.deleted_nodes} nodes, ${cleanupReport.deleted_edges} edges | embedding backfill: ${embeddingBackfill.updated} | cache hits:${embeddingStats.embedding_cache_hits} misses:${embeddingStats.embedding_cache_misses} deferred:${embeddingStats.deferred_embedding_count}`
        })
        .eq('client_id', clientId);

    console.log(`[Rebuild] Reconstrucción completa para ${clientId}.`);
}

rebuild().catch(async error => {
    console.error('[Rebuild] Error:', error.message);
    await supabase
        .from('user_souls')
        .update({ is_processing: false, worker_status: 'Rebuild failed' })
        .eq('client_id', clientId);
    process.exit(1);
});
