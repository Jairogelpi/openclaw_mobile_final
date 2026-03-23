import express from 'express';
import { handleSupabaseWebhook } from '../controllers/webhook.controller.mjs'; 

const router = express.Router();

/**
 * @route GET /health
 * @desc System health check
 */
router.get('/health', (req, res) => {
    res.json({ status: 'OK', bridge: 'ONLINE' });
});

/**
 * @route POST /admin/webhooks/supabase
 * @desc Webhook for Supabase database events (e.g. user deletion)
 */
router.post('/admin/webhooks/supabase', express.json(), async (req, res) => {
    try {
        return handleSupabaseWebhook(req, res);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
