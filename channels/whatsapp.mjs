import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from '../utils/whatsapp_db_auth.mjs';
import pino from 'pino';
import { processMessage } from '../core_engine.mjs';
import redisClient from '../config/redis.mjs';
import groq from '../services/groq.mjs';
import supabase from '../config/supabase.mjs';

/**
 * Resetea el temporizador de inactividad para un cliente.
 */
async function triggerMemoryTimer(clientId) {
    if (!redisClient) return;
    try {
        await redisClient.set(`idle:${clientId}`, 'process', { EX: 60 });
        console.log(`[Timer] ⏳ Reloj reseteado para ${clientId}. Procesando en 60s de inactividad.`);
    } catch (e) {
        console.warn('[Timer] Error reseteando temporizador:', e.message);
    }
}

export const activeSessions = new Map();
console.log("🚀🚀🚀 WHATSAPP.MJS LOADED AT " + new Date().toISOString());
export const qrCodes = new Map();
const startingSessions = new Set();

// Helper robusto para extraer contenido de mensajes anidados (ephemeral, viewOnce, etc)
const extractMessageContent = (m) => {
    if (!m) return '';
    if (typeof m === 'string') return m;

    // Si m es el objeto msg.message completo, intentamos sacar el contenido real
    const content = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m;

    if (content.conversation) return content.conversation;
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
    if (content.imageMessage?.caption) return content.imageMessage.caption;
    if (content.videoMessage?.caption) return content.videoMessage.caption;
    if (content.documentMessage?.caption) return content.documentMessage.caption;
    if (content.buttonsResponseMessage?.selectedButtonId) return content.buttonsResponseMessage.selectedButtonId;
    if (content.listResponseMessage?.singleSelectReply?.selectedRowId) return content.listResponseMessage.singleSelectReply.selectedRowId;
    if (content.templateButtonReplyMessage?.selectedId) return content.templateButtonReplyMessage.selectedId;
    if (content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) return content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson;

    // Recursión para mensajes citados si no hay texto arriba
    if (content.quotedMessage) return extractMessageContent(content.quotedMessage);

    return '';
};
const reconnectAttempts = new Map(); // Track reconnect attempts for exponential backoff

// Cache para evitar pedir la foto de perfil en cada mensaje (válida por 1 hora)
const profilePicCache = new Map();

/**
 * Inicia una sesión WebSocket pura para WhatsApp (Consumo: ~10MB RAM)
 */
