import 'dotenv/config';
import { createClient as createRedisClient } from 'redis';
import { createClient } from '@supabase/supabase-js';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);
import { encrypt, decrypt } from './security.mjs';


// === CONFIG ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENROUTER_API_KEY) {
    console.error('❌ Error: Faltan variables de entorno (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY).');
    process.exit(1);
}

if (!OPENAI_API_KEY) {
    console.warn('⚠️ OPENAI_API_KEY no encontrada. La vectorización de memoria estará desactivada.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// === EMBEDDING ===
async function generateEmbedding(text) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: "text-embedding-3-small",
            input: text
        })
    });
    const result = await response.json();
    return result.data[0].embedding;
}

// === DISTILL + VECTORIZE ===
async function distillAndVectorize(clientId) {
    console.log(`\n🧠 [Event-Memory] Procesando memoria para: ${clientId}`);

    try {
        // 1. Obtener mensajes sin procesar
        const { data: messages } = await supabase
            .from('raw_messages')
            .select('id, sender_role, content')
            .eq('client_id', clientId);

        if (!messages?.length) {
            console.log(`🏝️ Sin mensajes pendientes para ${clientId}.`);
            return;
        }

        const rawContent = messages.map(m => `${m.sender_role}: ${m.content}`).join('\n');

        // 2. Leer MEMORY.md físico actual para mantener continuidad
        const clientDir = `./clients/${clientId}`;
        const memoryPath = path.join(clientDir, 'MEMORY.md');
        let currentMemory = "";
        try {
            const rawMemory = await fs.readFile(memoryPath, 'utf8');
            currentMemory = decrypt(rawMemory);
        } catch (e) { /* Archivo nuevo */ }

        // 3. Destilación con DeepSeek (Reglas Estrictas)
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'deepseek/deepseek-chat',
                messages: [
                    {
                        role: 'system',
                        content: `Eres el motor de memoria de OpenClaw. Actualiza el perfil (MEMORY) del usuario.
                        
REGLAS ESTRICTAS:
1. Escribe SOLO en viñetas (bullet points) Markdown.
2. MÁXIMO 100 LÍNEAS. Si te pasas, consolida o elimina lo más antiguo/irrelevante.
3. HECHOS DENSOS: "El usuario programa en React", "Su perro Toby está enfermo".

MEMORIA ACTUAL:
${currentMemory}`
                    },
                    { role: 'user', content: `NUEVOS MENSAJES A INTEGRAR:\n${rawContent}` }
                ]
            })
        });

        const result = await response.json();
        const updatedMemory = result.choices?.[0]?.message?.content;

        if (updatedMemory) {
            // 4. PERSISTENCIA FÍSICA: Sobreescribir el archivo del cliente
            await fs.mkdir(clientDir, { recursive: true });
            await fs.writeFile(memoryPath, encrypt(updatedMemory), 'utf8');
        }

        // 5. VECTORIZACIÓN: Convertir cada mensaje en un recuerdo eterno
        if (OPENAI_API_KEY) {
            console.log(`📦 Vectorizando ${messages.length} mensajes para la eternidad...`);
            for (const msg of messages) {
                try {
                    const embedding = await generateEmbedding(msg.content);
                    await supabase.from('user_memories').insert({
                        client_id: clientId,
                        content: msg.content,
                        sender: msg.sender_role,
                        embedding: embedding,
                        metadata: {
                            date: new Date().toISOString(),
                            original_id: msg.id
                        }
                    });
                } catch (e) {
                    console.error(`❌ Error vectorizando mensaje ${msg.id}:`, e.message);
                }
            }
        }

        // 6. AMNESIA: Borrar mensajes procesados de Supabase
        await supabase.from('raw_messages').delete().in('id', messages.map(m => m.id));
        console.log(`✅ Memoria vectorizada y limpia para ${clientId}.`);
    } catch (err) {
        console.error(`❌ Error procesando cliente ${clientId}:`, err.message);
    }
}

// === SCALE-TO-ZERO REAPER ===
async function reapInactiveContainers() {
    console.log('💤 [Scale-to-Zero] Buscando contenedores inactivos...');

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const { data: inactiveClients } = await supabase
        .from('user_souls')
        .select('slug')
        .lt('last_active', twoHoursAgo);

    if (!inactiveClients) return;

    for (const client of inactiveClients) {
        if (!client.slug) continue;
        const containerName = `openclaw_${client.slug.replace(/-/g, '_')}`;
        try {
            await fs.access(`./clients/${client.slug}`);
            await execPromise(`docker stop ${containerName}`);
            console.log(`[Scale-to-Zero] 😴 Contenedor suspendido por inactividad: ${containerName}`);
        } catch (e) {
            // Silencioso si el contenedor no existe o ya está parado
        }
    }
}

// === MAIN: REDIS EVENT LISTENER ===
async function main() {
    console.log('🚀 Worker de Memoria en Tiempo Real ONLINE');

    // 1. Suscribirse a eventos de expiración de llaves Redis
    const redisListener = createRedisClient();
    await redisListener.connect();

    // Redis requires a dedicated connection for subscriptions
    const redisSub = redisListener.duplicate();
    await redisSub.connect();

    await redisSub.subscribe('__keyevent@0__:expired', async (key) => {
        if (key.startsWith('idle:')) {
            const clientId = key.split('idle:')[1];
            console.log(`⚡ [RAG-Event] Inactividad detectada para: ${clientId}. Procesando ahora...`);
            await distillAndVectorize(clientId);
        }
    });

    console.log('👂 Escuchando eventos de expiración de Redis...');

    // 2. Scale-to-Zero Reaper: cada 2 horas
    reapInactiveContainers(); // Ejecutar al inicio
    setInterval(reapInactiveContainers, 2 * 60 * 60 * 1000);

    // 3. Fallback: cada 30 min, procesar clientes que puedan haberse escapado
    setInterval(async () => {
        console.log('🔄 [Fallback] Barrido de seguridad...');
        const { data: clients } = await supabase
            .from('raw_messages')
            .select('client_id')
            .is('processed', false);

        const uniqueClients = [...new Set(clients?.map(c => c.client_id))];
        for (const clientId of uniqueClients) {
            await distillAndVectorize(clientId);
        }
    }, 30 * 60 * 1000);
}

main().catch(err => {
    console.error('💀 [Worker] Error fatal:', err.message);
    process.exit(1);
});
