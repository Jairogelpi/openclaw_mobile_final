import { parentPort } from 'worker_threads';
import { pipeline, env } from '@huggingface/transformers';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurar entorno para Node.js
env.allowLocalModels = false; 
env.cacheDir = path.join(__dirname, '../.cache/transformers');

let embedder = null;

async function getEmbedder() {
    if (embedder) return embedder;
    console.log('🧠 [AI Worker] Inicializando pipeline (all-mpnet-base-v2)...');
    
    // Forzamos backend si es necesario vía env var externa, pero aquí dejamos que transformers decida
    // Si onnxruntime-node falla, transformers suele intentar el fallback internamente si está bien configurado
    
    embedder = await pipeline('feature-extraction', 'Xenova/all-mpnet-base-v2', {
        quantized: true
    });
    console.log('🧠 [AI Worker] ✅ Pipeline listo.');
    return embedder;
}

parentPort.on('message', async (message) => {
    try {
        if (message.action === 'embed') {
            const pipe = await getEmbedder();
            const output = await pipe(message.text, { pooling: 'mean', normalize: true });
            parentPort.postMessage({ id: message.id, vector: Array.from(output.data) });
        }
        if (message.action === 'unload') {
            embedder = null;
            parentPort.postMessage({ id: message.id, action: 'unloaded' });
        }
    } catch (error) {
        console.error('❌ [AI Worker] Error:', error.message);
        parentPort.postMessage({ id: message.id, error: error.message });
    }
});
