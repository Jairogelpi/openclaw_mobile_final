import supabase from '../config/supabase.mjs';

/**
 * Verifies a Supabase JWT token and returns the user.
 */
export async function verifySupabaseToken(token) {
    if (!token || token === 'null' || token === 'undefined') {
        throw new Error('Tu sesión ha expirado. Por favor, reinicia sesión.');
    }
    const cleanToken = token.replace(/['"]/g, '');
    const { data: { user }, error } = await supabase.auth.getUser(cleanToken);
    if (error || !user) {
        throw new Error('Invalid user or token expired');
    }
    return user;
}

/**
 * Middleware to authenticate requests using Supabase JWT.
 */
export async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: { message: 'Missing Authorization header' } });
    }

    const token = authHeader.split(' ')[1];
    try {
        const user = await verifySupabaseToken(token);
        req.user = user;
        req.clientId = user.id;
        next();
    } catch (err) {
        return res.status(401).json({ error: { message: err.message } });
    }
}

// For backward compatibility if needed by other files temporarily
export const authenticateToken = authMiddleware;
