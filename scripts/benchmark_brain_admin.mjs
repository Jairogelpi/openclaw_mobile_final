import 'dotenv/config';

function getArg(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(arg => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function parseCsvArg(value) {
    if (!value) return [];
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
}

function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
    return percentile(values, 50);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function truncate(value, max = 140) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function groupRunsByQuery(runs) {
    return runs.reduce((acc, item) => {
        if (!acc[item.query]) acc[item.query] = [];
        acc[item.query].push(item);
        return acc;
    }, {});
}

const DEFAULT_SUITES = {
    identity: [
        'quien es Mireya',
        'que sabes de Jairo Gelpi',
        'quien es PersonaFantasma22'
    ],
    temporal: [
        'que paso con Mireya el jueves',
        'que paso ayer con Mireya'
    ],
    media: [
        'recuerdas el audio de Mireya',
        'recuerdas la foto de Mireya'
    ],
    relationship: [
        'que relacion hay entre Jairo y Mireya',
        'que relacion hay entre Mireya y Jairo'
    ],
    mixed: [
        'quien es Mireya',
        'que paso con Mireya el jueves',
        'recuerdas el audio de Mireya',
        'que relacion hay entre Jairo y Mireya',
        'quien es PersonaFantasma22'
    ]
};

function buildQueries() {
    const rawQueries = parseCsvArg(getArg('query'));
    if (rawQueries.length) return rawQueries;

    const suiteNames = parseCsvArg(getArg('suite', 'mixed'));
    const collected = [];
    for (const suiteName of suiteNames) {
        const suite = DEFAULT_SUITES[suiteName];
        if (!suite) {
            throw new Error(`Unknown suite "${suiteName}". Available: ${Object.keys(DEFAULT_SUITES).join(', ')}`);
        }
        collected.push(...suite);
    }
    return collected;
}

async function postJson(url, body, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const responseText = await response.text();
        let data = {};
        try {
            data = responseText ? JSON.parse(responseText) : {};
        } catch {
            data = { raw: responseText };
        }
        return {
            ok: response.ok,
            status: response.status,
            data,
            latencyMs: Date.now() - startedAt
        };
    } finally {
        clearTimeout(timeout);
    }
}

function summarizeRun(run) {
    return {
        query: run.query,
        http_ms: run.httpMs,
        trace_ms: run.traceMs,
        success: run.success,
        verdict: run.verdict,
        citations: run.citationCount,
        confidence: run.confidenceLevel,
        reply_preview: truncate(run.reply, 120)
    };
}

async function main() {
    const clientId = getArg('client') || process.env.CLIENT_ID;
    const token = getArg('token') || process.env.ADMIN_TOKEN;
    const host = getArg('host', process.env.OPENCLAW_BRAIN_ADMIN_HOST || '127.0.0.1');
    const port = Number(getArg('port', process.env.OPENCLAW_BRAIN_ADMIN_PORT || '3001'));
    const remoteId = getArg('remote-id', 'terminal-admin');
    const runs = Math.max(1, Number(getArg('runs', '3')));
    const warmupRuns = Math.max(0, Number(getArg('warmup', '1')));
    const timeoutMs = Math.max(1000, Number(getArg('timeout-ms', '35000')));
    const pauseMs = Math.max(0, Number(getArg('pause-ms', '150')));
    const queries = buildQueries();

    if (!clientId) throw new Error('Missing client id. Use --client=<uuid> or CLIENT_ID env.');
    if (!token) throw new Error('Missing admin token. Use --token=<token> or ADMIN_TOKEN env.');
    if (!queries.length) throw new Error('No queries selected.');

    const url = `http://${host}:${port}/admin/api/neural_chat?token=${encodeURIComponent(token)}`;
    const allRuns = [];

    for (const query of queries) {
        for (let index = 0; index < warmupRuns + runs; index += 1) {
            const label = index < warmupRuns ? 'warmup' : `run-${index - warmupRuns + 1}`;
            const result = await postJson(url, {
                clientId,
                text: query,
                remoteId
            }, timeoutMs);

            const trace = result.data?.trace || null;
            const citations = Array.isArray(trace?.metadata?.supported_claims)
                ? trace.metadata.supported_claims.flatMap(claim => claim?.citations || [])
                : [];
            const run = {
                query,
                label,
                success: Boolean(result.ok && typeof result.data?.reply === 'string'),
                httpMs: Number(result.latencyMs || 0),
                traceMs: Number(trace?.total_latency_ms || 0),
                verdict: trace?.metadata?.answer_verdict || null,
                confidenceLevel: trace?.confidence_level || null,
                citationCount: new Set(citations.filter(Boolean)).size,
                reply: result.data?.reply || result.data?.error || JSON.stringify(result.data || {}),
                rawStatus: result.status
            };

            if (index >= warmupRuns) {
                allRuns.push(run);
                console.log(JSON.stringify(summarizeRun(run)));
            }

            if (pauseMs > 0 && (index + 1) < (warmupRuns + runs)) {
                await sleep(pauseMs);
            }
        }
    }

    const httpLatencies = allRuns.map(item => item.httpMs);
    const traceLatencies = allRuns.map(item => item.traceMs).filter(Boolean);
    const grouped = groupRunsByQuery(allRuns);
    const perQuery = Object.fromEntries(
        Object.entries(grouped).map(([query, items]) => {
            const httpValues = items.map(item => item.httpMs);
            const traceValues = items.map(item => item.traceMs).filter(Boolean);
            return [query, {
                runs: items.length,
                success_rate: Number((items.filter(item => item.success).length / items.length).toFixed(4)),
                http_p50_ms: Math.round(median(httpValues)),
                http_p95_ms: Math.round(percentile(httpValues, 95)),
                http_avg_ms: Math.round(average(httpValues)),
                trace_p50_ms: Math.round(median(traceValues)),
                trace_p95_ms: Math.round(percentile(traceValues, 95)),
                trace_avg_ms: Math.round(average(traceValues)),
                sample_reply: truncate(items[items.length - 1]?.reply, 180)
            }];
        })
    );

    const summary = {
        target: url,
        total_runs: allRuns.length,
        queries,
        warmup_runs_per_query: warmupRuns,
        measured_runs_per_query: runs,
        success_rate: Number((allRuns.filter(item => item.success).length / Math.max(1, allRuns.length)).toFixed(4)),
        http_p50_ms: Math.round(median(httpLatencies)),
        http_p95_ms: Math.round(percentile(httpLatencies, 95)),
        http_avg_ms: Math.round(average(httpLatencies)),
        trace_p50_ms: Math.round(median(traceLatencies)),
        trace_p95_ms: Math.round(percentile(traceLatencies, 95)),
        trace_avg_ms: Math.round(average(traceLatencies)),
        per_query: perQuery
    };

    console.log(JSON.stringify({ summary }, null, 2));
}

main().catch(error => {
    console.error(`[Brain Benchmark] Failed: ${error.message}`);
    process.exitCode = 1;
});
