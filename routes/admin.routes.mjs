import express from 'express';
import {
    adminHealthDashboard,
    adminRestartClient,
    adminLogoutWhatsApp,
    adminDeleteClient,
    adminApiDeleteClient,
    adminViewLogs,
    adminGetLogs,
    adminGetStats,
    adminControlContainer,
    adminGetClientFiles,
    adminNeuralChat,
    adminGetRagMetrics,
    adminGetConfig,
    adminSetConfig,
    adminPostFeedback,
    adminGetCache,
    adminClearCache,
    adminSaveClientFile,
    adminWhatsAppPair,
    adminWhatsAppStatus,
    adminWhatsAppReconnect
} from '../controllers/admin.controller.mjs';
import { activeSessions, qrCodes, pairingCodes, startWhatsAppClient } from '../channels/whatsapp.mjs';

const router = express.Router();

/**
 * --- TRADITIONAL HTML DASHBOARD ---
 */
router.get('/health', (req, res) => adminHealthDashboard(req, res, activeSessions));
router.post('/restart/:slug', (req, res) => adminRestartClient(req, res, activeSessions, startWhatsAppClient));
router.post('/delete/:slug', (req, res) => adminDeleteClient(req, res, activeSessions));
router.get('/logs/:slug', (req, res) => adminViewLogs(req, res));

/**
 * --- MODERN API DASHBOARD ---
 */
router.get('/api/stats', (req, res) => adminGetStats(req, res, activeSessions, qrCodes, pairingCodes));
router.get('/api/soul/:slug', (req, res) => adminGetClientFiles(req, res));
router.post('/api/soul/save/:slug/:filename', (req, res) => adminSaveClientFile(req, res));
router.get('/api/cache/:clientId', (req, res) => adminGetCache(req, res));
router.delete('/api/cache/:clientId', (req, res) => adminClearCache(req, res));
router.get('/api/logs/:slug', (req, res) => adminGetLogs(req, res));
router.post('/api/neural_chat', (req, res) => adminNeuralChat(req, res));
router.get('/api/rag-metrics', (req, res) => adminGetRagMetrics(req, res));
router.get('/api/config', (req, res) => adminGetConfig(req, res));
router.post('/api/config', (req, res) => adminSetConfig(req, res));
router.post('/api/feedback', (req, res) => adminPostFeedback(req, res));
router.post('/api/whatsapp/logout/:slug', (req, res) => adminLogoutWhatsApp(req, res, activeSessions));

/**
 * --- WHATSAPP SESSION MANAGEMENT ---
 */
router.post('/api/whatsapp/pair/:slug', (req, res) => adminWhatsAppPair(req, res, activeSessions, qrCodes, startWhatsAppClient));
router.get('/api/whatsapp/status/:slug', (req, res) => adminWhatsAppStatus(req, res, activeSessions, qrCodes));
router.post('/api/whatsapp/reconnect/:slug', (req, res) => adminWhatsAppReconnect(req, res, activeSessions, startWhatsAppClient));

/**
 * --- CONTAINER & SYSTEM CONTROL ---
 */
router.post('/api/client/delete/:slug', (req, res) => adminApiDeleteClient(req, res, activeSessions));
router.post('/api/container/:action/:containerName', (req, res) => adminControlContainer(req, res));
router.get('/api/container/logs/:containerName', (req, res) => {
    req.params.action = 'logs';
    adminControlContainer(req, res);
});

export default router;
