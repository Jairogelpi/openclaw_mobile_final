import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import process from 'node:process';
import fs from 'fs/promises';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { createServer } from 'http';
import { parse as parseUrl } from 'url';
import JSON5 from 'json5';
import path from 'path';

// Global error handlers to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 [Fatal] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('🔥 [Fatal] Uncaught Exception:', err);
});

import { encrypt, decrypt } from './security.mjs';
import { startWhatsAppClient, qrCodes, activeSessions, getWhatsAppStatus, logoutWhatsApp, sendHumanLikeMessage } from './channels/whatsapp.mjs';
import supabase from './config/supabase.mjs';
import redisClient from './config/redis.mjs';
import { getClientSlug } from './utils/helpers.mjs';
import { transcribeAudio, extractFileText } from './utils/media.mjs';
import { authRegister, authLogin } from './controllers/auth.controller.mjs';
import { onboardingChat } from './controllers/onboarding.controller.mjs';
import { getInboxSummaries, getInboxHistory, generateSmartReply } from './controllers/inbox.controller.mjs';
import { handleSupabaseWebhook } from './controllers/webhook.controller.mjs';
import { adminHealthDashboard, adminRestartClient, adminLogoutWhatsApp, adminApiDeleteClient, adminDeleteClient, adminViewLogs, adminGetStats, adminGetSoul, adminNeuralChat, adminGetLogs, adminControlContainer } from './controllers/admin.controller.mjs';
import { handleWhatsAppPair, handleWhatsAppStatus, handleWhatsAppLogout, handleWhatsAppProxyMethod } from './controllers/whatsapp.controller.mjs';
import { handleSoulGet, handleSoulRefine } from './controllers/soul.controller.mjs';
import { handleUpdateSettings } from './controllers/settings.controller.mjs';
import { handleAccountDelete } from './controllers/account.controller.mjs';

const upload = multer({ dest: 'uploads/' });

/**
 * Resetea el temporizador de inactividad para un cliente.
 * Cuando expire (60s sin actividad), memory_worker.mjs procesará su memoria.
 */
async function triggerMemoryTimer(clientId) {
    if (!redisClient) return;
    try {
        await redisClient.set(`idle:${clientId}`, 'process', { EX: 60 });
        console.log(`[Timer] ⏳ Reloj reseteado para ${clientId}. Procesando en 60s de inactividad.`);
    } catch (e) {
        console.warn('[Timer] Error reseteando temporizador:', e.message);
    }
}

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });
global.__wss = wss; // Expose for real-time broadcast from WhatsApp channel

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

const PORT = 3000;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

// Stub: this function was referenced but never fully implemented
async function ensureContainerRunning(slug, clientId) {
    // No-op for now — containers are managed by startWhatsAppClient
}


import { authenticate, strictAuth, authenticateToken } from './middlewares/auth.mjs';




/**
 * NEURAL GRAPH VIEWER (GraphRAG Visualization)
 */
app.get('/graph/:clientId', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'graph_viewer.html'));
});

