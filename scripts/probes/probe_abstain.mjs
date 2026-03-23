import { generateEmbedding } from '../../services/local_ai.mjs';
import { runEvidenceFirstRag } from '../../services/evidence_rag.service.mjs';
const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';
const queryText = 'quien es PersonaFantasma22';
const started = Date.now();
const queryVector = await generateEmbedding(queryText, true);
const result = await runEvidenceFirstRag({ clientId, queryText, queryVector });
console.log(JSON.stringify({ queryText, latency_ms: Date.now()-started, verdict: result.verdict, citationCoverage: result.citationCoverage, reply: result.reply }, null, 2));
