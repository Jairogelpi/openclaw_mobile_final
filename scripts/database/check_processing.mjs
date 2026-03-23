import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    const { count: total } = await supabase.from('raw_messages').select('*', { count: 'exact', head: true });
    const { count: processed } = await supabase.from('raw_messages').select('*', { count: 'exact', head: true }).eq('processed', true);
    console.log(`Mensajes totales: ${total}, procesados: ${processed}, pendientes: ${total - processed}`);
}
check();
