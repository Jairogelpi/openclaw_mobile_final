import 'dotenv/config';
import { generateEmbedding } from '../services/local_ai.mjs';
import { runEvidenceFirstRag } from '../services/evidence_rag.service.mjs';

function getArg(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(arg => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

async function main() {
    const clientId = getArg('client') || process.env.CLIENT_ID;
    const queryB64 = getArg('query-b64') || process.env.QUERY_B64;
    const query = queryB64
        ? Buffer.from(queryB64, 'base64').toString('utf8')
        : (getArg('query') || process.env.QUERY);
    if (!clientId || !query) {
        throw new Error('Use --client=<uuid> --query="texto"');
    }

    const queryVector = await generateEmbedding(query, true);
    const result = await runEvidenceFirstRag({
        clientId,
        queryText: query,
        queryVector
    });

    console.log(JSON.stringify({
        query,
        reply: result.reply,
        verdict: result.verdict,
        plan: result.plan,
        evidenceNeeds: result.evidenceNeeds,
        evidenceBundle: result.evidenceBundle,
        supportedClaims: result.verification?.supportedClaims || [],
        topCandidates: (result.candidates || []).slice(0, 6).map(candidate => ({
            label: candidate.citation_label,
            kind: candidate.source_kind,
            factType: candidate.metadata?.fact_type || null,
            score: candidate.final_score,
            text: String(candidate.evidence_text || '').slice(0, 180)
        }))
    }, null, 2));
    process.exit(0);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
    main().catch(error => {
        console.error('[Probe Bundle] Failed:', error.message);
        process.exitCode = 1;
    });
}
