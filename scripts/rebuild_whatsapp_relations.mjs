import supabase from '../config/supabase.mjs';
import { distillAndVectorize } from '../memory_worker.mjs';

const clientId = process.argv[2];

if (!clientId) {
    console.error('Usage: node scripts/rebuild_whatsapp_relations.mjs <client_id>');
    process.exit(1);
}

const tablesToClear = [
    'knowledge_edges',
    'knowledge_nodes',
    'user_memories',
    'contact_personas',
    'inbox_summaries',
    'knowledge_communities'
];

async function clearClientTable(tableName) {
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

async function rebuild() {
    console.log(`[Rebuild] Iniciando saneado de relaciones para ${clientId}...`);

    await supabase
        .from('user_souls')
        .update({ is_processing: true, worker_status: 'Rebuilding clean WhatsApp relations...' })
        .eq('client_id', clientId);

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

    await supabase
        .from('user_souls')
        .update({ is_processing: false, worker_status: 'Rebuilding clean WhatsApp relations...' })
        .eq('client_id', clientId);

    let remaining = await remainingRawMessages();
    console.log(`[Rebuild] raw_messages pendientes: ${remaining}`);

    while (remaining > 0) {
        await distillAndVectorize(clientId);
        remaining = await remainingRawMessages();
        console.log(`[Rebuild] raw_messages pendientes: ${remaining}`);
    }

    await supabase
        .from('user_souls')
        .update({ is_processing: false, worker_status: 'Clean relations rebuilt' })
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
