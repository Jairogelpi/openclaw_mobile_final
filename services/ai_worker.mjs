import { parentPort } from 'worker_threads';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMBEDDER_BACKEND = String(process.env.OPENCLAW_EMBEDDER_BACKEND || 'auto').trim().toLowerCase();
const TRANSFORMERS_WEB_ENTRY = pathToFileURL(
    path.resolve(__dirname, '../node_modules/@huggingface/transformers/dist/transformers.web.js')
).href;
const ONNXRUNTIME_WEB_DIST = path.resolve(__dirname, '../node_modules/onnxruntime-web/dist') + path.sep;

let localEmbedder = null;
let initPromise = null;
let activeBackend = null;

async function loadNodeTransformers() {
    const mod = await import('@huggingface/transformers');
    return { mod, backend: 'node-onnx', device: 'cpu' };
}

async function loadWebTransformers() {
    const mod = await import(TRANSFORMERS_WEB_ENTRY);
    if (mod?.env?.backends?.onnx?.wasm) {
        mod.env.backends.onnx.wasm.wasmPaths = ONNXRUNTIME_WEB_DIST;
        mod.env.backends.onnx.wasm.proxy = false;
        if (typeof mod.env.backends.onnx.wasm.numThreads === 'number') {
            mod.env.backends.onnx.wasm.numThreads = 1;
        }
    }
    return { mod, backend: 'wasm', device: 'wasm' };
}

async function createEmbedder(preferredBackend = EMBEDDER_BACKEND) {
    const normalized = ['auto', 'node', 'wasm'].includes(preferredBackend) ? preferredBackend : 'auto';
    const attempts = normalized === 'auto'
        ? [loadNodeTransformers, loadWebTransformers]
        : normalized === 'node'
            ? [loadNodeTransformers]
            : [loadWebTransformers];

    let lastError = null;
    for (const loader of attempts) {
        try {
            const { mod, backend, device } = await loader();
            console.log(`[AI Worker Thread] Inicializando pipeline de Transformers.js (${backend})...`);
            const embedder = await mod.pipeline('feature-extraction', 'Xenova/all-mpnet-base-v2', {
                quantized: true,
                device
            });
            console.log(`[AI Worker Thread] ✅ Pipeline inicializado (${backend}).`);
            activeBackend = backend;
            return embedder;
        } catch (error) {
            lastError = error;
            console.warn(`[AI Worker Thread] Fallback de backend fallido (${loader === loadNodeTransformers ? 'node-onnx' : 'wasm'}): ${error.message}`);
        }
    }

    throw lastError || new Error('No embedding backend could be initialized');
}

async function ensureEmbedder() {
    if (localEmbedder) return localEmbedder;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const embedder = await createEmbedder();
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
        try { localEmbedder.dispose(); } catch {}
    }
    localEmbedder = null;
    activeBackend = null;
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
            parentPort.postMessage({ id: message.id, vector: Array.from(output.data), backend: activeBackend });
        }
    } catch (error) {
        await unloadEmbedder();
        parentPort.postMessage({ id: message.id, error: error.message });
    }
});
