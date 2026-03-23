import { generateEmbedding } from '../../services/local_ai.mjs';
const queries = ['hola','quien es Mireya','que paso con Coletasport el jueves'];
for (const query of queries) {
  const started = Date.now();
  try {
    const v = await generateEmbedding(query, true);
    console.log(JSON.stringify({ query, ok: Array.isArray(v), dims: Array.isArray(v) ? v.length : null, latency_ms: Date.now() - started }));
  } catch (error) {
    console.log(JSON.stringify({ query, ok: false, error: error.message, latency_ms: Date.now() - started }));
  }
}
