import supabase from '../../config/supabase.mjs';

async function clearSessions() {
    console.log("Deleting all corrupted whatsapp sessions...");
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .delete()
        .neq('client_id', '00000000-0000-0000-0000-000000000000'); // Delete all

    console.log("Delete error:", error);
    console.log("Deleted data:", data);
}

clearSessions();
