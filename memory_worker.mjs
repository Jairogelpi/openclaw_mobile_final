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
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !GROQ_API_KEY) {
    console.error('❌ Error: Faltan variables de entorno (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY).');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
import Groq from 'groq-sdk';
const groq = new Groq({ apiKey: GROQ_API_KEY });

import { pipeline } from '@huggingface/transformers';

// === EMBEDDING ===
let localEmbedder = null;

async function generateEmbedding(text, isQuery = false) {
    if (!localEmbedder) {
        console.log('🧠 [RAG Local] Inicializando red neuronal (Nomic-Embed-Text)...');
        localEmbedder = await pipeline('feature-extraction', 'Xenova/nomic-embed-text-v1.5', {
            quantized: true
        });
    }
    const prefix = isQuery ? 'search_query: ' : 'search_document: ';
    const output = await localEmbedder(prefix + text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

// Guarda un Nodo en Supremo y retorna true si fue insertado/actualizado
async function upsertKnowledgeNode(clientId, entityName, entityType, description) {
    // Verificar si existe para no duplicar
    const { data: existing } = await supabase
        .from('knowledge_nodes')
        .select('id')
        .eq('client_id', clientId)
        .eq('entity_name', entityName)
        .single();

    if (existing) return; // Ya existe, podríamos actualizar description, pero para simplicidad lo dejamos así

    // Generar el vector del nodo
    const embedding = await generateEmbedding(entityName + " " + (description || ""));

    await supabase.from('knowledge_nodes').insert({
        client_id: clientId,
        entity_name: entityName,
        entity_type: entityType,
        description: description,
        embedding: embedding
    });
}

// === DISTILL + GRAPHRAG VECTORIZE ===
async function distillAndVectorize(clientId) {
    console.log(`\n🧠 [GraphRAG] Procesando memoria para: ${clientId}`);

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

        console.log(`🔍 [GraphRAG] Extrayendo Triplets Lógicos con Llama 3 8B...`);

        // 2. Extracción de Triplets con Groq (rápido y barato)
        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: `Eres un experto extractor de Grafos de Conocimiento. 
Analiza la conversación y extrae hechos en formato de Triplets Lógicos (Sujeto -> Relación -> Objeto).
Debes devolver UNICAMENTE un objeto JSON con una propiedad "triplets" que contenga un array de objetos.
Formato:
{
  "triplets": [
    {
      "source": "Nombre exacto de la entidad origen",
      "source_type": "PERSONA|LUGAR|OBJETO|DATO",
      "target": "Nombre exacto de la entidad destino",
      "target_type": "PERSONA|LUGAR|OBJETO|DATO",
      "relation": "TIENE_WIFI|ES_MASCOTA_DE|VIVE_EN|GUSTA_DE (VERBO EN MAYUSCULAS, 1-3 palabras separadas por _)",
      "context": "Breve explicación adicional o dejar vacío"
    }
  ]
}
Si la conversación son solo saludos o no contiene datos relevantes factuales, devuelve { "triplets": [] }.`
                },
                { role: 'user', content: `CONVERSACIÓN:\n${rawContent}` }
            ]
        });

        let triplets = [];
        try {
            const graphData = JSON.parse(response.choices[0].message.content);
            triplets = graphData.triplets || [];
            console.log(`🕸️ [GraphRAG] Extraídos ${triplets.length} triplets.`);
        } catch (parseError) {
            console.warn(`⚠️ [GraphRAG] LLM no devolvió JSON válido. Ignorando extracción en esta ronda.`);
            triplets = [];
        }

        // 3. Inserción en la Base de Datos Híbrida
        for (const t of triplets) {
            try {
                // Upsert Nodos
                await upsertKnowledgeNode(clientId, t.source, t.source_type, "Entidad extraída automáticamente.");
                await upsertKnowledgeNode(clientId, t.target, t.target_type, t.context || "Entidad extraída automáticamente.");

                // Insertar Arista (Relación)
                // Usamos UPSERT silencioso atrapando el error de UNIQUE si ya existe la misma relación
                await supabase.from('knowledge_edges').insert({
                    client_id: clientId,
                    source_node: t.source,
                    relation_type: t.relation,
                    target_node: t.target,
                    context: t.context
                }).catch(() => { }); // Si viola la clave única, simplemente lo ignora (ya sabemos ese hecho)

            } catch (e) {
                console.error(`❌ Error insertando Triplet [${t.source}]->[${t.target}]:`, e.message);
            }
        }

        // 4. (Opcional pero recomendado para backwards compatibility) Vectorizar mensajes crudos
        // Conservamos los mensajes también en la tabla clásica por si las moscas
        for (const msg of messages) {
            try {
                const embedding = await generateEmbedding(msg.content);
                await supabase.from('user_memories').insert({
                    client_id: clientId,
                    content: msg.content,
                    sender: msg.sender_role,
                    embedding: embedding,
                    metadata: { date: new Date().toISOString() }
                });
            } catch (e) {
                // Ignorar error individual
            }
        }

        // 5. AMNESIA: Borrar mensajes procesados de Supabase
        await supabase.from('raw_messages').delete().in('id', messages.map(m => m.id));
        console.log(`✅ [GraphRAG] Memoria estructurada, vectorizada y lista para ${clientId}.`);
    } catch (err) {
        console.error(`❌ Error general procesando cliente ${clientId}:`, err.message);
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

    // 2. Ya no hay Docker. Scale-To-Zero se maneja internamente.

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
