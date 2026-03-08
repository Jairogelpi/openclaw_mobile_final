import supabase from '../config/supabase.mjs';
import { distillAndVectorize } from '../memory_worker.mjs';
import { hydrateContactIdentities, repairOwnerIdentity } from '../services/identity.service.mjs';
import { invalidateSemanticCache } from '../services/local_ai.mjs';

const clientId = process.argv[2];
const keepCount = Number(process.argv[3] || 6000);

if (!clientId) {
    console.error('Usage: node scripts/retain_recent_raw_messages.mjs <client_id> [keep_count]');
    process.exit(1);
}

if (!Number.isFinite(keepCount) || keepCount <= 0) {
    console.error('keep_count must be a positive integer.');
    process.exit(1);
}

const tablesToClear = [
    'node_communities',
    'knowledge_communities',
    'knowledge_edges',
    'knowledge_nodes',
    'user_memories',
    'contact_personas',
    'contact_identities',
    'inbox_summaries',
    'rag_eval_runs',
    'rag_eval_cases'
];

async function clearClientTable(tableName) {
    const { error } = await supabase.from(tableName).delete().eq('client_id', clientId);
    if (error) {
        console.warn(`[Retain] No se pudo limpiar ${tableName}: ${error.message}`);
        return;
    }
    console.log(`[Retain] ${tableName} limpiada.`);
}

async function countRawMessages() {
    const { count, error } = await supabase
        .from('raw_messages')
        .select('*', { head: true, count: 'exact' })
        .eq('client_id', clientId);

    if (error) throw error;
    return Number(count || 0);
}

async function fetchAllRawMessageRows() {
    const pageSize = 1000;
    let from = 0;
    let rows = [];

    while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await supabase
            .from('raw_messages')
            .select('id, created_at')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to);

        if (error) throw error;
        if (!data?.length) break;

        rows = rows.concat(data);
        if (data.length < pageSize) break;
        from += pageSize;
    }

    const total = await countRawMessages();
    if (rows.length !== total) {
        throw new Error(`Expected to fetch ${total} raw_messages but only received ${rows.length}.`);
    }

    return rows;
}

async function deleteRawMessagesByIds(ids) {
    const batchSize = 200;
    for (let index = 0; index < ids.length; index += batchSize) {
        const batch = ids.slice(index, index + batchSize);
        const { error } = await supabase.from('raw_messages').delete().in('id', batch);
        if (error) throw error;
        console.log(`[Retain] Eliminados ${Math.min(index + batch.length, ids.length)}/${ids.length} raw_messages antiguos.`);
    }
}

async function remainingRawMessages() {
    const { count, error } = await supabase
        .from('raw_messages')
        .select('*', { head: true, count: 'exact' })
        .eq('client_id', clientId)
        .eq('processed', false);

    if (error) throw error;
    return Number(count || 0);
}

async function retainRecentRawMessages() {
    console.log(`[Retain] Preparando corpus de ${keepCount} raw_messages para ${clientId}...`);

    await supabase
        .from('user_souls')
        .update({ is_processing: true, worker_status: `Retaining last ${keepCount} raw messages...` })
        .eq('client_id', clientId);

    const totalBefore = await countRawMessages();
    console.log(`[Retain] raw_messages actuales: ${totalBefore}`);

    const rows = await fetchAllRawMessageRows();
    if (!rows.length) {
        console.log('[Retain] No hay raw_messages para este cliente.');
        await supabase
            .from('user_souls')
            .update({ is_processing: false, worker_status: 'No raw messages to retain' })
            .eq('client_id', clientId);
        return;
    }

    const keepRows = rows.slice(0, keepCount);
    const deleteRows = rows.slice(keepCount);

    console.log(`[Retain] Se conservarán ${keepRows.length} mensajes y se eliminarán ${deleteRows.length}.`);
    console.log(`[Retain] Rango retenido: ${keepRows[keepRows.length - 1]?.created_at} -> ${keepRows[0]?.created_at}`);

    for (const tableName of tablesToClear) {
        await clearClientTable(tableName);
    }

    if (deleteRows.length) {
        await deleteRawMessagesByIds(deleteRows.map(row => row.id));
    }

    const { error: resetError } = await supabase
        .from('raw_messages')
        .update({ processed: false })
        .eq('client_id', clientId);

    if (resetError) throw resetError;

    await invalidateSemanticCache(clientId);

    let remaining = await remainingRawMessages();
    console.log(`[Retain] raw_messages pendientes de procesar: ${remaining}`);

    let guard = 0;
    let previousRemaining = null;
    while (remaining > 0) {
        await distillAndVectorize(clientId);
        previousRemaining = remaining;
        remaining = await remainingRawMessages();
        guard += 1;
        console.log(`[Retain] raw_messages pendientes de procesar: ${remaining}`);

        if (remaining === previousRemaining) {
            throw new Error(`Reprocess stalled with ${remaining} raw_messages still pending.`);
        }
        if (guard > Math.ceil(keepCount / 200) + 20) {
            throw new Error(`Reprocess guard exceeded with ${remaining} raw_messages still pending.`);
        }
    }

    await hydrateContactIdentities(clientId, { force: true });
    await repairOwnerIdentity(clientId);

    const totalAfter = await countRawMessages();
    console.log(`[Retain] raw_messages finales: ${totalAfter}`);

    await supabase
        .from('user_souls')
        .update({ is_processing: false, worker_status: `Corpus ready (${totalAfter} recent raw messages)` })
        .eq('client_id', clientId);

    console.log(`[Retain] Corpus reciente reconstruido correctamente para ${clientId}.`);
}

retainRecentRawMessages().catch(async (error) => {
    console.error('[Retain] Error:', error.message);
    await supabase
        .from('user_souls')
        .update({ is_processing: false, worker_status: 'Retain/rebuild failed' })
        .eq('client_id', clientId);
    process.exit(1);
});
