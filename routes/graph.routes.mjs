import express from 'express';
import { getGraphData } from '../controllers/graph.controller.mjs';
import { authMiddleware } from '../middleware/auth.middleware.mjs';

const router = express.Router();

/**
 * @route GET /api/graph/:clientId
 * @desc Fetch full knowledge graph for 3D visualization
 */
router.get('/:clientId', authMiddleware, getGraphData);

export default router;
