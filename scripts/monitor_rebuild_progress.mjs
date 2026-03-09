import { exec as execCallback } from 'node:child_process';
import util from 'node:util';
import process from 'node:process';
import supabase from '../config/supabase.mjs';

const exec = util.promisify(execCallback);

const clientId = process.argv[2];
const intervalSeconds = Number.parseInt(process.argv[3] || '30', 10);
const iterations = Number.parseInt(process.argv[4] || '0', 10);
const rebuildPattern = process.argv[5] || 'rebuild_whatsapp_relations.mjs';
const rebuildLogPath = process.argv[6] || '/root/openclaw-server/rebuild_graph_audit.log';

if (!clientId) {
    console.error('Usage: node scripts/monitor_rebuild_progress.mjs <client_id> [interval_seconds=30] [iterations=0] [rebuild_pattern] [rebuild_log_path]');
    process.exit(1);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function countRows(table, queryBuilder) {
    let query = supabase.from(table).select('*', { head: true, count: 'exact' });
    query = queryBuilder ? queryBuilder(query) : query.eq('client_id', clientId);
    const { count, error } = await query;
    if (error) throw error;
    return toNumber(count);
}

async function readWorkerStatus() {
    const { data, error } = await supabase
        .from('user_souls')
        .select('is_processing, worker_status')
        .eq('client_id', clientId)
        .maybeSingle();

    if (error) throw error;
    return {
        is_processing: Boolean(data?.is_processing),
        worker_status: data?.worker_status || null
    };
}

async function readRebuildProcess() {
    try {
        const { stdout } = await exec(`pgrep -af "${rebuildPattern}"`);
        const lines = stdout
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        return {
            running: lines.length > 0,
            processes: lines
        };
    } catch (error) {
        return {
            running: false,
            processes: []
        };
    }
}

async function readTail(lines = 12) {
    try {
        const { stdout } = await exec(`tail -n ${Math.max(1, lines)} "${rebuildLogPath}"`);
        return stdout
            .split(/\r?\n/)
            .map(line => line.trimEnd())
            .filter(Boolean);
    } catch (error) {
        return [];
    }
}

async function collectSnapshot(previousSnapshot = null) {
    const [
        rawMessages,
        pendingRawMessages,
        userMemories,
        knowledgeNodes,
        knowledgeEdges,
        contactIdentities,
        knowledgeCommunities,
        nodeCommunities,
        workerStatus,
        rebuildProcess,
        logTail
    ] = await Promise.all([
        countRows('raw_messages', query => query.eq('client_id', clientId)),
        countRows('raw_messages', query => query.eq('client_id', clientId).eq('processed', false)),
        countRows('user_memories'),
        countRows('knowledge_nodes'),
        countRows('knowledge_edges'),
        countRows('contact_identities'),
        countRows('knowledge_communities'),
        (async () => {
            const { data, error } = await supabase
                .from('knowledge_communities')
                .select('id')
                .eq('client_id', clientId);
            if (error) throw error;
            const ids = (data || []).map(row => row.id).filter(Boolean);
            if (!ids.length) return 0;
            return countRows('node_communities', query => query.in('community_id', ids));
        })(),
        readWorkerStatus(),
        readRebuildProcess(),
        readTail()
    ]);

    const now = Date.now();
    const completedRawMessages = rawMessages - pendingRawMessages;
    const percentComplete = rawMessages ? Number(((completedRawMessages / rawMessages) * 100).toFixed(2)) : 0;
    const previousCompleted = previousSnapshot?.totals?.completed_raw_messages ?? null;
    const deltaProcessed = previousCompleted != null ? completedRawMessages - previousCompleted : 0;
    const deltaSeconds = previousSnapshot ? (now - previousSnapshot.timestamp_ms) / 1000 : 0;
    const throughputPerMinute = deltaSeconds > 0 ? Number(((deltaProcessed / deltaSeconds) * 60).toFixed(2)) : 0;

    return {
        timestamp: new Date(now).toISOString(),
        timestamp_ms: now,
        client_id: clientId,
        rebuild_running: rebuildProcess.running,
        rebuild_processes: rebuildProcess.processes,
        worker_status: workerStatus,
        totals: {
            raw_messages: rawMessages,
            completed_raw_messages: completedRawMessages,
            pending_raw_messages: pendingRawMessages,
            user_memories: userMemories,
            knowledge_nodes: knowledgeNodes,
            knowledge_edges: knowledgeEdges,
            contact_identities: contactIdentities,
            knowledge_communities: knowledgeCommunities,
            node_communities: nodeCommunities
        },
        progress: {
            percent_complete: percentComplete,
            throughput_raw_messages_per_minute: throughputPerMinute
        },
        log_tail: logTail
    };
}

async function main() {
    let previousSnapshot = null;
    let completedIterations = 0;

    while (true) {
        const snapshot = await collectSnapshot(previousSnapshot);
        console.log(JSON.stringify(snapshot, null, 2));
        previousSnapshot = snapshot;
        completedIterations += 1;

        if (iterations > 0 && completedIterations >= iterations) {
            break;
        }

        await sleep(Math.max(5, intervalSeconds) * 1000);
    }
}

main().catch(error => {
    console.error('[Monitor Rebuild] Error:', error.message);
    process.exit(1);
});
