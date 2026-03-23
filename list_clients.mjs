import supabase from './config/supabase.mjs';

async function listClients() {
    console.log(`\n--- Listing all clients ---`);
    const { data, error } = await supabase
        .from('clients')
        .select('*');

    if (error) {
        console.error('Error:', error.message);
        return;
    }

    data.forEach(c => {
        console.log(`- Slug: ${c.slug}, ID: ${c.id}, Phone: ${c.phone_number}`);
    });
}

(async () => {
    await listClients();
})();
