import 'dotenv/config';
import supabase from './config/supabase.mjs';

async function findClient() {
    const { data, error } = await supabase.from('user_souls').select('client_id, soul_json').limit(1);
    if (error) {
        console.error("Error:", error);
        return;
    }
    console.log("Found client:", JSON.stringify(data[0], null, 2));
}

findClient();
