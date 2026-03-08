import { parentPort } from 'worker_threads';
import { pipeline } from '@huggingface/transformers';

let localEmbedder = null;
let initPromise = null;

async function ensureEmbedder() {
    if (localEmbedder) return localEmbedder;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        console.log('[AI Worker Thread] Inicializando pipeline de Transformers.js (node-onnx)...');
        const embedder = await pipeline('feature-extraction', 'Xenova/all-mpnet-base-v2', {
            quantized: true,
            device: 'cpu'
        });
        console.log('[AI Worker Thread] ✅ Pipeline inicializado (node-onnx).');
        localEmbedder = embedder;
        return localEmbedder;
    })();

    try {
        return await initPromise;
    } finally {
        initPromise = null;
    }
}

async function unloadEmbedder() {
    if (localEmbedder && typeof localEmbedder.dispose === 'function') {
        try { localEmbedder.dispose(); } catch (error) { }
    }
    localEmbedder = null;
}

parentPort.on('message', async (message) => {
    try {
        if (message.action === 'unload') {
            await unloadEmbedder();
            parentPort.postMessage({ id: message.id, action: 'unloaded' });
            return;
        }

        if (message.action === 'embed') {
            const embedder = await ensureEmbedder();
            console.time(`[AI Worker Thread] Embed ${message.id}`);
            const output = await embedder(message.text, { pooling: 'mean', normalize: true });
            console.timeEnd(`[AI Worker Thread] Embed ${message.id}`);
            parentPort.postMessage({ id: message.id, vector: Array.from(output.data) });
        }
    } catch (error) {
        await unloadEmbedder();
        parentPort.postMessage({ id: message.id, error: error.message });
    }
});
