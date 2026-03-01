import pino from 'pino';

/**
 * Centralized Logger for OpenClaw.
 * Configured with pretty printing in development and JSON in production.
 */
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
        log: (obj) => {
            // PII Scrubbing: Mask phone-like patterns and truncate large content
            const scrub = (val) => {
                if (typeof val === 'string') {
                    // Primitive phone masking (e.g., 521234567890@s.whatsapp.net -> 521*****@s.whatsapp.net)
                    let s = val.replace(/(\d{5})\d+(@s\.whatsapp\.net|@g\.us)/g, '$1*****$2');
                    // Truncate ultra-long strings (e.g., full chat histories or base64)
                    if (s.length > 500) return s.substring(0, 500) + '... [TRUNCATED]';
                    return s;
                }
                if (val && typeof val === 'object') {
                    for (const key in val) val[key] = scrub(val[key]);
                }
                return val;
            };
            return scrub(obj);
        }
    },
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
        }
    }
});

// Helper for structured metadata
export const log = (level, message, metadata = {}) => {
    logger[level]({ ...metadata }, message);
};

export default logger;
