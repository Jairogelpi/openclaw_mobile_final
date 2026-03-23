import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    const { data: souls, error: soulsErr } = await supabase.from('user_souls').select('*');
    console.log("user_souls ROWS:", souls?.length, soulsErr || "");
    
    // Auth admin API allows fetching all users using the service_role key
    const { data: authUsers, error: authErr } = await supabase.auth.admin.listUsers();
    console.log("auth.users ROWS:", authUsers?.users?.length, authErr || "");
}
check();
