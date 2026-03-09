import supabase from '../config/supabase.mjs';
import { distillAndVectorize } from '../memory_worker.mjs';
import { hydrateContactIdentities, repairOwnerIdentity } from '../services/identity.service.mjs';
import { detectAndSaveCommunities } from '../services/community.service.mjs';

const clientId = process.argv[2];
const resumeMode = process.argv.includes('--resume');

if (!clientId) {
    console.error('Usage: node scripts/rebuild_whatsapp_relations.mjs <client_id> [--resume]');
    process.exit(1);
}

const tablesToClear = [
    'node_communities',
    'knowledge_edges',
    'knowledge_nodes',
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

async function rebuild() {
    console.log(`[Rebuild] Iniciando saneado de relaciones para ${clientId}${resumeMode ? ' (resume)' : ''}...`);

    await supabase
        .from('user_souls')
        .update({ is_processing: true, worker_status: resumeMode ? 'Resuming clean WhatsApp rebuild...' : 'Rebuilding clean WhatsApp relations...' })
        .eq('client_id', clientId);

    if (!resumeMode) {
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
        .update({ is_processing: true, worker_status: resumeMode ? 'Resuming clean WhatsApp rebuild...' : 'Rebuilding clean WhatsApp relations...' })
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
                worker_status: `Rebuild loop ${iteration}: ${remaining} raw_messages pendientes`
            })
            .eq('client_id', clientId);
        console.log(`[Rebuild] raw_messages pendientes: ${remaining}`);
    }

    await hydrateContactIdentities(clientId, { force: true });
    await repairOwnerIdentity(clientId);
    await detectAndSaveCommunities(clientId);

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
