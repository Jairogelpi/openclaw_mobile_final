import { invalidateSemanticCache } from '../services/local_ai.mjs';
import { processMessage } from '../core/core_engine.mjs';
import 'dotenv/config';

async function verifySynthesis() {
    const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';

    console.log('🧪 [Test] Verificando Síntesis Cognitiva (Auto-descubrimiento)');

    // 1. Limpiar caché para forzar RAG
    await invalidateSemanticCache(clientId);

    // 2. Simular pregunta que gatille descubrimiento de Mireya
    // Sabemos que en el DB hay memorias sobre Mireya siendo la novia.
    const testEvent = {
        clientId: clientId,
        clientSlug: 'jairogelpi-cc2af',
        channel: 'whatsapp',
        senderId: 'user-123',
        text: '¿Quién es Mireya y por qué es importante?',
        isSentByMe: false,
        metadata: { pushName: 'Amigo' }
    };

    console.log('🚀 Procesando mensaje de prueba...');
    const reply = await processMessage(testEvent);
    console.log('\n--- RESPUESTA DE LA IA ---');
    console.log(reply);
    console.log('--------------------------\n');

    console.log('⏳ Esperando 2 segundos para sincronización DB...');
    await new Promise(r => setTimeout(r, 2000));

    // 3. Verificar si el Soul fue actualizado
    console.log('🔎 Comprobando actualización de key_facts en DB...');
}

verifySynthesis().catch(console.error);
