import { parentPort } from 'worker_threads';
import { pipeline } from '@huggingface/transformers';

let localEmbedder = null;

parentPort.on('message', async (message) => {
    try {
        if (!localEmbedder && message.action !== 'unload') {
            console.log('[AI Worker Thread] Inicializando pipeline de Transformers.js...');
            localEmbedder = await pipeline('feature-extraction', 'Xenova/all-mpnet-base-v2', {
                quantized: true
            });
            console.log('[AI Worker Thread] ✅ Pipeline inicializado.');
        }

        if (message.action === 'unload') {
            if (localEmbedder && typeof localEmbedder.dispose === 'function') {
                try { localEmbedder.dispose(); } catch (e) { }
            }
            localEmbedder = null;
            parentPort.postMessage({ id: message.id, action: 'unloaded' });
            return;
        }

        if (message.action === 'embed') {
            console.time(`[AI Worker Thread] Embed ${message.id}`);
            const output = await localEmbedder(message.text, { pooling: 'mean', normalize: true });
            console.timeEnd(`[AI Worker Thread] Embed ${message.id}`);

            const used = process.memoryUsage().heapUsed / 1024 / 1024;
            // console.log(`[AI Worker Thread] Memory: ${Math.round(used * 100) / 100} MB`);

            parentPort.postMessage({ id: message.id, vector: Array.from(output.data) });
        }
    } catch (e) {
        parentPort.postMessage({ id: message.id, error: e.message });
    }
});
