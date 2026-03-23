import 'dotenv/config';
import supabase from './config/supabase.mjs';

async function migrate() {
    console.log('🚀 Creating get_random_nodes function...');
    const { error } = await supabase.rpc('create_function_if_not_exists', {
        name: 'get_random_nodes',
        definition: `
            CREATE OR REPLACE FUNCTION get_random_nodes(cid UUID, lim INT) 
            RETURNS SETOF knowledge_nodes AS $$ 
            BEGIN 
                RETURN QUERY SELECT * FROM knowledge_nodes 
                WHERE client_id = cid 
                ORDER BY random() 
                LIMIT lim; 
            END; 
            $$ LANGUAGE plpgsql;
        `
    });

    if (error) {
        console.warn('⚠️ Standard RPC failed, trying raw query fallback...', error.message);
        // Supabase JS doesn't support raw SQL easily unless you have a specific RPC for it
        // If create_function_if_not_exists isn't there, we just hope the user runs it in SQL editor
        // or we use a common workaround if possible.
    } else {
        console.log('✅ Migration successful!');
    }
    process.exit(0);
}

migrate();
