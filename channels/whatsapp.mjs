import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import { processMessage } from '../core_engine.mjs';

export const activeSessions = new Map();
export const qrCodes = new Map();

/**
 * Inicia una sesión WebSocket pura para WhatsApp (Consumo: ~10MB RAM)
 */
export async function startWhatsAppClient(clientId, clientSlug) {
    if (activeSessions.has(clientId)) {
        return { status: 'already_running' };
    }

    console.log(`[WhatsApp-Baileys] 🚀 Iniciando sesión superligera para: ${clientSlug}...`);

    // Cada cliente tendrá su propia subcarpeta para guardar sus llaves criptográficas de sesión
    const sessionDir = `./clients_sessions/${clientSlug}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // Instanciar el socket (0 navegadores, 100% código nativo)
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Útil para ver el QR directamente en la consola de Antigravity
        logger: pino({ level: 'silent' }) // Silenciamos los logs técnicos internos de Baileys
    });

    // 1. Guardar credenciales automáticamente si cambian
    sock.ev.on('creds.update', saveCreds);

    // 2. Eventos de Conexión y QR
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[WhatsApp-Baileys] 📱 Nuevo QR generado para ${clientSlug}`);
            qrCodes.set(clientId, qr);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.warn(`[WhatsApp-Baileys] ❌ ${clientSlug} desconectado. ¿Reconectar automático?: ${shouldReconnect}`);

            activeSessions.delete(clientId);
            qrCodes.delete(clientId);

            // Self-healing: Si la desconexión fue un fallo de red, se reconecta solo
            if (shouldReconnect) {
                startWhatsAppClient(clientId, clientSlug);
            }
        } else if (connection === 'open') {
            console.log(`[WhatsApp-Baileys] ✅ ${clientSlug} conectado y listo (RAM al mínimo).`);
            qrCodes.delete(clientId);
        }
    });

    // 3. El Tubo Neural: Escuchar mensajes y enviarlos a nuestro Cerebro Central
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];

        // Ignorar mensajes enviados por nosotros mismos o que no tengan cuerpo
        if (!msg.message || msg.key.fromMe) return;

        // Baileys separa el texto dependiendo de si es un mensaje normal o una respuesta a otro
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (!text) return;

        const senderId = msg.key.remoteJid;

        // Ignorar grupos o estados de WhatsApp
        if (senderId === 'status@broadcast' || senderId.includes('@g.us')) return;

        console.log(`[${clientSlug} - Recibido]: ${text}`);

        // Empaquetamos el mensaje en el Formato Universal
        const incomingEvent = {
            clientId: clientId,
            clientSlug: clientSlug,
            channel: 'whatsapp',
            senderId: senderId,
            text: text
        };

        // Magia: El Cerebro Central (Llama 3 + RAG) piensa la respuesta
        const aiReply = await processMessage(incomingEvent);

        // Enviamos la respuesta devuelta por el cerebro
        if (aiReply) {
            await sock.sendMessage(senderId, { text: aiReply });
        }
    });

    // Guardar en la RAM para saber que está vivo
    activeSessions.set(clientId, sock);

    return { status: 'starting' };
}
