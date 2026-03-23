import 'dotenv/config';
import supabase from '../config/supabase.mjs';

function getArg(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(arg => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function normalizeIsoTimestamp(value = null) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
}

function looksLikeWhatsappRemoteId(value = '') {
    const raw = String(value || '').trim();
    return /@s\.whatsapp\.net$|@lid$|@g\.us$/.test(raw);
}

function isWhatsappRow(row = null) {
    const metadata = row?.metadata || {};
    const channel = String(metadata.channel || '').trim().toLowerCase();
    if (channel === 'whatsapp') return true;
    if (looksLikeWhatsappRemoteId(row?.remote_id) || looksLikeWhatsappRemoteId(metadata.participantJid)) return true;
    return Boolean(metadata.timestamp);
}

function needsTimestampRepair(row = null) {
    const metadataTimestamp = normalizeIsoTimestamp(row?.metadata?.timestamp);
    if (!metadataTimestamp) return false;

    const createdAt = normalizeIsoTimestamp(row?.created_at);
    if (!createdAt) return true;

    return createdAt !== metadataTimestamp;
}

async function fetchClientRows(clientId, limit = 12000) {
    const rows = [];
    const pageSize = Math.min(1000, Math.max(100, limit));

    for (let offset = 0; offset < limit; offset += pageSize) {
        const { data, error } = await supabase
            .from('raw_messages')
            .select('id, client_id, remote_id, created_at, metadata')
            .eq('client_id', clientId)
            .order('created_at', { ascending: true })
            .range(offset, Math.min(offset + pageSize - 1, limit - 1));

        if (error) throw error;
        if (!data?.length) break;
        rows.push(...data);
        if (data.length < pageSize) break;
    }

    return rows;
}

async function backfillClientWhatsappTimestamps(clientId, { limit = 12000 } = {}) {
    const rows = await fetchClientRows(clientId, limit);
    const whatsappRows = rows.filter(isWhatsappRow);
    const repairRows = whatsappRows.filter(needsTimestampRepair);

    let updated = 0;
    let failed = 0;

    for (const row of repairRows) {
        const nextCreatedAt = normalizeIsoTimestamp(row?.metadata?.timestamp);
        if (!nextCreatedAt) continue;

        const { error } = await supabase
            .from('raw_messages')
            .update({ created_at: nextCreatedAt })
            .eq('id', row.id);

        if (error) {
            failed += 1;
            console.warn(`[Timestamp Backfill] No se pudo actualizar ${row.id}: ${error.message}`);
            continue;
        }

        updated += 1;
    }

    console.log(JSON.stringify({
        clientId,
        scanned_rows: rows.length,
        whatsapp_rows: whatsappRows.length,
        repaired_rows: updated,
        failed_rows: failed
    }, null, 2));
}

async function main() {
    const clientId = getArg('client') || process.env.CLIENT_ID;
    const limit = Number.parseInt(String(getArg('limit', '12000')), 10) || 12000;
    if (!clientId) {
        throw new Error('Missing client id. Use --client=<uuid> or CLIENT_ID env.');
    }

    await backfillClientWhatsappTimestamps(clientId, { limit });
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
    main().catch(error => {
        console.error('[Timestamp Backfill] Failed:', error.message);
        process.exitCode = 1;
    });
}
