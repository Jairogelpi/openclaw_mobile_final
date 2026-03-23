import express from 'express';
import { authRegister, authLogin } from '../controllers/auth.controller.mjs';

const router = express.Router();

/**
 * @route POST /api/auth/register
 * @desc Register a new user
 */
router.post('/register', async (req, res) => {
    try {
        const result = await authRegister(req.body, req.body.id);
        res.json({ result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @route POST /api/auth/login
 * @desc Login user and return token
 */
router.post('/login', async (req, res) => {
    try {
        const result = await authLogin(req.body, req.body.id);
        res.json({ result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
