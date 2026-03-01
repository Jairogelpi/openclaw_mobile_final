import pino from 'pino';

/**
 * Centralized Logger for OpenClaw.
 * Configured with pretty printing in development and JSON in production.
 */
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
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
