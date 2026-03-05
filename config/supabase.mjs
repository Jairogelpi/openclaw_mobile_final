import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

let supabase;
try {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    console.log('[Supabase Init] URL:', supabaseUrl);
    console.log('[Supabase Init] Key starts with:', supabaseKey ? supabaseKey.substring(0, 15) : 'MISSING');

    if (!supabaseUrl.startsWith('http')) throw new Error('Invalid Supabase URL');
    supabase = createClient(supabaseUrl, supabaseKey);
} catch (err) {
    console.warn('[Bridge] Warning: Supabase client could not be initialized (check your .env).');
    supabase = { auth: { getUser: () => ({ data: { user: null }, error: new Error('Supabase not configured') }) } };
}

export default supabase;
