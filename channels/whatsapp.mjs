import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import { processMessage } from '../core_engine.mjs';

export const activeSessions = new Map();
export const qrCodes = new Map();
const startingSessions = new Set();

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

    // Cada cliente tendrá su propia subcarpeta para guardar sus llaves criptográficas de sesión
    const sessionDir = `./clients_sessions/${clientSlug}`;
    let state, saveCreds;
    try {
        const auth = await useMultiFileAuthState(sessionDir);
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
        syncFullHistory: false,
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

            if (shouldReconnect && statusCode !== 405) {
                console.log(`[WhatsApp-Baileys] ⏳ Programando reconexión en 10s para ${clientSlug}...`);
                setTimeout(() => startWhatsAppClient(clientId, clientSlug), 10000); // 10s cooloff
            } else if (statusCode === 405) {
                console.warn(`[WhatsApp-Baileys] 🛑 Emparejamiento rechazado (405). No se reconectará automáticamente.`);
            } else if (statusCode === 401) {
                console.warn(`[WhatsApp-Baileys] 🔐 Sesión cerrada/inválida (401) para ${clientSlug}. Limpiando archivos para permitir re-vinculación.`);
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
        }
    });

    // 3. El Tubo Neural: Escuchar mensajes y enviarlos a nuestro Cerebro Central
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];

        // Solo ignoramos si no tienen cuerpo
        if (!msg.message) return;

        const isSentByMe = msg.key.fromMe;
        const senderId = msg.key.remoteJid;
        const pushName = isSentByMe ? 'Mí mismo' : (msg.pushName || 'Contacto Desconocido');
        const isGroup = senderId.includes('@g.us');
        if (senderId === 'status@broadcast') return;

        // === MULTI-MODAL: Detect text AND media ===
        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        let mediaDescription = '';

        const msgContent = msg.message;
        const hasImage = !!msgContent.imageMessage;
        const hasAudio = !!(msgContent.audioMessage || msgContent.pttMessage);
        const hasDocument = !!msgContent.documentMessage;
        const hasVideo = !!msgContent.videoMessage;
        const hasSticker = !!msgContent.stickerMessage;

        // Caption from media messages
        if (!text) {
            text = msgContent.imageMessage?.caption
                || msgContent.videoMessage?.caption
                || msgContent.documentMessage?.caption
                || '';
        }

        try {
            if (hasImage) {
                // VISION: Download image → Groq Vision → text description
                const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const base64 = buffer.toString('base64');
                const mimeType = msgContent.imageMessage.mimetype || 'image/jpeg';

                try {
                    const Groq = (await import('groq-sdk')).default;
                    const groqVision = new Groq({ apiKey: process.env.GROQ_API_KEY });
                    const visionResp = await groqVision.chat.completions.create({
                        model: 'llama-3.2-90b-vision-preview',
                        messages: [{
                            role: 'user',
                            content: [
                                { type: 'text', text: 'Describe esta imagen de forma concisa en español. Incluye personas, objetos, texto visible, lugar y contexto. Máximo 3 frases.' },
                                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
                            ]
                        }],
                        max_tokens: 200,
                    });
                    mediaDescription = `[📷 Imagen: ${visionResp.choices[0].message.content}]`;
                    console.log(`[${clientSlug}] 📷 Imagen procesada: ${mediaDescription.slice(0, 80)}...`);
                } catch (e) {
                    console.warn(`[${clientSlug}] ⚠️ Vision error:`, e.message);
                    mediaDescription = '[📷 Imagen adjunta (no procesada)]';
                }

            } else if (hasAudio) {
                // AUDIO: Download → Groq Whisper transcription
                const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const mime = msgContent.audioMessage?.mimetype || msgContent.pttMessage?.mimetype || 'audio/ogg';
                const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'ogg';
                const tmpPath = `/tmp/audio_${Date.now()}.${ext}`;

                const fs = await import('fs/promises');
                await fs.writeFile(tmpPath, buffer);

                try {
                    const Groq = (await import('groq-sdk')).default;
                    const groqAudio = new Groq({ apiKey: process.env.GROQ_API_KEY });
                    const { createReadStream } = await import('fs');
                    const transcription = await groqAudio.audio.transcriptions.create({
                        file: createReadStream(tmpPath),
                        model: 'whisper-large-v3',
                        language: 'es',
                    });
                    mediaDescription = `[🎤 Audio: ${transcription.text}]`;
                    console.log(`[${clientSlug}] 🎤 Audio transcrito: ${transcription.text.slice(0, 80)}...`);
                } catch (e) {
                    console.warn(`[${clientSlug}] ⚠️ Transcription error:`, e.message);
                    mediaDescription = '[🎤 Audio adjunto (no transcrito)]';
                } finally {
                    fs.unlink(tmpPath).catch(() => { });
                }

            } else if (hasDocument) {
                // DOCUMENT: Download → parse PDF/Word/Excel
                const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const mime = msgContent.documentMessage.mimetype || '';
                const fileName = msgContent.documentMessage.fileName || 'doc';

                try {
                    let extractedText = '';

                    if (mime.includes('pdf')) {
                        const { createRequire } = await import('module');
                        const require = createRequire(import.meta.url);
                        const pdf = require('pdf-parse');
                        const pdfData = await pdf(buffer);
                        extractedText = pdfData.text.slice(0, 3000);
                    } else if (mime.includes('wordprocessing') || mime.includes('docx') || fileName.endsWith('.docx')) {
                        const mammoth = (await import('mammoth')).default;
                        const result = await mammoth.extractRawText({ buffer });
                        extractedText = result.value.slice(0, 3000);
                    } else if (mime.includes('spreadsheet') || mime.includes('excel') || fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
                        const xlsx = await import('xlsx');
                        const workbook = xlsx.read(buffer, { type: 'buffer' });
                        const sheetName = workbook.SheetNames[0];
                        const sheet = workbook.Sheets[sheetName];
                        extractedText = xlsx.utils.sheet_to_csv(sheet).slice(0, 3000);
                    } else {
                        extractedText = `(Documento tipo ${mime}, ${buffer.length} bytes)`;
                    }

                    mediaDescription = `[📄 ${fileName}: ${extractedText}]`;
                    console.log(`[${clientSlug}] 📄 Documento procesado: ${fileName} (${extractedText.length} chars)`);
                } catch (e) {
                    console.warn(`[${clientSlug}] ⚠️ Document parse error:`, e.message);
                    mediaDescription = `[📄 Documento adjunto: ${fileName} (no procesado)]`;
                }

            } else if (hasVideo) {
                mediaDescription = '[🎬 Video adjunto]';
            } else if (hasSticker) {
                mediaDescription = '[🏷️ Sticker]';
            }
        } catch (mediaErr) {
            console.warn(`[${clientSlug}] ⚠️ Media processing error:`, mediaErr.message);
        }

        // Combine text + media description
        const finalText = [mediaDescription, text].filter(Boolean).join(' ');
        if (!finalText) return; // Nothing to process

        console.log(`[${clientSlug} - ${isSentByMe ? 'Enviado' : 'Recibido'}]: ${finalText.slice(0, 100)} (de ${pushName}${isGroup ? ' en grupo' : ''})`);

        const incomingEvent = {
            clientId: clientId,
            clientSlug: clientSlug,
            channel: 'whatsapp',
            senderId: senderId,
            text: finalText,
            isSentByMe: isSentByMe,
            metadata: {
                pushName: pushName,
                isGroup: isGroup,
                groupName: isGroup ? 'Grupo de WhatsApp' : null,
                hasMedia: !!(hasImage || hasAudio || hasDocument || hasVideo),
                mediaType: hasImage ? 'image' : hasAudio ? 'audio' : hasDocument ? 'document' : hasVideo ? 'video' : null,
                avatarUrl: await (async () => {
                    const cacheKey = `${clientId}:${senderId}`;
                    const cached = profilePicCache.get(cacheKey);
                    if (cached && (Date.now() - cached.timestamp < 3600000)) {
                        return cached.url;
                    }
                    try {
                        const url = await sock.profilePictureUrl(senderId, 'image');
                        profilePicCache.set(cacheKey, { url, timestamp: Date.now() });
                        return url;
                    } catch (e) {
                        return null;
                    }
                })()
            }
        };

        const aiReply = await processMessage(incomingEvent);

        if (aiReply && !isSentByMe) {
            await sock.sendMessage(senderId, { text: aiReply });
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
            // Wait for the websocket to physically connect (increased for stability)
            console.log(`[WhatsApp-Baileys] ⏳ Esperando conexión WSS para ${clientSlug}...`);
            await new Promise(r => setTimeout(r, 8000));

            if (sock.ws?.readyState !== 1) { // 1 = OPEN
                console.warn(`[WhatsApp-Baileys] ⚠️ WS state is ${sock.ws?.readyState} for ${clientSlug}.`);
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
