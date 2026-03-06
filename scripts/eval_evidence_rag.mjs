import 'dotenv/config';
import supabase from '../config/supabase.mjs';
import { generateEmbedding } from '../services/local_ai.mjs';
import { runEvidenceFirstRag } from '../services/evidence_rag.service.mjs';
import { normalizeComparableText } from '../utils/message_guard.mjs';

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

function overlapRatio(expected = [], actual = []) {
    if (!expected.length) return 1;
    const actualSet = new Set(actual.map(value => normalizeComparableText(value)));
    const hits = expected.filter(value => actualSet.has(normalizeComparableText(value))).length;
    return hits / expected.length;
}

function computeTemporalAccuracy(expectedStart, expectedEnd, planWindow) {
    if (!expectedStart || !expectedEnd) return 1;
    if (!planWindow?.start || !planWindow?.end) return 0;
    const expectedStartMs = new Date(expectedStart).getTime();
    const expectedEndMs = new Date(expectedEnd).getTime();
    const actualStartMs = new Date(planWindow.start).getTime();
    const actualEndMs = new Date(planWindow.end).getTime();
    const overlaps = actualStartMs <= expectedEndMs && actualEndMs >= expectedStartMs;
    return overlaps ? 1 : 0;
}

function candidateEntityNames(result) {
    return [
        ...(result.plan?.entities || []),
        ...((result.candidates || []).flatMap(candidate => [
            candidate.speaker,
            candidate.metadata?.entity_name,
            candidate.metadata?.source_node,
            candidate.metadata?.target_node
        ]))
    ].filter(Boolean);
}

function candidateRemoteIds(result) {
    return (result.candidates || []).map(candidate => candidate.remote_id).filter(Boolean);
}

function containsExpectedSubstrings(text, substrings = []) {
    if (!substrings.length) return 1;
    const haystack = normalizeComparableText(text);
    const hits = substrings.filter(item => haystack.includes(normalizeComparableText(item))).length;
    return hits / substrings.length;
}

function evaluateCase(testCase, result, latencyMs) {
    const expectedMode = testCase.expected_mode || 'answer';
    const actualMode = result.verdict || 'abstain';
    const expectedEntities = testCase.expected_entities || [];
    const expectedRemoteIds = testCase.expected_remote_ids || [];
    const expectedSubstrings = testCase.expected_substrings || [];

    const entityAccuracy = overlapRatio(expectedEntities, candidateEntityNames(result));
    const remoteHit = overlapRatio(expectedRemoteIds, candidateRemoteIds(result));
    const precisionAtK = Math.max(entityAccuracy, remoteHit);
    const temporalAccuracy = computeTemporalAccuracy(
        testCase.expected_time_start,
        testCase.expected_time_end,
        result.plan?.temporal_window
    );
    const substringCoverage = containsExpectedSubstrings(
        `${result.reply}\n${(result.verification?.supportedClaims || []).map(claim => claim.text).join('\n')}`,
        expectedSubstrings
    );

    const abstentionPrecision = expectedMode === 'abstain'
        ? (actualMode === 'abstain' ? 1 : 0)
        : 1;

    const hallucinated =
        (expectedMode === 'abstain' && actualMode !== 'abstain') ||
        (expectedMode !== 'abstain' && actualMode === 'answer' && precisionAtK === 0 && substringCoverage === 0);

    const passed =
        (expectedMode === actualMode || (expectedMode === 'answer' && actualMode === 'conflict')) &&
        precisionAtK >= 0.5 &&
        temporalAccuracy >= 0.5 &&
        (expectedSubstrings.length === 0 || substringCoverage >= 0.34);

    return {
        category: testCase.category,
        query: testCase.query,
        expected_mode: expectedMode,
        actual_mode: actualMode,
        passed,
        precision_at_k: precisionAtK,
        entity_resolution_accuracy: entityAccuracy,
        temporal_accuracy: temporalAccuracy,
        citation_coverage: Number(result.citationCoverage || 0),
        abstention_precision: abstentionPrecision,
        hallucinated,
        latency_ms: latencyMs,
        substring_coverage: substringCoverage,
        top_citations: (result.verification?.supportedClaims || []).flatMap(claim => claim.citations || []).slice(0, 8),
        plan: result.plan,
        reply: result.reply
    };
}

async function main() {
    const clientId = getArg('client') || process.env.CLIENT_ID;
    const runName = getArg('run-name', `evidence-first-${new Date().toISOString()}`);
    const limit = Number(getArg('limit', '200'));

    if (!clientId) {
        throw new Error('Missing client id. Use --client=<uuid> or CLIENT_ID env.');
    }

    const { data: cases, error } = await supabase
        .from('rag_eval_cases')
        .select('*')
        .eq('client_id', clientId)
        .eq('active', true)
        .order('created_at', { ascending: true })
        .limit(limit);

    if (error) throw error;
    if (!cases?.length) {
        throw new Error('No active rag_eval_cases found for this client.');
    }

    const caseResults = [];

    for (const testCase of cases) {
        const startedAt = Date.now();
        const queryVector = await generateEmbedding(testCase.query, true);
        const result = await runEvidenceFirstRag({
            clientId,
            queryText: testCase.query,
            queryVector
        });
        const latencyMs = Date.now() - startedAt;
        caseResults.push(evaluateCase(testCase, result, latencyMs));
    }

    const totalCases = caseResults.length;
    const passedCases = caseResults.filter(item => item.passed).length;
    const avg = metric => totalCases
        ? caseResults.reduce((sum, item) => sum + Number(item[metric] || 0), 0) / totalCases
        : 0;

    const summary = {
        client_id: clientId,
        run_name: runName,
        total_cases: totalCases,
        passed_cases: passedCases,
        precision_at_k: avg('precision_at_k'),
        citation_coverage: avg('citation_coverage'),
        abstention_precision: avg('abstention_precision'),
        entity_resolution_accuracy: avg('entity_resolution_accuracy'),
        temporal_accuracy: avg('temporal_accuracy'),
        hallucination_rate: avg('hallucinated'),
        p50_latency_ms: Math.round(percentile(caseResults.map(item => item.latency_ms), 50)),
        p95_latency_ms: Math.round(percentile(caseResults.map(item => item.latency_ms), 95)),
        metadata: {
            categories: caseResults.reduce((acc, item) => {
                if (!acc[item.category]) {
                    acc[item.category] = { total: 0, passed: 0 };
                }
                acc[item.category].total += 1;
                acc[item.category].passed += item.passed ? 1 : 0;
                return acc;
            }, {}),
            sample_failures: caseResults.filter(item => !item.passed).slice(0, 25),
            sample_successes: caseResults.filter(item => item.passed).slice(0, 10)
        }
    };

    const { error: insertError } = await supabase
        .from('rag_eval_runs')
        .insert(summary);

    if (insertError) throw insertError;

    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
}

main().catch(error => {
    console.error('[RAG Eval] Failed:', error.message);
    process.exitCode = 1;
});
