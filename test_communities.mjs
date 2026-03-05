import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { detectAndSaveCommunities } from './services/community.service.mjs';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function testCommunities() {
    console.log("Testeando detección de comunidades manual...");
    const { data: clients, error } = await supabase.from('user_souls').select('client_id').limit(1);
    if (error || !clients || clients.length === 0) {
        console.error("No se encontraron clientes.");
        process.exit(1);
    }
    const clientId = clients[0].client_id;
    console.log(`Corriendo para cliente: ${clientId}`);

    await detectAndSaveCommunities(clientId);
    console.log("Completado test.");
    process.exit(0);
}

testCommunities();