export async function startWhatsAppClient(clientId, clientSlug, phoneNumber = null) {
    const sessionKey = String(clientId);
    if (startingSessions.has(sessionKey)) {
        console.log(`[WhatsApp-Baileys] ⏳ Bloqueado por candado: ${clientSlug} (${sessionKey}) ya se está iniciando.`);
        return { status: 'starting' };
    }

    startingSessions.add(sessionKey);
    console.log(`[WhatsApp-Baileys] 🚀 Iniciando sesión superligera para: ${clientSlug} (${sessionKey})...`);

    let sock = activeSessions.get(sessionKey);
    if (sock) {
        startingSessions.delete(sessionKey); // Ya tenemos sesión, liberamos candado
        if (phoneNumber && !sock.authState.creds.registered) {
            const formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
            try {
                await new Promise(resolve => setTimeout(resolve, 2000));
                let code = await sock.requestPairingCode(formattedNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                return { status: 'pairing_code', code };
            } catch (e) {
                console.error(`[WhatsApp-Baileys] ❌ Error requesting pairing code:`, e.message);
                return { status: 'error', message: e.message };
            }
        }
        return { status: 'already_running' };
    }

    let state, saveCreds;
    try {
        const auth = await useSupabaseAuthState(clientId);
        state = auth.state;
        saveCreds = auth.saveCreds;
    } catch (authErr) {
        console.error(`[WhatsApp-Baileys] ❌ Error cargando auth para ${clientSlug}:`, authErr.message);
        startingSessions.delete(sessionKey);
        return { status: 'error', message: authErr.message };
    }

    // Obtener la versión actual del protocolo WhatsApp (fix para error 405)
    let waVersion;
    try {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
        console.log(`[WhatsApp-Baileys] 📡 Versión WA obtenida: ${waVersion}`);
    } catch (vErr) {
        waVersion = [2, 2413, 1]; // Fallback seguro
        console.warn(`[WhatsApp-Baileys] ⚠️ No se pudo obtener versión WA, usando fallback: ${waVersion}`);
    }

    // Instanciar el socket (0 navegadores, 100% código nativo)
    sock = makeWASocket({
        auth: state,
        version: waVersion,
        printQRInTerminal: !phoneNumber,
        browser: ['Mac OS', 'Chrome', '121.0.6167.85'],
        syncFullHistory: true, // Habilitado para cumplir con la ingesta de 1 año
        markOnlineOnConnect: false,
        qrTimeout: 120_000, // 2 minutos por ciclo QR (default: 60s) — da más tiempo al usuario
        logger: pino({ level: 'silent' })
    });

    // 1. Guardar credenciales automáticamente si cambian
    sock.ev.on('creds.update', saveCreds);

    // 2. Eventos de Conexión y QR
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[WhatsApp-Baileys] 📱 Nuevo QR generado para ${clientSlug}`);
            qrCodes.set(sessionKey, qr);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.warn(`[WhatsApp-Baileys] ❌ ${clientSlug} disconnected. Reason: ${statusCode || 'Unknown'}. Reconnect: ${shouldReconnect}`);

            if (lastDisconnect?.error) {
                console.error(`[WhatsApp-Baileys] 🛑 Full Error:`, lastDisconnect.error);
            }

            activeSessions.delete(sessionKey);
            qrCodes.delete(sessionKey);
            startingSessions.delete(sessionKey);

            if (shouldReconnect && statusCode !== 405 && statusCode !== 401) {
                let attempts = reconnectAttempts.get(sessionKey) || 0;
                attempts++;

                if (attempts > 12) { // Max ~1 hora de reintentos antes de rendirse
                    console.error(`[WhatsApp-Baileys] 🚫 Max reconnect attempts reached for ${clientSlug}. Deteniendo reconexiones automáticas.`);
                    reconnectAttempts.delete(sessionKey);
                } else {
                    reconnectAttempts.set(sessionKey, attempts);
                    // Exponential backoff: 10s, 15s, 22.5s, 33.7s, ... max 5 mins
                    const delay = Math.min(10000 * Math.pow(1.5, attempts - 1), 5 * 60 * 1000);
                    console.log(`[WhatsApp-Baileys] ⏳ Programando reconexión (intento ${attempts}/12) en ${Math.round(delay / 1000)}s para ${clientSlug}...`);
                    setTimeout(() => startWhatsAppClient(clientId, clientSlug), delay);
                }
            } else if (statusCode === 405) {
                console.warn(`[WhatsApp-Baileys] 🛑 Emparejamiento rechazado (405). No se reconectará automáticamente.`);
                reconnectAttempts.delete(sessionKey);
            } else if (statusCode === 401) {
                console.warn(`[WhatsApp-Baileys] 🔐 Sesión cerrada/inválida (401) para ${clientSlug}. Limpiando archivos para permitir re-vinculación.`);
                reconnectAttempts.delete(sessionKey);
                // Purge the session directory asynchronously
                const sessionDir = `./clients_sessions/${clientSlug}`;
                import('fs/promises').then(fs => {
                    fs.rm(sessionDir, { recursive: true, force: true }).catch(err => {
                        console.error(`[WhatsApp-Baileys] Failed to purge session dir on 401:`, err.message);
                    });
                });
            }
        } else if (connection === 'open') {
            console.log(`[WhatsApp-Baileys] ✅ ${clientSlug} conectado y listo (RAM al mínimo).`);
            qrCodes.delete(sessionKey);
            startingSessions.delete(sessionKey);
            reconnectAttempts.delete(sessionKey); // Reset attempts on successful connection
        }
    });

    // 3.1 Sincronización de Historial (Indexing on Login - Last 1 Year + Chunked Batching)
    sock.ev.on('messaging-history.set', async ({ messages, isLatest }) => {
        console.log(`[${clientSlug}] 📚 Sincronizando historial: ${messages.length} mensajes totales en el evento.`);
        const supabase = (await import('../config/supabase.mjs')).default;

        const oneYearAgo = Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60);

        // Filtrar por fecha (último año) y limpiar nulos
        const filteredMessages = messages.filter(msg => {
            const timestamp = msg.messageTimestamp;
            return timestamp && timestamp > oneYearAgo;
        }).sort((a, b) => b.messageTimestamp - a.messageTimestamp);

        console.log(`[${clientSlug}] 📂 Procesando ${filteredMessages.length} mensajes del último año...`);

        const allEntries = [];
        for (const msg of filteredMessages) {
            const isSentByMe = msg.key.fromMe;
            const senderId = msg.key.remoteJid;
            if (senderId === 'status@broadcast') continue;

            let text = extractMessageContent(msg.message);
            if (!text) continue;

            allEntries.push({
                client_id: clientId,
                sender_role: isSentByMe ? 'user_sent' : (msg.pushName || 'Historial'),
                content: text,
                remote_id: senderId,
                metadata: { historical: true, msgId: msg.key.id },
                created_at: new Date(msg.messageTimestamp * 1000).toISOString()
            });
        }

        // Dividir en lotes de 500 para evitar saturar la conexión/CPU
        const chunkSize = 500;
        for (let i = 0; i < allEntries.length; i += chunkSize) {
            const chunk = allEntries.slice(i, i + chunkSize);
            try {
                console.log(`[${clientSlug}] 🚚 Insertando lote de ${chunk.length} mensajes históricos (${i + 1}-${i + chunk.length})...`);
                const { error: batchErr } = await supabase.from('raw_messages').insert(chunk);
                if (batchErr) {
                    console.warn(`[${clientSlug}] ⚠️ Posibles duplicados en lote histórico:`, batchErr.message);
                }
            } catch (e) {
                console.error(`[${clientSlug}] ❌ Error crítico en inserción masiva:`, e.message);
            }
        }

        if (isLatest) {
            console.log(`[${clientSlug}] ✅ Historial sincronizado completamente (${filteredMessages.length} mensajes indexados).`);
            await triggerMemoryTimer(clientId);
        }
    });

    // 3. El Tubo Neural: Escuchar mensajes y enviarlos a nuestro Cerebro Central
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) {
                console.log(`[${clientSlug}] ℹ️ Mensaje sin cuerpo ignorado (Protocolo/Status/BaileysSync).`);
                return;
            }

            console.log(`📩 [${clientSlug}] msgId=${msg.key.id} RECEIVED`);

            const isSentByMe = msg.key.fromMe;
            const senderId = msg.key.remoteJid;
            const msgContent = msg.message;
            const pushName = msg.pushName || (isSentByMe ? 'Yo' : 'Contacto');
            const isGroup = senderId.endsWith('@g.us');

            const hasImage = !!msgContent.imageMessage;
            const hasAudio = !!(msgContent.audioMessage || msgContent.pttMessage);
            const hasDocument = !!msgContent.documentMessage;
            const hasVideo = !!msgContent.videoMessage;
            const hasSticker = !!msgContent.stickerMessage;

            let text = extractMessageContent(msgContent);
            let mediaDescription = '';

            // Procesar Media
            if (hasImage || hasAudio || hasDocument) {
                try {
                    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const { processAttachment } = await import('../utils/media.mjs');

                    const attachmentResult = await processAttachment({
                        type: hasImage ? 'image' : hasAudio ? 'audio' : 'document',
                        mimetype: msgContent.imageMessage?.mimetype || msgContent.audioMessage?.mimetype || msgContent.documentMessage?.mimetype,
                        filename: msgContent.documentMessage?.fileName || (hasImage ? 'image.jpg' : hasAudio ? 'audio.ogg' : 'file'),
                        data: buffer.toString('base64')
                    });
                    mediaDescription = attachmentResult.text;
                } catch (e) {
                    console.warn(`[${clientSlug}] ⚠️ Media Error:`, e.message);
                    mediaDescription = '[Error procesando adjunto]';
                }
            }

            let finalText = [mediaDescription, text].filter(Boolean).join(' ');

            // Fallback
            if (!finalText) {
                if (hasImage) finalText = '[Imagen]';
                else if (hasAudio) finalText = '[Audio]';
                else if (hasVideo) finalText = '[Video]';
                else if (hasSticker) finalText = '[Sticker]';
                else if (isSentByMe) finalText = '[Mensaje del usuario]';
            }

            if (!finalText) {
                console.log(`[${clientSlug}] ℹ️ Mensaje vacío ignorado.`);
                return;
            }

            console.log(`[${clientSlug} - ${isSentByMe ? 'Sent' : 'Recv'}]: ${finalText.slice(0, 50)}...`);

            // INSERTAR EN DB
            const supabase = (await import('../config/supabase.mjs')).default;
            const { error: dbErr } = await supabase.from('raw_messages').insert([{
                client_id: clientId,
                sender_role: isSentByMe ? 'user_sent' : pushName,
                content: finalText,
                remote_id: senderId,
                metadata: {
                    pushName,
                    isGroup,
                    hasMedia: !!mediaDescription,
                    historical: false
                }
            }]);

            if (dbErr) {
                console.error(`[${clientSlug}] ❌ DB Insert Error:`, dbErr.message);
            } else {
                console.log(`[${clientSlug}] ✅ Message stored in raw_messages`);
            }

            if (!isSentByMe) {
                await triggerMemoryTimer(clientId);
            }

        } catch (handlerErr) {
            console.error(`[${clientSlug}] 💀 CRITICAL HANDLER ERROR:`, handlerErr.message);
        }
    });

    // 4. Presence & Typing: Broadcast online/typing status via WebSocket
    sock.ev.on('presence.update', (update) => {
        try {
            if (!global.__wss) return;
            const { id: jid, presences } = update;
            if (!presences) return;

            // Get the first presence entry
            const entries = Object.entries(presences);
            if (entries.length === 0) return;

            const [participantJid, presence] = entries[0];
            const payload = JSON.stringify({
                type: 'whatsapp_presence',
                data: {
                    jid: jid,
                    participant: participantJid,
                    status: presence.lastKnownPresence, // 'available', 'unavailable', 'composing', 'recording', 'paused'
                    lastSeen: presence.lastSeen ? new Date(presence.lastSeen * 1000).toISOString() : null,
                }
            });

            global.__wss.clients.forEach(ws => {
                if (ws.readyState === 1 && ws.userId === clientId) {
                    ws.send(payload);
                }
            });
        } catch (e) {
            // Non-critical
        }
    });

    // Guardar en la RAM para saber que está vivo
    activeSessions.set(sessionKey, sock);

    if (phoneNumber && !sock.authState.creds.registered) {
        let formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
        // Auto-fix Spanish numbers if they lack the prefix (9 digits starting with 6, 7 or 9)
        if (formattedNumber.length === 9 && /^[679]/.test(formattedNumber)) {
            console.log(`[WhatsApp-Baileys] 🇪🇸 Auto-añadiendo prefijo 34 a ${formattedNumber}`);
            formattedNumber = `34${formattedNumber}`;
        }

        console.log(`[WhatsApp-Baileys] Solicitando código para ${formattedNumber} (esperando conexión WSS)...`);

        try {
            // Wait for the websocket to physically connect (reduced to prevent frontend Axios timeouts)
            console.log(`[WhatsApp-Baileys] ⏳ Esperando conexión WSS para ${clientSlug}...`);
            await new Promise(r => setTimeout(r, 3000));

            if (sock.ws?.readyState !== 1) { // 1 = OPEN
                console.warn(`[WhatsApp-Baileys] ⚠️ WS state is ${sock.ws?.readyState} for ${clientSlug}. Wait extended internally.`);
            }

            let code = await sock.requestPairingCode(formattedNumber);
            code = code?.match(/.{1,4}/g)?.join("-") || code;
            console.log(`[WhatsApp-Baileys] 🔢 Código de vinculación exitoso para ${clientSlug}: ${code}`);
            startingSessions.delete(sessionKey);
            return { status: 'pairing_code', code };
        } catch (e) {
            console.error(`[WhatsApp-Baileys] ❌ Error al solicitar código para ${clientSlug}: ${e.message}`);
            startingSessions.delete(sessionKey);

            // Si el error indica que no hay conexión, eliminamos el socket de activos para forzar re-inicio
            if (e.message.includes('not connected') || e.message.includes('closed')) {
                activeSessions.delete(sessionKey);
            }

            return { status: 'error', message: `WhatsApp reportó un error: ${e.message}. Intenta de nuevo en unos segundos.` };
        }
    }

    startingSessions.delete(sessionKey);
    return { status: 'starting' };
}

/**
 * Retorna el estado actual de la conexión de un cliente
 */
export async function getWhatsAppStatus(clientId) {
    const sessionKey = String(clientId);
    const sock = activeSessions.get(sessionKey);

    if (!sock) return { connected: false };

    // Si tiene sock.user, está autenticado y conectado
    if (sock.user) {
        return {
            connected: true,
            user: {
                id: sock.user.id,
                name: sock.user.name || 'Mi WhatsApp'
            }
        };
    }

    return { connected: false, status: 'starting_or_pairing' };
}

/**
 * Cierra la sesión y opcionalmente borra los archivos si se desvincula por completo
 */
import fs from 'fs/promises';
export async function logoutWhatsApp(clientId, clientSlug) {
    const sessionKey = String(clientId);
    const sock = activeSessions.get(sessionKey);

    if (sock) {
        try {
            await sock.logout();
        } catch (e) {
            console.warn(`[WhatsApp-Baileys] Error logout:`, e.message);
            sock.end();
        }
    }

    activeSessions.delete(sessionKey);
    qrCodes.delete(sessionKey);
    startingSessions.delete(sessionKey);

    // Borramos la carpeta de sesión para permitir una nueva vinculación limpia
    const sessionDir = `./clients_sessions/${clientSlug}`;
    try {
        await fs.rm(sessionDir, { recursive: true, force: true });
        console.log(`[WhatsApp-Baileys] 🗑️ Sesión borrada para ${clientSlug}`);
    } catch (e) {
        console.error(`[WhatsApp-Baileys] Error borrando sesión:`, e.message);
    }

    return { success: true };
}
