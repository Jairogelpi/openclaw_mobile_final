import 'dotenv/config';
import supabase from './config/supabase.mjs';

async function run() {
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('data_type, data_id')
        .limit(50);

    console.log(error || data);
}

run();
