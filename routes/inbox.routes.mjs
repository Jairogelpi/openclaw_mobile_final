import express from 'express';
import { getInboxSummaries, getInboxHistory, generateSmartReply, markAsRead, getWhatsAppMetadata } from '../controllers/inbox.controller.mjs';
import { authMiddleware } from '../middleware/auth.middleware.mjs';

const router = express.Router();

// All inbox routes require authentication
router.use(authMiddleware);

/**
 * @route GET /api/inbox
 * @desc Get all inbox summaries for the client
 */
router.get('/', getInboxSummaries);

/**
 * @route GET /api/inbox/history/:remoteId
 * @desc Get message history for a specific conversation
 */
router.get('/history/:remoteId', getInboxHistory);

/**
 * @route POST /api/inbox/mark-read/:jid
 * @desc Mark a conversation as read
 */
router.post('/mark-read/:jid', markAsRead);

/**
 * @route POST /api/inbox/smart-reply
 * @desc Generate an AI smart reply for a message
 */
router.post('/smart-reply', generateSmartReply);

/**
 * @route GET /api/inbox/metadata/:jid
 * @desc Get WhatsApp metadata for a specific JID
 */
router.get('/metadata/:jid', getWhatsAppMetadata);

export default router;
