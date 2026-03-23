import express from 'express';
import supabase from '../config/supabase.mjs';
import { authMiddleware } from '../middleware/auth.middleware.mjs';
import { RpcDispatcher } from '../services/rpc_dispatcher.service.mjs';
import { ClientStorageService } from '../services/client_storage.service.mjs';

const router = express.Router();

/**
 * @route POST /rpc
 * @desc Centralized JSON-RPC Gateway
 */
router.post('/', async (req, res) => {
    const { method, params, id } = req.body;

    try {
        // --- 1. HANDLE PUBLIC METHODS (No Auth Required) ---
        if (RpcDispatcher.publicMethods[method]) {
            return await RpcDispatcher.dispatch(method, req, res, params, id);
        }

        // --- 2. AUTHENTICATION (Standard for Protected Methods) ---
        // Exception: Internal system calls for fetchMedia
        if (method === 'whatsapp.fetchMedia' && !req.headers.authorization) {
            req.clientId = params.clientId;
            if (!req.clientId) throw new Error("Missing clientId in internal fetchMedia params");
            req.user = { email: 'internal-skill@openclaw.local', id: req.clientId };
        } else {
            await new Promise((resolve, reject) => {
                authMiddleware(req, res, (err) => (err ? reject(err) : resolve()));
            });
        }

        // --- 3. CONTEXT PREPARATION ---
        const slug = ClientStorageService.getSlug(req.user.email, req.user.id);
        const stateDir = ClientStorageService.getStateDir(slug);
        await ClientStorageService.ensureDirs(slug);

        const { data: clientPortData } = await supabase
            .from('user_souls')
            .select('port')
            .eq('client_id', req.clientId)
            .single();

        // --- 4. DISPATCH ---
        return await RpcDispatcher.dispatch(method, req, res, params, id, {
            slug,
            stateDir,
            clientPortData
        });

    } catch (err) {
        console.error(`[RPC Gateway] ❌ Error in "${method}":`, err.message);
        if (!res.headersSent) {
            const status = (err.message === 'Unauthorized' || err.message.includes('expired')) ? 401 : 500;
            return res.status(status).json({ error: { message: err.message }, id });
        }
    }
});

export default router;
