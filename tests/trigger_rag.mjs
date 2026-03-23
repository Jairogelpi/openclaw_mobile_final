import { createClient } from '@supabase/supabase-js';
import { createClient as createRedisClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function trigger() {
    try {
        const redis = createRedisClient();
        await redis.connect();

        const { data: clients } = await supabase.from('raw_messages').select('client_id').eq('processed', false);
        if (!clients || clients.length === 0) {
            console.log('No hay clientes con mensajes pendientes.');
            process.exit(0);
        }

        const active = [...new Set(clients.map(c => c.client_id))];
        console.log(`Encontrados ${active.length} clientes con mensajes pendientes.`);

        for (const cid of active) {
            console.log(`Activando RAG para ${cid}`);
            await redis.set(`idle:${cid}`, '1', { EX: 1 });
        }

        console.log("Llaves de Redis configuradas. Expirarán en 1s y activarán el worker.");

        setTimeout(() => {
            redis.disconnect();
            process.exit(0);
        }, 2000);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}
trigger();
