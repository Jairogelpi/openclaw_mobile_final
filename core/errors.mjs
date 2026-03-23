// Global error handlers to prevent silent crashes
export function setupGlobalErrorHandlers() {
    process.on('unhandledRejection', (reason, promise) => {
        console.error('🔥 [Fatal] Unhandled Rejection at:', promise, 'reason:', reason);
    });
    process.on('uncaughtException', (err) => {
        console.error('🔥 [Fatal] Uncaught Exception:', err);
    });
}
