import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function testInsert() {
    const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';
    const remoteId = 'test@s.whatsapp.net';

    const personaJson = {
        affinity_score: 50,
        formality_index: 50,
        lexical_diversity: "alta",
        power_dynamic: "simetrica",
        emotional_valence: 0.5,
        recurrent_patterns: [],
        relationship_classification: "amistad",
        technical_summary: "Test"
    };

    const { data, error } = await supabase.from("contact_personas").upsert({
        client_id: clientId,
        remote_id: remoteId,
        display_name: 'Test Contact',
        persona_json: personaJson,
        updated_at: new Date().toISOString()
    }, { onConflict: "client_id, remote_id" }).select();

    if (error) {
        console.error("Insert error:", error);
    } else {
        console.log("Insert success:", data);
    }
    process.exit(0);
}

testInsert();
