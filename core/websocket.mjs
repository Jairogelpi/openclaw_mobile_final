import { WebSocketServer } from 'ws';
import { parse as parseUrl } from 'url';
import supabase from '../config/supabase.mjs';

export function setupWebSocket(httpServer) {
    const wss = new WebSocketServer({ noServer: true });
    global.__wss = wss;

    httpServer.on('upgrade', async (request, socket, head) => {
        const { query } = parseUrl(request.url, true);
        let token = query.token;

        if (!token) {
            socket.destroy();
            return;
        }

        try {
            if (token) {
                token = token.replace(/['"]/g, ''); // Fix malformed tokens
            }
            // Authenticate WebSocket
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (error || !user) {
                console.error('[WS Auth Error] Verification failed for token:', token ? `${token.substring(0, 10)}... (len: ${token.length})` : 'NULL');
                throw new Error('Unauthorized');
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                console.log(`🔌 [WS] Client connected: ${user.email}`);
                ws.userId = user.id;
                ws.userEmail = user.email;

                ws.on('message', (message) => {
                    console.log(`📩 [WS] Received from ${user.email}:`, message.toString());
                });

                ws.on('close', () => console.log(`🔌 [WS] Client disconnected: ${user.email}`));
            });
        } catch (err) {
            console.error('[WS Auth Error]', err.message);
            socket.destroy();
        }
    });

    return wss;
}
