import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import fs from 'fs/promises';

// Aquí guardaremos todas las sesiones activas en la memoria RAM (ultra rápido y ligero)
export const activeSessions = new Map();

/**
 * Inicia el bot de WhatsApp para un cliente específico
 */
export async function startWhatsAppClient(clientId, clientSlug) {
    if (activeSessions.has(clientId)) {
        console.log(`[WhatsApp] El cliente ${clientSlug} ya está activo.`);
        return;
    }

    console.log(`[WhatsApp] 🚀 Iniciando sesión para: ${clientSlug}...`);

    // Configuramos el cliente con LocalAuth para que recuerde la sesión y no pida QR cada vez
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: clientSlug,
            dataPath: './clients_sessions' // Guardará las sesiones aquí centralizadas
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Necesario en servidores Linux (Hetzner)
        }
    });

    // 1. Evento: Generar QR (solo la primera vez)
    client.on('qr', (qr) => {
        console.log(`\n[WhatsApp] 📱 ¡NUEVO QR PARA ${clientSlug}! Escanéalo con tu móvil:`);
        qrcode.generate(qr, { small: true });

        // TODO: En el futuro, aquí enviaremos el QR por WebSocket al Frontend (Dashboard)
    });

    // 2. Evento: Conectado con éxito
    client.on('ready', () => {
        console.log(`[WhatsApp] ✅ ${clientSlug} conectado y listo para chatear.`);
    });

    // 3. Evento: Mensaje Recibido
    client.on('message', async (message) => {
        // Ignorar mensajes de grupos por defecto (o de estados)
        if (message.from === 'status@broadcast' || message.from.includes('@g.us')) return;

        console.log(`[${clientSlug} - Recibido]: ${message.body}`);

        // Aquí es donde en el futuro inyectaremos tu lógica de IA, RAG y OpenAI
        // Por ahora, pongamos un simple "eco" para probar que funciona
        if (message.body.toLowerCase() === 'ping') {
            await message.reply('¡Pong! Tu motor omnicanal funciona a la perfección. 🚀');
        }
    });

    // 4. Evento: Desconexión
    client.on('disconnected', (reason) => {
        console.warn(`[WhatsApp] ❌ ${clientSlug} desconectado. Razón:`, reason);
        activeSessions.delete(clientId);
    });

    // Guardamos la referencia en el Map y lo arrancamos
    activeSessions.set(clientId, client);
    await client.initialize();
}

/**
 * Detiene y elimina la sesión de un cliente (Ej: si se da de baja)
 */
export async function stopWhatsAppClient(clientId) {
    const client = activeSessions.get(clientId);
    if (client) {
        await client.destroy();
        activeSessions.delete(clientId);
        console.log(`[WhatsApp] 🛑 Sesión detenida para el cliente ${clientId}.`);
    }
}
