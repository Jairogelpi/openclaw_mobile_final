import { runBrainCycle } from './brain_worker.mjs';
import supabase from '../config/supabase.mjs';

async function testRecall() {
    const { data: user } = await supabase.from('user_souls').select('*').limit(1).single();
    if (!user) return console.log('No user found');

    console.log(`Testing with client: ${user.client_id}`);

    // Simulate incoming Neural Chat message
    await supabase.from('raw_messages').insert({
        client_id: user.client_id,
        remote_id: 'neural-terminal',
        sender_role: 'Usuario',
        content: '[TEST] Necesito que extraigas el contenido de la [Imagen: 3A48C8F7E8D82A2B3D] del chat con remoteJid "34660386701@s.whatsapp.net" usando tu herramienta recall_media. Descríbemela al máximo detalle.',
        processed: false
    });

    console.log('Test message inserted. Brain worker will pick it up or we can invoke it manually.');
}

testRecall();
