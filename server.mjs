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

// Global error handlers to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 [Fatal] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('🔥 [Fatal] Uncaught Exception:', err);
});

import { encrypt, decrypt } from './security.mjs';
import { startWhatsAppClient, qrCodes, activeSessions, getWhatsAppStatus, logoutWhatsApp } from './channels/whatsapp.mjs';
import supabase from './config/supabase.mjs';
import redisClient from './config/redis.mjs';
import { getClientSlug } from './utils/helpers.mjs';
import { transcribeAudio, extractFileText } from './utils/media.mjs';
import { authRegister, authLogin } from './controllers/auth.controller.mjs';
import { onboardingChat } from './controllers/onboarding.controller.mjs';
import { getInboxSummaries, getInboxHistory, generateSmartReply } from './controllers/inbox.controller.mjs';
import { handleSupabaseWebhook } from './controllers/webhook.controller.mjs';
import { adminHealthDashboard, adminRestartClient, adminDeleteClient, adminViewLogs } from './controllers/admin.controller.mjs';
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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = 3000;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

// Stub: this function was referenced but never fully implemented
async function ensureContainerRunning(slug, clientId) {
    // No-op for now — containers are managed by startWhatsAppClient
}


import { authenticate, strictAuth, authenticateToken } from './middlewares/auth.mjs';




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
        const clientSlug = getClientSlug(req.user.email); // The readable slug for the filesystem
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

        // B) SOUL: GET
        if (method === 'soul.get') {
            return await handleSoulGet(req, res, id);
        }

        // C) WHATSAPP PROXY METHODS
        if (method === 'whatsapp.unlink' || method === 'whatsapp.getAutoReply' || method === 'whatsapp.setAutoReply') {
            return await handleWhatsAppProxyMethod(req, res, method, params, id, clientPortData, ensureContainerRunning, triggerMemoryTimer, stateDir);
        }

        // E) ONBOARDING: UPDATE SETTINGS
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

        const extractedText = await extractFileText(req.file.path, req.file.mimetype, req.file.originalname);

        // Cleanup file
        await fs.unlink(req.file.path);

        res.json({
            text: extractedText,
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

// === ADMIN: RESTART CONTAINER ===
app.post('/admin/restart/:slug', (req, res) => adminRestartClient(req, res, activeSessions, startWhatsAppClient));

// === ADMIN: DELETE CLIENT ===
app.post('/admin/delete/:slug', (req, res) => adminDeleteClient(req, res, activeSessions));

// === WEBHOOKS ===
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

            // For now, we simple-proxy the messages to the user's specific OpenClaw state if needed
            // Or just keep the connection alive for potential live updates
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

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SaaS Bridge listening on http://0.0.0.0:${PORT}`);
});
