import 'dotenv/config';
import supabase from '../config/supabase.mjs';
import { seedEvalCasesForClient } from './build_rag_eval_cases.mjs';
import { runEvalForClient } from './eval_evidence_rag.mjs';

function getArg(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(arg => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
}

async function discoverEligibleClients({ minRawMessages = 500, limit = 10 } = {}) {
    const { data: souls, error } = await supabase
        .from('user_souls')
        .select('client_id, slug, created_at')
        .order('created_at', { ascending: false })
        .limit(Math.max(limit * 3, 20));

    if (error) throw error;
    const clientIds = (souls || []).map(row => row.client_id).filter(Boolean);
    const eligible = [];

    for (const clientId of clientIds) {
        const { count: rawCount, error: rawError } = await supabase
            .from('raw_messages')
            .select('*', { head: true, count: 'exact' })
            .eq('client_id', clientId);
        if (rawError) throw rawError;
        if (Number(rawCount || 0) < minRawMessages) continue;
        eligible.push(clientId);
        if (eligible.length >= limit) break;
    }

    return eligible;
}

function avg(items, key) {
    if (!items.length) return 0;
    return items.reduce((sum, item) => sum + Number(item[key] || 0), 0) / items.length;
}

async function main() {
    const clientsArg = getArg('clients', '');
    const limit = Number(getArg('limit', '200'));
    const seedCount = Number(getArg('count', '200'));
    const maxClients = Number(getArg('max-clients', '5'));
    const minRawMessages = Number(getArg('min-raw', '500'));
    const shouldReset = process.argv.includes('--reset');
    const shouldRehydrate = process.argv.includes('--rehydrate');

    const clientIds = clientsArg
        ? clientsArg.split(',').map(value => value.trim()).filter(Boolean)
        : await discoverEligibleClients({ minRawMessages, limit: maxClients });

    if (!clientIds.length) {
        throw new Error('No eligible clients found for multi-client eval.');
    }

    const perClient = [];

    for (const clientId of clientIds) {
        console.log(`\n[Multi Eval] Seeding ${clientId}...`);
        const seed = await seedEvalCasesForClient({
            clientId,
            targetCount: seedCount,
            shouldReset,
            shouldRehydrate
        });

        console.log(`\n[Multi Eval] Evaluating ${clientId}...`);
        const evalSummary = await runEvalForClient({
            clientId,
            runName: `multi-client-${new Date().toISOString()}`,
            limit
        });

        perClient.push({
            client_id: clientId,
            seeded_cases: seed.total,
            passed_cases: evalSummary.passed_cases,
            total_cases: evalSummary.total_cases,
            precision_at_k: evalSummary.precision_at_k,
            citation_coverage: evalSummary.citation_coverage,
            abstention_precision: evalSummary.abstention_precision,
            entity_resolution_accuracy: evalSummary.entity_resolution_accuracy,
            temporal_accuracy: evalSummary.temporal_accuracy,
            hallucination_rate: evalSummary.hallucination_rate,
            p50_latency_ms: evalSummary.p50_latency_ms,
            p95_latency_ms: evalSummary.p95_latency_ms
        });
    }

    const campaignSummary = {
        clients_evaluated: perClient.length,
        total_cases: perClient.reduce((sum, item) => sum + item.total_cases, 0),
        total_passed: perClient.reduce((sum, item) => sum + item.passed_cases, 0),
        pass_rate: perClient.length ? perClient.reduce((sum, item) => sum + (item.total_cases ? item.passed_cases / item.total_cases : 0), 0) / perClient.length : 0,
        precision_at_k: avg(perClient, 'precision_at_k'),
        citation_coverage: avg(perClient, 'citation_coverage'),
        abstention_precision: avg(perClient, 'abstention_precision'),
        entity_resolution_accuracy: avg(perClient, 'entity_resolution_accuracy'),
        temporal_accuracy: avg(perClient, 'temporal_accuracy'),
        hallucination_rate: avg(perClient, 'hallucination_rate'),
        p50_latency_ms: Math.round(percentile(perClient.map(item => item.p50_latency_ms), 50)),
        p95_latency_ms: Math.round(percentile(perClient.map(item => item.p95_latency_ms), 95)),
        per_client: perClient
    };

    console.log('\n[Multi Eval] Campaign summary');
    console.log(JSON.stringify(campaignSummary, null, 2));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
    main().catch(error => {
        console.error('[Multi Eval] Failed:', error.message);
        process.exitCode = 1;
    }).then(() => {
        if (!process.exitCode) process.exit(0);
    });
}
