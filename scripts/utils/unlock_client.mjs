import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function unlock() {
    console.log("Desbloqueando clientes...");
    const { data, error } = await supabase.from('user_souls').update({ is_processing: false, worker_status: '○ Cerebro en reposo' }).eq('is_processing', true);
    if (error) {
        console.error("Error al desbloquear:", error.message);
    } else {
        console.log("✅ Clientes desbloqueados con éxito.");
    }
}
unlock();
