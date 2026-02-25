import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

// La llave debe ser de 32 bytes (64 hex chars). Guardada en .env como ENCRYPTION_KEY.
let MASTER_KEY = null;

function getEncryptionKey() {
    if (MASTER_KEY) return MASTER_KEY;
    const key = process.env.ENCRYPTION_KEY;
    if (key && key.length === 64) {
        MASTER_KEY = Buffer.from(key, 'hex');
        console.log('🛡️ [Security] ✅ Cifrado activado (AES-256-GCM).');
        return MASTER_KEY;
    }
    return null;
}

// Lazy check: log on first actual use, not at import time
// (ESM module resolution order can cause false warnings when dotenv hasn't loaded yet)
let _initialCheckDone = false;
export function ensureEncryptionReady() {
    if (_initialCheckDone) return;
    _initialCheckDone = true;
    if (!getEncryptionKey()) {
        console.warn('[Security] ⚠️ ENCRYPTION_KEY no encontrada o inválida. Cifrado desactivado.');
    }
}
// Still run the check for processes that import security.mjs directly (like server.mjs)
setTimeout(() => ensureEncryptionReady(), 0);

/**
 * Detecta si un texto ya fue cifrado por este módulo.
 * Formato: iv(32hex):authTag(32hex):ciphertext(hex)
 */
export function isEncrypted(text) {
    if (!text || typeof text !== 'string') return false;
    const parts = text.split(':');
    if (parts.length !== 3) return false;
    // IV = 32 hex chars, AuthTag = 32 hex chars
    return parts[0].length === 32 && parts[1].length === 32 && /^[0-9a-f]+$/.test(parts[0]);
}

/**
 * Cifra texto con AES-256-GCM.
 * Retorna: iv:authTag:ciphertext (todo en hex)
 */
export function encrypt(text) {
    const key = getEncryptionKey();
    if (!key) return text; // Fallback: sin cifrar si no hay llave

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Descifra texto cifrado con AES-256-GCM.
 * Valida la etiqueta de autenticación (detecta manipulación).
 */
export function decrypt(cipherText) {
    const key = getEncryptionKey();
    if (!key) return cipherText; // Fallback: asumir texto plano

    // Si no está cifrado, devolver tal cual (backward compat)
    if (!isEncrypted(cipherText)) return cipherText;

    const [ivHex, authTagHex, encrypted] = cipherText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