app.get('/api/graph-data/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;

        // Fetch Nodes
        const { data: nodesData, error: nodesErr } = await supabase
            .from('knowledge_nodes')
            .select('entity_name, entity_type, description')
            .eq('client_id', clientId);

        // Fetch Edges
        const { data: edgesData, error: edgesErr } = await supabase
            .from('knowledge_edges')
            .select('source_node, target_node, relation_type')
            .eq('client_id', clientId);

        if (nodesErr || edgesErr) {
            console.error('[Graph-API] DB Error:', nodesErr || edgesErr);
            return res.status(500).json({ error: 'DB Error' });
        }

        // Format for 3d-force-graph
        const graphData = {
            nodes: (nodesData || []).map(n => ({
                id: n.entity_name,
                name: n.entity_name,
                type: n.entity_type,
                description: n.description
            })),
            links: (edgesData || []).map(e => ({
                source: e.source_node,
                target: e.target_node,
                name: e.relation_type
            }))
        };

        res.json(graphData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * RPC GATEWAY
 */
app.post('/rpc', async (req, res) => {
    const { method, params, id } = req.body;

    try {
        // --- 1. MÉTODOS PÚBLICOS (AUTH) ---
        if (method === 'auth.register') {
            const result = await authRegister(params, id);
            return res.json({ result: result, id });
        }

        if (method === 'auth.login') {
            const result = await authLogin(params, id);
            return res.json({ result: result, id });
        }

        // --- 2. MÉTODOS PROTEGIDOS ---
        // Requieren autenticación
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                console.warn(`[Bridge] Missing Authorization header for ${method}`);
                throw new Error('Missing Authorization header');
            }

            let token = authHeader.split(' ')[1];
            if (!token || token === 'null' || token === 'undefined') {
                return res.status(401).json({ error: { message: 'Tu sesión ha expirado o es inválida (token nulo). Por favor, ve a ajustes, cierra sesión y vuelve a iniciarla.' }, id });
            }
            token = token.replace(/['"]/g, ''); // Fix malformed tokens with quotes
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (error || !user) {
                console.error(`[Bridge] Auth failed for ${method}:`, error?.message || 'Invalid user');
                return res.status(401).json({ error: { message: 'Token expirado o inválido. Cierra sesión y vuelve a entrar.' }, id });
            }

            req.user = user;
            req.clientId = user.id;
        } catch (authError) {
            return res.status(401).json({ error: { message: authError.message }, id });
        }

        const clientId = req.clientId; // The original UUID for database calls
        const clientSlug = getClientSlug(req.user.email, req.user.id); // The readable slug for the filesystem
        const clientDir = `./clients/${clientSlug}`;
        const stateDir = `${clientDir}/state`;

        // Auto-create client folder if it doesn't exist (ensures Multi-Tenant isolation)
        try {
            await fs.mkdir(stateDir, { recursive: true });
        } catch (e) {
            console.error(`[Bridge] Failed to create client directory for ${clientSlug}:`, e.message);
        }

        // Resolve this client's port from Supabase
        const { data: clientPortData } = await supabase
            .from('user_souls')
            .select('port')
            .eq('client_id', clientId)
            .single();

        const clientPort = clientPortData?.port;

        // A) WHATSAPP: PAIR
        if (method === 'whatsapp.pair') {
            return await handleWhatsAppPair(req, res, params, id, startWhatsAppClient, qrCodes);
        }

        if (method === 'whatsapp.status') {
            return await handleWhatsAppStatus(req, res, id, getWhatsAppStatus);
        }

        if (method === 'whatsapp.logout') {
            return await handleWhatsAppLogout(req, res, id, logoutWhatsApp);
        }

        // B.1) WHATSAPP: SEND MESSAGE (Text, Media, Reply)
        if (method === 'whatsapp.send') {
            const sock = activeSessions.get(clientId);
            if (!sock) {
                return res.json({ error: { message: 'WhatsApp no está conectado. Vincula tu número primero.' }, id });
            }
            const { jid, text, media, quotedId } = params;
            if (!jid) return res.json({ error: { message: 'Falta el parámetro jid (destinatario)' }, id });

            try {
                let msgPayload = {};

                if (media && media.data) {
                    // Media message (image, audio, document, video)
                    const buffer = Buffer.from(media.data, 'base64');
                    const mimeType = media.mimetype || 'application/octet-stream';

                    if (mimeType.startsWith('image/')) {
                        msgPayload = { image: buffer, caption: text || '', mimetype: mimeType };
                    } else if (mimeType.startsWith('audio/')) {
                        msgPayload = { audio: buffer, mimetype: mimeType, ptt: media.ptt !== false };
                    } else if (mimeType.startsWith('video/')) {
                        msgPayload = { video: buffer, caption: text || '', mimetype: mimeType };
                    } else {
                        msgPayload = { document: buffer, mimetype: mimeType, fileName: media.filename || 'file' };
                    }
                } else {
                    // Text-only message
                    msgPayload = { text: text || '' };
                }

                // If replying to a specific message
                const opts = {};
                if (quotedId) {
                    opts.quoted = { key: { remoteJid: jid, id: quotedId } };
                }

                const sent = await sendHumanLikeMessage(clientId, jid, msgPayload, opts);
                console.log(`[WhatsApp-Send] ✅ Mensaje humanizado enviado a ${jid} (type: ${media ? media.mimetype : 'text'})`);
                return res.json({ result: { success: true, messageId: sent?.key?.id }, id });
            } catch (sendErr) {
                console.error(`[WhatsApp-Send] ❌ Error:`, sendErr.message);
                return res.json({ error: { message: sendErr.message }, id });
            }
        }

        // B.2) WHATSAPP: GET CONTACTS LIST
        if (method === 'whatsapp.getContacts') {
            const sock = activeSessions.get(clientId);
            if (!sock) return res.json({ error: { message: 'WhatsApp no conectado' }, id });
            try {
                const contacts = sock.store?.contacts || {};
                const list = Object.entries(contacts).map(([jid, c]) => ({
                    jid, name: c.name || c.notify || jid.split('@')[0],
                })).filter(c => c.jid.includes('@s.whatsapp.net'));
                return res.json({ result: list, id });
            } catch (e) {
                return res.json({ result: [], id });
            }
        }

        // B.3) WHATSAPP: GET PROFILE PIC
        if (method === 'whatsapp.getProfilePic') {
            const sock = activeSessions.get(clientId);
            if (!sock) return res.json({ error: { message: 'WhatsApp no conectado' }, id });
            try {
                const url = await sock.profilePictureUrl(params.jid, 'image');
                return res.json({ result: { url }, id });
            } catch (e) {
                return res.json({ result: { url: null }, id });
            }
        }

        // B.4) WHATSAPP: SUBSCRIBE TO PRESENCE (online/typing)
        if (method === 'whatsapp.presenceSubscribe') {
            const sock = activeSessions.get(clientId);
            if (!sock) return res.json({ error: { message: 'WhatsApp no conectado' }, id });
            try {
                await sock.presenceSubscribe(params.jid);
                return res.json({ result: { subscribed: true }, id });
            } catch (e) {
                return res.json({ result: { subscribed: false }, id });
            }
        }

        // B.5) WHATSAPP: DELETE MESSAGE
        if (method === 'whatsapp.deleteMessage') {
            const sock = activeSessions.get(clientId);
            if (!sock) return res.json({ error: { message: 'WhatsApp no conectado' }, id });
            try {
                const { jid, messageId, forEveryone } = params;
                if (forEveryone) {
                    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: messageId } });
                }
                return res.json({ result: { deleted: true, forEveryone: !!forEveryone }, id });
            } catch (e) {
                return res.json({ error: { message: e.message }, id });
            }
        }

        // B.6) WHATSAPP: FORWARD MESSAGE
        if (method === 'whatsapp.forward') {
            const sock = activeSessions.get(clientId);
            if (!sock) return res.json({ error: { message: 'WhatsApp no conectado' }, id });
            try {
                const { toJid, text } = params;
                await sock.sendMessage(toJid, { text });
                return res.json({ result: { forwarded: true }, id });
            } catch (e) {
                return res.json({ error: { message: e.message }, id });
            }
        }

        // B.7) WHATSAPP: REACT TO MESSAGE (real emoji reaction via Baileys)
        if (method === 'whatsapp.react') {
            const sock = activeSessions.get(clientId);
            if (!sock) return res.json({ error: { message: 'WhatsApp no conectado' }, id });
            try {
                const { jid, messageId, emoji } = params;
                await sock.sendMessage(jid, {
                    react: {
                        text: emoji, // e.g. '❤️', '😂', '👍', '' to remove
                        key: { remoteJid: jid, id: messageId, fromMe: false }
                    }
                });
                return res.json({ result: { reacted: true }, id });
            } catch (e) {
                return res.json({ error: { message: e.message }, id });
            }
        }

        // B.8) WHATSAPP: SEND LOCATION
        if (method === 'whatsapp.sendLocation') {
            const sock = activeSessions.get(clientId);
            if (!sock) return res.json({ error: { message: 'WhatsApp no conectado' }, id });
            try {
                const { jid, latitude, longitude, name } = params;
                await sock.sendMessage(jid, {
                    location: {
                        degreesLatitude: latitude,
                        degreesLongitude: longitude,
                        name: name || 'Mi ubicación',
                    }
                });
                return res.json({ result: { sent: true }, id });
            } catch (e) {
                return res.json({ error: { message: e.message }, id });
            }
        }

        // B) SOUL: GET
        if (method === 'soul.get') {
            return await handleSoulGet(req, res, id);
        }

        // C) WHATSAPP PROXY METHODS
        if (method === 'whatsapp.unlink' || method === 'whatsapp.getAutoReply' || method === 'whatsapp.setAutoReply') {
            return await handleWhatsAppProxyMethod(req, res, method, params, id, clientPortData, ensureContainerRunning, triggerMemoryTimer, stateDir);
        }


        if (method === 'onboarding.updateSettings') {
            return await handleUpdateSettings(req, res, params, id, encrypt, decrypt);
        }

        // G) SOUL: REFINE (Interactive Refinement)
        if (method === 'soul.refine') {
            return await handleSoulRefine(req, res, params, id, triggerMemoryTimer);
        }

        // F) ONBOARDING: CHAT (GÉNESIS)
        if (method === 'onboarding.chat') {
            const { history, formData, attachments, onboarding_session_id } = params;

            req.clientSlug = clientSlug; // Pass parameters injected into req by middleware emulation
            const result = await onboardingChat(req, params, id);
            return res.json({ result: result, id });
        }

        // H) PANIC BUTTON: ACCOUNT DELETE (TOTAL DESTRUCTION)
        if (method === 'account.delete') {
            return await handleAccountDelete(req, res, id);
        }

        return res.status(404).json({ error: { message: `Method ${method} not found` }, id });

    } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.message || 'Unknown RPC execution error';
        console.error(`[Bridge] ❌ Error execution "${method}":`, errorMsg);

        if (err.code === 'ECONNREFUSED') {
            console.error(`[Bridge] CRITICAL: Cannot reach client session. Is it initializing?`);
        }

        if (err.response) {
            console.error(`[Bridge] Gateway Response (${err.response.status}):`, JSON.stringify(err.response.data, null, 2));
        } else if (err.request) {
            console.error(`[Bridge] No response received from Gateway. Check if port 3001 is open.`);
        } else {
            console.error(`[Bridge] Error details:`, err.stack);
        }

        return res.status(err.response?.status || 500).json({
            error: { message: errorMsg, code: err.code || 'BRIDGE_ERROR' },
            id
        });
    }
});

