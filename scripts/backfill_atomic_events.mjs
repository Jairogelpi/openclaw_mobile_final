import 'dotenv/config';
import supabase from '../config/supabase.mjs';
import { persistAtomicEvents } from '../services/atomic_events.service.mjs';
import {
    deriveOwnerNameFromSlug,
    fallbackNameFromRemoteId,
    pickBestHumanName
} from '../utils/message_guard.mjs';

function getArg(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(arg => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

async function resolveOwnerName(clientId) {
    const { data: soulRow } = await supabase
        .from('user_souls')
        .select('slug, soul_json')
        .eq('client_id', clientId)
        .maybeSingle();

    return pickBestHumanName(
        soulRow?.soul_json?.nombre,
        deriveOwnerNameFromSlug(soulRow?.slug)
    ) || 'Yo';
}

function inferContactName(messages = [], remoteId = '') {
    const names = [];
    for (const message of (messages || [])) {
        const metadata = message?.metadata || {};
        names.push(
            metadata.conversationName,
            metadata.canonicalSenderName,
            metadata.pushName
        );
    }

    return pickBestHumanName(...names) || fallbackNameFromRemoteId(remoteId) || remoteId;
}

async function backfillClientAtomicEvents(clientId, { limit = 4000 } = {}) {
    const ownerName = await resolveOwnerName(clientId);
    const rows = [];
    const pageSize = Math.min(1000, Math.max(100, limit));
    for (let offset = 0; offset < limit; offset += pageSize) {
        const { data: pageRows, error } = await supabase
            .from('raw_messages')
            .select('id, client_id, remote_id, sender_role, content, semantic_text, created_at, event_timestamp, channel, source_message_id, participant_jid, canonical_sender_name, conversation_name, is_history, quoted_message_id, has_media, media_type, content_ready, delivery_status, metadata, processed')
            .eq('client_id', clientId)
            .eq('processed', true)
            .order('created_at', { ascending: true })
            .range(offset, Math.min(offset + pageSize - 1, limit - 1));

        if (error) throw error;
        if (!pageRows?.length) break;
        rows.push(...pageRows);
        if (pageRows.length < pageSize) break;
    }

    if (!rows?.length) {
        console.log(JSON.stringify({ clientId, inserted: 0, conversations: 0 }));
        return;
    }

    const whatsappRows = rows.filter(row => String(row?.channel || row?.metadata?.channel || '').trim() === 'whatsapp');
    if (!whatsappRows.length) {
        console.log(JSON.stringify({ clientId, inserted: 0, conversations: 0, scanned_messages: rows.length }));
        return;
    }

    const conversations = new Map();
    for (const row of whatsappRows) {
        const remoteId = String(row?.remote_id || '').trim();
        if (!remoteId) continue;
        if (!conversations.has(remoteId)) conversations.set(remoteId, []);
        conversations.get(remoteId).push(row);
    }

    let inserted = 0;
    let failed = 0;
    for (const [remoteId, messages] of conversations.entries()) {
        const contactName = inferContactName(messages, remoteId);
        const result = await persistAtomicEvents({
            clientId,
            remoteId,
            ownerName,
            contactName,
            messages
        });
        inserted += Number(result?.inserted || 0);
        failed += Number(result?.failedRawMessageIds?.length || 0);
    }

    console.log(JSON.stringify({
        clientId,
        ownerName,
        inserted,
        failed,
        conversations: conversations.size,
        scanned_messages: rows.length,
        whatsapp_messages: whatsappRows.length
    }, null, 2));
}

async function main() {
    const clientId = getArg('client') || process.env.CLIENT_ID;
    const limit = Number(getArg('limit', '4000'));
    if (!clientId) {
        throw new Error('Missing client id. Use --client=<uuid> or CLIENT_ID env.');
    }
    await backfillClientAtomicEvents(clientId, { limit });
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
    main().catch(error => {
        console.error('[Atomic Backfill] Failed:', error.message);
        process.exitCode = 1;
    });
}
