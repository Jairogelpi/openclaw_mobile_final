import supabase from '../../config/supabase.mjs';

async function checkSchema() {
    const { data: client } = await supabase.from('user_souls').select('*').limit(1).single();
    if (client) {
        console.log('Columns in user_souls:', Object.keys(client));
    } else {
        console.log('No data in user_souls');
    }
}

checkSchema();
