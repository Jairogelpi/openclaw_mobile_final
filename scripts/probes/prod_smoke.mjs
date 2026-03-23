import 'dotenv/config';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { buildRawMessageRecord } from '../../services/raw_message_ingest.service.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const GATEWAY_BASE_URL = process.env.OPENCLAW_GATEWAY_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const BRAIN_BASE_URL = process.env.OPENCLAW_BRAIN_BASE_URL || `http://127.0.0.1:${process.env.OPENCLAW_BRAIN_ADMIN_PORT || 3001}`;
const REQUEST_TIMEOUT_MS = Number(process.env.OPENCLAW_SMOKE_TIMEOUT_MS || 25_000);
const SMOKE_TEXT = process.env.OPENCLAW_SMOKE_TEXT || 'Confirma el smoke test con una frase breve.';
const REQUEST_RETRY_COUNT = Number(process.env.OPENCLAW_SMOKE_RETRIES || 6);
const REQUEST_RETRY_DELAY_MS = Number(process.env.OPENCLAW_SMOKE_RETRY_DELAY_MS || 1500);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ADMIN_TOKEN) {
    console.error('Faltan SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o ADMIN_TOKEN en el entorno.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function preview(value, max = 120) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchWithRetry(name, url, init = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= REQUEST_RETRY_COUNT; attempt += 1) {
        try {
            return await fetchWithTimeout(url, init);
        } catch (error) {
            lastError = error;
            if (attempt >= REQUEST_RETRY_COUNT) break;
            console.warn(`[Smoke] Retry ${attempt}/${REQUEST_RETRY_COUNT - 1} para ${name}: ${error.message}`);
            await sleep(REQUEST_RETRY_DELAY_MS);
        }
    }

    throw lastError || new Error(`Fetch fallido para ${name}`);
}

async function readJsonResponse(name, url, init = {}) {
    const response = await fetchWithRetry(name, url, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`${name} devolvio ${response.status}: ${payload?.error || JSON.stringify(payload)}`);
    }
    return payload;
}

async function readTextResponse(name, url, init = {}) {
    const response = await fetchWithRetry(name, url, init);
    const payload = await response.text();
    if (!response.ok) {
        throw new Error(`${name} devolvio ${response.status}: ${preview(payload)}`);
    }
    return payload;
}

async function resolveSmokeClient() {
    const explicitClientId = String(process.env.OPENCLAW_SMOKE_CLIENT_ID || '').trim();
    if (explicitClientId) {
        const { data, error } = await supabase
            .from('user_souls')
            .select('client_id, slug')
            .eq('client_id', explicitClientId)
            .limit(1);

        if (error) throw error;
        const row = data?.[0];
        return {
            clientId: explicitClientId,
            clientSlug: row?.slug || 'unknown'
        };
    }

    const { data, error } = await supabase
        .from('user_souls')
        .select('client_id, slug, last_active')
        .not('client_id', 'is', null)
        .order('last_active', { ascending: false, nullsFirst: false })
        .limit(1);

    if (error) throw error;
    if (!data?.[0]?.client_id) {
        throw new Error('No hay clientes disponibles para smoke test en user_souls.');
    }

    return {
        clientId: data[0].client_id,
        clientSlug: data[0].slug || 'unknown'
    };
}

async function smokeRawMessagesInsert(clientId) {
    const record = buildRawMessageRecord({
        clientId,
        senderRole: 'smoke_test',
        content: 'Smoke test raw_messages persistence',
        semanticText: 'Smoke test raw_messages persistence',
        remoteId: `smoke-admin:${Date.now()}`,
        processed: true,
        channel: 'smoke',
        deliveryStatus: 'delivered',
        excludeFromMemory: true,
        assistantEcho: true,
        generatedBy: 'scripts/probes/prod_smoke.mjs',
        metadata: {
            smoke_test: true,
            created_by: 'prod_smoke'
        }
    });

    const { data, error } = await supabase
        .from('raw_messages')
        .insert([record])
        .select('id, client_id, created_at')
        .limit(1);

    if (error) throw error;
    const inserted = data?.[0];
    if (!inserted?.id) {
        throw new Error('raw_messages insert no devolvio id.');
    }

    const { error: deleteError } = await supabase
        .from('raw_messages')
        .delete()
        .eq('id', inserted.id);

    if (deleteError) throw deleteError;
    return inserted;
}

function reportSuccess(name, details = '') {
    console.log(`PASS ${name}${details ? ` | ${details}` : ''}`);
}

async function main() {
    const smokeClient = await resolveSmokeClient();
    const remoteId = process.env.OPENCLAW_SMOKE_REMOTE_ID || `terminal-smoke:${smokeClient.clientId}`;

    const health = await readJsonResponse('gateway /health', `${GATEWAY_BASE_URL}/health`);
    reportSuccess('gateway /health', preview(JSON.stringify(health), 160));

    const brainHealth = await readJsonResponse('brain /healthz', `${BRAIN_BASE_URL}/healthz`);
    if (brainHealth?.ok !== true) {
        throw new Error('brain /healthz no devolvio ok=true');
    }
    reportSuccess('brain /healthz', `rss=${brainHealth?.memory?.rss_mb ?? 'n/a'}MB`);

    const stats = await readJsonResponse('admin /api/stats', `${GATEWAY_BASE_URL}/admin/api/stats?token=${encodeURIComponent(ADMIN_TOKEN)}`);
    reportSuccess('admin /api/stats', `keys=${Object.keys(stats || {}).length}`);

    const dashboardHtml = await readTextResponse('admin /health', `${GATEWAY_BASE_URL}/admin/health?token=${encodeURIComponent(ADMIN_TOKEN)}`);
    if (!dashboardHtml.includes('OpenClaw')) {
        throw new Error('admin /health no contiene la marca esperada.');
    }
    reportSuccess('admin /health', 'html ok');

    const neural = await readJsonResponse(
        'admin /api/neural_chat',
        `${GATEWAY_BASE_URL}/admin/api/neural_chat?token=${encodeURIComponent(ADMIN_TOKEN)}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientId: smokeClient.clientId,
                text: SMOKE_TEXT,
                remoteId
            })
        }
    );

    if (!String(neural?.reply || '').trim()) {
        throw new Error('admin /api/neural_chat no devolvio reply.');
    }
    reportSuccess(
        'admin /api/neural_chat',
        `path=${neural?.path || 'unknown'} reply="${preview(neural.reply)}"`
    );

    const inserted = await smokeRawMessagesInsert(smokeClient.clientId);
    reportSuccess('raw_messages insert/delete', `id=${inserted.id} client=${inserted.client_id}`);

    console.log(`Smoke test completo para ${smokeClient.clientSlug} (${smokeClient.clientId}).`);
}

main().catch(error => {
    console.error(`FAIL smoke: ${error.message}`);
    process.exit(1);
});