/**
 * TRANSCRIPTION ENDPOINT (VOICE MESSAGES)
 */
app.post('/transcribe', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) throw new Error('No audio file provided');
        if (req.file.size === 0) throw new Error('Audio file is empty');

        console.log(`[Transcription] Processing file: ${req.file.originalname} (${req.file.size} bytes)`);
        const text = await transcribeAudio(req.file.path);

        if (!text || text.trim().length === 0) {
            console.warn('[Transcription] Whisper returned empty text');
            return res.json({ text: "" });
        }

        res.json({ text });
    } catch (err) {
        console.error('[Transcription] Error:', err.message);
        // Error descriptivo para el front
        res.status(500).json({ error: `Error de transcripción: ${err.message}` });
    }
});

app.post('/analyze-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const { processAttachment } = await import('./utils/media.mjs');
        const attachmentResult = await processAttachment({
            path: req.file.path,
            mimetype: req.file.mimetype,
            filename: req.file.originalname,
            type: req.file.mimetype.includes('image') ? 'image' : 'document'
        });

        const resultText = attachmentResult.text;

        // Cleanup file
        await fs.unlink(req.file.path).catch(() => { });

        res.json({
            text: resultText,
            filename: req.file.originalname,
            mimetype: req.file.mimetype
        });
    } catch (error) {
        console.error('File analysis error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health Check
app.get('/health', async (req, res) => {
    res.json({ status: 'OK', bridge: 'ONLINE' });
});

// --- INBOX & SUMMARIES ---
app.get('/inbox', authenticateToken, getInboxSummaries);
app.get('/inbox/history/:remoteId', authenticateToken, getInboxHistory);

app.post('/inbox/smart-reply', authenticateToken, generateSmartReply);


// === ADMIN HEALTH DASHBOARD ===
app.get('/admin/health', (req, res) => adminHealthDashboard(req, res, activeSessions));
app.post('/admin/restart/:slug', (req, res) => adminRestartClient(req, res, activeSessions, startWhatsAppClient));
app.post('/admin/delete/:slug', (req, res) => adminDeleteClient(req, res, activeSessions));
app.get('/admin/logs/:slug', (req, res) => adminViewLogs(req, res));

// --- NUEVAS RUTAS DASHBOARD (Phase 12) ---
app.get('/admin/api/stats', (req, res) => adminGetStats(req, res, activeSessions, qrCodes));
app.get('/admin/api/soul/:slug', (req, res) => adminGetSoul(req, res));
app.get('/admin/api/logs/:slug', (req, res) => adminGetLogs(req, res));
app.post('/admin/api/neural_chat', (req, res) => adminNeuralChat(req, res));
app.post('/admin/api/whatsapp/logout/:slug', (req, res) => adminLogoutWhatsApp(req, res, activeSessions));
app.post('/admin/api/client/delete/:slug', (req, res) => adminApiDeleteClient(req, res, activeSessions));
app.post('/admin/api/container/:action/:containerName', (req, res) => adminControlContainer(req, res));
app.get('/admin/api/container/logs/:containerName', (req, res) => {
    req.params.action = 'logs';
    adminControlContainer(req, res);
});
// Este endpoint debe ser configurado en Supabase > Database > Webhooks
// Trigger: DELETE en la tabla 'user_souls'
app.post('/admin/webhooks/supabase', express.json(), handleSupabaseWebhook);

// === ADMIN: VIEW LOGS ===
app.get('/admin/logs/:slug', adminViewLogs);


// WebSocket Upgrade Handler
httpServer.on('upgrade', async (request, socket, head) => {
    const { query } = parseUrl(request.url, true);
    let token = query.token; // Changed const to let

    if (!token) {
        socket.destroy();
        return;
    }

    try {
        if (token) {
            token = token.replace(/['"]/g, ''); // Fix malformed tokens
        }
        // Authenticate WebSocket
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            console.error('[WS Auth Error] Verification failed for token:', token ? `${token.substring(0, 10)}... (len: ${token.length})` : 'NULL');
            throw new Error('Unauthorized');
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log(`🔌 [WS] Client connected: ${user.email}`);
            ws.userId = user.id;
            ws.userEmail = user.email;

            ws.on('message', (message) => {
                console.log(`📩 [WS] Received from ${user.email}:`, message.toString());
            });

            ws.on('close', () => console.log(`🔌 [WS] Client disconnected: ${user.email}`));
        });
    } catch (err) {
        console.error('[WS Auth Error]', err.message);
        socket.destroy();
    }
});

httpServer.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 SaaS Bridge listening on http://0.0.0.0:${PORT}`);

    // DEBUG: Auto-start Jairo Gelpi client for ingestion verification
    const debugClientId = '4b817c0c-bb1b-47d6-b5b1-4367af9403ff';
    const debugClientSlug = 'gelpierreape-4b817';
    console.log(`[Debug] 🚀 Auto-starting ${debugClientSlug}...`);
    try {
        await startWhatsAppClient(debugClientId, debugClientSlug);
    } catch (e) {
        console.error(`[Debug] ❌ Failed to start ${debugClientSlug}:`, e.message);
    }

    // --- 🧹 GARBAGE COLLECTOR (Self-Healing) ---
    // Runs every 15 minutes to forcefully delete physical folders that no longer exist in Supabase DB
    // This bypasses the limitations of PostgreSQL cascaded delete triggers bypassing Webhooks.
    const runGarbageCollector = async () => {
        try {
            const { data: activeUsers, error } = await supabase.from('user_souls').select('slug');
            if (error || !activeUsers) throw error;

            const activeSlugs = activeUsers.map(u => u.slug).filter(Boolean);

            // Revisa carpetas físicas
            const clientsPath = path.resolve('./clients');
            let directories;
            try {
                directories = await fs.readdir(clientsPath, { withFileTypes: true });
            } catch (readErr) {
                // clients folder doesn't exist yet
                await fs.mkdir(clientsPath, { recursive: true });
                directories = [];
            }

            let purged = 0;
            for (let dirent of directories) {
                if (dirent.isDirectory()) {
                    const folderName = dirent.name;
                    if (!activeSlugs.includes(folderName)) {
                        console.log(`[GarbageCollector] 🗑️ Carpeta fantasma detectada: ${folderName}. Purging...`);
                        await fs.rm(path.join(clientsPath, folderName), { recursive: true, force: true });
                        purged++;
                    }
                }
            }
            console.log(`[GarbageCollector] ✅ Ciclo completado. DB slugs: ${activeSlugs.length}, Carpetas: ${directories.filter(d => d.isDirectory()).length}, Purgadas: ${purged}`);
        } catch (e) {
            console.error('[GarbageCollector] ⚠️ Fallo al recolectar basura de clientes:', e.message);
        }
    };

    // Ejecutar inmediatamente al arrancar y luego cada 2 minutos
    runGarbageCollector();
    setInterval(runGarbageCollector, 2 * 60 * 1000);

    // 5. BRIDGE HEALTH HEARTBEAT (Hourly)
    setInterval(() => {
        const mem = process.memoryUsage();
        const sessions = activeSessions.size;
        console.log(`💓 [Bridge-Health] Sessions: ${sessions}. Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.rss / 1024 / 1024)}MB RSS`);
    }, 3600_000);
});
