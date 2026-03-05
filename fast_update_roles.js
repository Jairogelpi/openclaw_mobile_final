import supabase from './config/supabase.mjs';

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';

async function fastUpdate() {
    console.log(`🚀 Inciando actualización de sender_roles para ${clientId}...`);

    let offset = 0;
    const FETCH_SIZE = 1000;

    while (true) {
        const { data: msgs, error } = await supabase.from('raw_messages')
            .select('id, metadata, sender_role')
            .eq('client_id', clientId)
            .eq('processed', false)
            .range(offset, offset + FETCH_SIZE - 1);

        if (error) {
            console.error('❌ Error fetching batch:', error.message);
            break;
        }
        if (!msgs || msgs.length === 0) {
            console.log('✅ ¡No quedan más mensajes por actualizar!');
            break;
        }

        console.log(`📦 Procesando lote: ${offset} - ${offset + msgs.length}`);

        // Process sequentially in smaller parallel blocks to avoid 502/500
        const miniBatchSize = 25;
        for (let i = 0; i < msgs.length; i += miniBatchSize) {
            const miniBatch = msgs.slice(i, i + miniBatchSize);
            const promises = miniBatch.map(async m => {
                let newRole = 'Contacto';
                if (m.sender_role === 'user_sent' || m.sender_role === 'Usuario') {
                    newRole = 'Usuario';
                } else if (m.metadata?.pushName) {
                    newRole = m.metadata.pushName;
                } else if (m.sender_role === 'assistant' || m.sender_role === 'Historial') {
                    newRole = 'Contacto';
                } else {
                    newRole = m.sender_role || 'Contacto';
                }

                // Retry logic for 502/500
                let retries = 3;
                while (retries > 0) {
                    try {
                        const { error: updateError } = await supabase.from('raw_messages')
                            .update({ sender_role: newRole })
                            .eq('id', m.id);

                        if (!updateError) break;
                        console.warn(`[Retry] Update error for ${m.id}: ${updateError.message}. Retries left: ${retries - 1}`);
                    } catch (e) {
                        console.warn(`[Retry] Exception for ${m.id}: ${e.message}`);
                    }
                    retries--;
                    await new Promise(r => setTimeout(r, 500));
                }
            });
            await Promise.all(promises);
            // Slight delay between mini-batches
            await new Promise(r => setTimeout(r, 100));
        }

        offset += FETCH_SIZE;
        console.log(`   Lote completado. Siguiente offset: ${offset}`);
    }

    console.log('🏁 Proceso completado.');
    process.exit(0);
}

fastUpdate();
