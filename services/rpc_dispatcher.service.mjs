import { authRegister, authLogin } from '../controllers/auth.controller.mjs';
import { onboardingChat } from '../controllers/onboarding.controller.mjs';
import { 
    handleWhatsAppPair, 
    handleWhatsAppStatus, 
    handleWhatsAppLogout, 
    handleWhatsAppSend,
    handleWhatsAppGetContacts,
    handleWhatsAppFetchMedia,
    handleWhatsAppProxyMethod 
} from '../controllers/whatsapp.controller.mjs';
import { handleSoulGet, handleSoulRefine } from '../controllers/soul.controller.mjs';
import { handleUpdateSettings } from '../controllers/settings.controller.mjs';
import { handleAccountDelete } from '../controllers/account.controller.mjs';

import { 
    startWhatsAppClient, 
    qrCodes, 
    activeSessions, 
    getWhatsAppStatus, 
    logoutWhatsApp, 
    sendHumanLikeMessage, 
    fetchHistoricalMedia 
} from '../channels/whatsapp.mjs';

import { encrypt, decrypt } from '../core/security.mjs';

/**
 * RPC Dispatcher - Maps public and protected methods to their respective handlers.
 */
export class RpcDispatcher {
    static publicMethods = {
        'auth.register': authRegister,
        'auth.login': authLogin
    };

    static protectedMethods = {
        'whatsapp.pair': (req, res, params, id) => handleWhatsAppPair(req, res, params, id, startWhatsAppClient, qrCodes),
        'whatsapp.status': (req, res, params, id) => handleWhatsAppStatus(req, res, id, getWhatsAppStatus),
        'whatsapp.logout': (req, res, params, id) => handleWhatsAppLogout(req, res, id, logoutWhatsApp),
        'whatsapp.send': (req, res, params, id) => handleWhatsAppSend(req, res, params, id, activeSessions, sendHumanLikeMessage),
        'whatsapp.getContacts': (req, res, params, id) => handleWhatsAppGetContacts(req, res, id, activeSessions),
        'whatsapp.fetchMedia': (req, res, params, id) => handleWhatsAppFetchMedia(req, res, params, id, fetchHistoricalMedia),
        'soul.get': (req, res, params, id) => handleSoulGet(req, res, id),
        'soul.refine': (req, res, params, id) => handleSoulRefine(req, res, params, id, RpcDispatcher.triggerMemoryTimer),
        'onboarding.updateSettings': (req, res, params, id) => handleUpdateSettings(req, res, params, id, encrypt, decrypt),
        'onboarding.chat': async (req, res, params, id) => res.json({ result: await onboardingChat(req, params, id), id }),
        'account.delete': (req, res, params, id) => handleAccountDelete(req, res, id)
    };

    static async dispatch(method, req, res, params, id, extraContext = {}) {
        // 1. Try public methods
        if (this.publicMethods[method]) {
            const result = await this.publicMethods[method](params, id);
            return res.json({ result, id });
        }

        // 2. Try protected methods (Assuming auth check was already done in route)
        if (this.protectedMethods[method]) {
            return await this.protectedMethods[method](req, res, params, id);
        }

        // 3. Fallback for proxy methods
        if (['whatsapp.unlink', 'whatsapp.getAutoReply', 'whatsapp.setAutoReply'].includes(method)) {
            return await handleWhatsAppProxyMethod(
                req, res, method, params, id, 
                extraContext.clientPortData, 
                RpcDispatcher.ensureContainerRunning, 
                RpcDispatcher.triggerMemoryTimer, 
                extraContext.stateDir
            );
        }

        throw new Error(`Method ${method} not found`);
    }

    // --- Internal Helpers extracted to static methods for abstraction ---

    static async triggerMemoryTimer(clientId) {
        const { default: redisClient } = await import('../config/redis.mjs');
        if (!redisClient) return;
        try {
            await redisClient.set(`idle:${clientId}`, 'process', { EX: 60 });
        } catch (e) {
            console.warn('[Timer] Error reseteando temporizador:', e.message);
        }
    }

    static async ensureContainerRunning(slug, clientId) {
        // Implementation logic can be moved to a DockerService later if needed
    }
}
