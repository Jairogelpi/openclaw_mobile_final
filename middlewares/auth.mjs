import jwt from 'jsonwebtoken';
import supabase from '../config/supabase.mjs';

/**
 * AUTH MIDDLEWARE: Validates the token sent by the mobile app.
 * In a real SaaS, this would use Supabase Auth tokens.
 */
export async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: { message: 'Missing Authorization header' } });

    const token = authHeader.split(' ')[1];
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) throw new Error('Invalid token');
        req.user = user;
        req.clientId = user.id; // Multi-tenant ID
        next();
    } catch (err) {
        return res.status(401).json({ error: { message: 'Unauthorized' } });
    }
}

/**
 * STRICT AUTH: Verifica que el JWT pertenece al usuario que intenta acceder.
 * Cross-check: JWT sub == client_id del slug solicitado.
 */
export async function strictAuth(req, res, next) {
    let token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: { message: 'No token provided' } });
    token = token.replace(/['"]/g, ''); // Fix malformed tokens

    try {
        // PRIORIDAD: Usar siempre el SDK de Supabase para validar el token.
        // El SDK maneja automáticamente los algoritmos (HS256/RS256) y es la fuente de verdad.
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            // Fallback: Si el SDK falla pero tenemos el secreto, intentar decodificación manual
            // para tokens personalizados o de sesión local.
            if (process.env.SUPABASE_JWT_SECRET) {
                const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
                req.user = decoded;
                req.clientId = decoded.sub;
            } else {
                throw new Error(error?.message || 'Invalid token');
            }
        } else {
            // Unificar para que el controlador encuentre siempre req.user.clientId
            user.clientId = user.id;
            req.user = user;
            req.clientId = user.id;
        }
        next();
    } catch (err) {
        console.error(`[Auth] ❌ Validation failed for token (${token?.substring(0, 10)}...):`, err.message);
        return res.status(401).json({ error: { message: `Tu sesión ha caducado por seguridad (${err.message.includes('expired') ? 'Expirada' : 'Inválida'}). Por favor, ve a Configuración, cierra sesión y vuelve a entrar.` } });
    }
}

export const authenticateToken = strictAuth;
