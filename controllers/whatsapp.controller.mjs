import axios from 'axios';
import { getClientSlug } from '../utils/helpers.mjs';

const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

export async function handleWhatsAppPair(req, res, params, id, startWhatsAppClient, qrCodes) {
    const clientId = req.clientId;
    const clientSlug = getClientSlug(req.user.email, req.user.id);
    const phoneNumber = params?.phoneNumber;

    try {
        const waRes = await startWhatsAppClient(clientId, clientSlug, phoneNumber);

        if (waRes.status === 'pairing_code') {
            return res.json({ result: { status: 'pairing_code', pairingCode: waRes.code, message: 'Introduce este código en tu WhatsApp.' }, id });
        } else if (waRes.status === 'error') {
            throw new Error(waRes.message);
        }

        const qr = qrCodes.get(clientId);
        if (qr) {
            return res.json({ result: { status: 'qr_ready', qr }, id });
        } else {
            return res.json({ result: { status: 'starting', message: 'Iniciando WhatsApp, vuelve a consultar en 3 segundos...' }, id });
        }
    } catch (err) {
        return res.status(500).json({ error: { message: err.message }, id });
    }
}

export async function handleWhatsAppStatus(req, res, id, getWhatsAppStatus) {
    const clientId = req.clientId;
    try {
        const status = await getWhatsAppStatus(clientId);
        return res.json({ result: status, id });
    } catch (err) {
        return res.status(500).json({ error: { message: err.message }, id });
    }
}

export async function handleWhatsAppLogout(req, res, id, logoutWhatsApp) {
    const clientId = req.clientId;
    const clientSlug = getClientSlug(req.user.email, req.user.id);
    try {
        const result = await logoutWhatsApp(clientId, clientSlug);
        return res.json({ result, id });
    } catch (err) {
        return res.status(500).json({ error: { message: err.message }, id });
    }
}

export async function handleWhatsAppSend(req, res, params, id, activeSessions, sendHumanLikeMessage) {
    const clientId = req.clientId;
    const sock = activeSessions.get(clientId);
    if (!sock) return res.json({ error: { message: 'WhatsApp no está conectado.' }, id });
    
    const { jid, text, media, quotedId } = params;
    if (!jid) return res.json({ error: { message: 'Falta el parámetro jid' }, id });

    try {
        let msgPayload = media && media.data ? { 
            [media.mimetype.split('/')[0]]: Buffer.from(media.data, 'base64'),
            caption: text || '',
            mimetype: media.mimetype,
            ptt: media.ptt !== false
        } : { text: text || '' };

        // Correction for non-standard media types (document)
        if (media && media.data && !['image', 'audio', 'video'].includes(media.mimetype.split('/')[0])) {
             msgPayload = { document: Buffer.from(media.data, 'base64'), mimetype: media.mimetype, fileName: media.filename || 'file' };
        }

        const opts = quotedId ? { quoted: { key: { remoteJid: jid, id: quotedId } } } : {};
        const sent = await sendHumanLikeMessage(clientId, jid, msgPayload, opts);
        return res.json({ result: { success: true, messageId: sent?.key?.id }, id });
    } catch (err) {
        return res.json({ error: { message: err.message }, id });
    }
}

export async function handleWhatsAppGetContacts(req, res, id, activeSessions) {
    const clientId = req.clientId;
    const sock = activeSessions.get(clientId);
    if (!sock) return res.json({ error: { message: 'WhatsApp no conectado' }, id });
    const list = Object.entries(sock.store?.contacts || {}).map(([jid, c]) => ({
        jid, name: c.name || c.notify || jid.split('@')[0],
    })).filter(c => c.jid.includes('@s.whatsapp.net'));
    return res.json({ result: list, id });
}

export async function handleWhatsAppFetchMedia(req, res, params, id, fetchHistoricalMedia) {
    const clientId = req.clientId;
    try {
        const { remoteJid, messageId } = params;
        const { buffer, mediaType, mimeType } = await fetchHistoricalMedia(clientId, remoteJid, messageId);
        return res.json({ result: { mediaType, mimeType, data: buffer.toString('base64') }, id });
    } catch (e) { 
        return res.json({ error: { message: e.message }, id }); 
    }
}

export async function handleWhatsAppProxyMethod(req, res, method, params, id, clientPortData, ensureContainerRunning, triggerMemoryTimer, stateDir) {
    const clientId = req.clientId;
    const clientSlug = getClientSlug(req.user.email, req.user.id);
    const clientPort = clientPortData?.port;

    try {
        if (!clientPort) throw new Error('Puerto no asignado para este cliente.');
        await ensureContainerRunning(clientSlug, clientId);
        await triggerMemoryTimer(clientId);

        const response = await axios.post(`http://localhost:${clientPort}/rpc`, {
            method,
            params,
            id
        }, {
            headers: {
                'x-openclaw-state-dir': stateDir,
                'Authorization': `Bearer ${GATEWAY_TOKEN}`
            }
        });
        return res.json(response.data);
    } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.message;
        return res.status(500).json({ error: { message: errorMsg }, id });
    }
}
