import supabase from '../config/supabase.mjs';

async function verifyTables() {
    // 1. Check if the user exists
    const { data: user, error: userError } = await supabase
        .from('user_souls')
        .select('client_id, slug')
        .limit(5);

    console.log("Users:", user);

    // 2. See what happens when inserting a real user
    if (user && user.length > 0) {
        const realClientId = user[0].client_id;
        console.log(`Trying insert for real user ${realClientId}...`);
        
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({
                client_id: realClientId,
                data_type: 'test',
                data_id: 'test',
                data_json: {}
            });
        
        console.log("Insert result error:", error);
    }
}

verifyTables();
