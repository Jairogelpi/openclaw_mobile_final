import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import redisClient from './config/redis.mjs';

async function testRecall() {
    console.log('Obteniendo cliente de prueba...');
    const supabase = (await import('./config/supabase.mjs')).default;
    const { data: user } = await supabase.from('user_souls').select('client_id, slug').limit(1).single();
    if (!user) return console.log('No user found');

    console.log(`Simulando mensaje de WhatsApp de prueba para: ${user.client_id}`);

    const incomingQueue = new Queue('incomingMessagesQueue', { connection: redisClient });

    await incomingQueue.add('process_message', {
        clientId: user.client_id,
        clientSlug: user.slug,
        senderId: '34660386701@s.whatsapp.net',
        text: 'Oye, recuerdas la [Imagen: 3A48C8F7E8D82A2B3D] del chat con remoteJid 34660386701@s.whatsapp.net? Usa tu skill recall_media para ver esa imagen y descríbemela. Es una prueba.',
        messageId: 'TEST_' + uuidv4(),
        pushName: 'Admin Tester',
        isGroup: false,
        participant: null
    });

    console.log('Mensaje encolado en incomingQueue. El openclaw-brain debería atraparlo y procesarlo en breve.');
    process.exit(0);
}

testRecall();
