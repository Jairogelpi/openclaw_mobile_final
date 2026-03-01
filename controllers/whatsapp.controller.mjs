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
