import supabase from './config/supabase.mjs';

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';

async function cleanup() {
    console.log(`🧹 Iniciando limpieza completa para cliente: ${clientId}`);

    // 1. Eliminar todos los nodos y aristas (grafo corrupto)
    const { error: eEdges } = await supabase.from('knowledge_edges').delete().eq('client_id', clientId);
    if (eEdges) console.error('❌ Error eliminando edges:', eEdges.message);
    else console.log('✅ Edges eliminadas.');

    const { error: eNodes } = await supabase.from('knowledge_nodes').delete().eq('client_id', clientId);
    if (eNodes) console.error('❌ Error eliminando nodes:', eNodes.message);
    else console.log('✅ Nodes eliminados.');

    // 2. Eliminar personas de contacto (para regenerarlas con nombres limpios)
    const { error: ePersonas } = await supabase.from('contact_personas').delete().eq('client_id', clientId);
    if (ePersonas) console.log('✅ Personas de contacto reseteadas.');

    // 3. Resetear todos los mensajes a processed = false
    const { error: eMsgs } = await supabase.from('raw_messages')
        .update({ processed: false })
        .eq('client_id', clientId);

    if (eMsgs) console.error('❌ Error reseteando mensajes:', eMsgs.message);
    else console.log('✅ Mensajes reseteados a "processed: false".');

    // 4. Limpiar locks de worker
    await supabase.from('user_souls')
        .update({ is_processing: false, worker_status: '○ Cerebro reseteado' })
        .eq('client_id', clientId);

    console.log('🚀 Limpieza terminada.');
    process.exit(0);
}

cleanup();
