import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from '../utils/whatsapp_db_auth.mjs';
import pino from 'pino';
import fs from 'fs/promises';
import { Worker } from 'bullmq';
import { incomingQueue, outgoingQueue } from '../config/queues.mjs';
import redisClient from '../config/redis.mjs';
import groq from '../services/groq.mjs';
import { resolveIdentity } from '../skills/whatsapp_contacts.mjs';
import { discoverWhatsAppGroup } from '../skills/whatsapp_groups.mjs';
import supabase from '../config/supabase.mjs';
import crypto from 'node:crypto';
import { fallbackNameFromRemoteId, looksLikeBotText, pickBestHumanName } from '../utils/message_guard.mjs';
import {
    buildRawMessageRecord,
    buildWhatsAppDownloadableMessage,
    extractMediaFilename,
    extractMediaMimeType,
    extractWhatsAppMediaPayload,
    isPlaceholderOnlyText,
    looksLikeWhatsAppChannel,
    normalizeUuid
} from '../services/raw_message_ingest.service.mjs';
import { enrichMediaFile } from '../services/media_enrichment.service.mjs';

function toIsoOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (typeof value === 'number') {
        const millis = value > 1e12 ? value : value * 1000;
        const parsed = new Date(millis);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    if (typeof value === 'object') {
        const candidate = Number(value.low ?? value.high ?? value.value ?? value.toString?.());
        if (Number.isFinite(candidate)) {
            const millis = candidate > 1e12 ? candidate : candidate * 1000;
            const parsed = new Date(millis);
            return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
        }
    }
    return null;
}

function resolveWhatsAppMessageTimestamp(messageTimestamp, fallbackIso = null) {
    return toIsoOrNull(messageTimestamp) || fallbackIso || new Date().toISOString();
}

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

const OUTBOUND_AI_TTL_SECONDS = 24 * 60 * 60;

function createMessageFingerprint(text) {
    return crypto.createHash('sha1').update(String(text || '').trim()).digest('hex');
}

async function rememberTrackedOutboundMessage(clientId, remoteId, text, metadata = {}) {
    if (!redisClient || !text) return;

    const fingerprint = createMessageFingerprint(text);
    const key = `wa:outbound_ai:${clientId}:${remoteId}:${fingerprint}`;
    await redisClient.set(key, JSON.stringify({
        trackedAt: new Date().toISOString(),
        ...metadata
    }), { EX: OUTBOUND_AI_TTL_SECONDS });
}

async function consumeTrackedOutboundMessage(clientId, remoteId, text) {
    if (!redisClient || !text) return null;

    const fingerprint = createMessageFingerprint(text);
    const key = `wa:outbound_ai:${clientId}:${remoteId}:${fingerprint}`;
    const payload = await redisClient.get(key);
    if (!payload) return null;

    await redisClient.del(key);
    try {
        return JSON.parse(payload);
    } catch (e) {
        return { generated_by: 'core_engine', exclude_from_memory: true };
    }
}

async function syncAssistantMessageId(clientId, remoteId, logicalText, sentMessageId, generatedBy = 'core_engine', sentText = null) {
    if (!logicalText || !sentMessageId) return;

    const { data: rows, error } = await supabase
        .from('raw_messages')
        .select('id, metadata')
        .eq('client_id', clientId)
        .eq('remote_id', remoteId)
        .eq('sender_role', 'assistant')
        .eq('content', logicalText)
        .order('created_at', { ascending: false })
        .limit(1);

    if (error || !rows?.length) return;

    const row = rows[0];
    const nextMetadata = {
        ...(row.metadata || {}),
        msgId: sentMessageId,
        channel: 'whatsapp',
        generated_by: generatedBy,
        exclude_from_memory: true,
        outbound_text: sentText || logicalText
    };

    await supabase
        .from('raw_messages')
        .update({
            metadata: nextMetadata,
            processed: true,
            source_message_id: sentMessageId,
            channel: 'whatsapp',
            delivery_status: 'sent'
        })
        .eq('id', row.id);
}

async function resolveCachedIdentityName(identityCache, clientId, jid, pushName = null) {
    const cacheKey = `${jid || 'unknown'}::${pushName || ''}`;
    if (identityCache.has(cacheKey)) {
        return identityCache.get(cacheKey);
    }

    let resolvedName = null;
    try {
        const identity = await resolveIdentity(clientId, jid, pushName);
        resolvedName = pickBestHumanName(
            identity?.name,
            pushName,
            fallbackNameFromRemoteId(jid)
        );
    } catch (e) {
        resolvedName = pickBestHumanName(pushName, fallbackNameFromRemoteId(jid));
    }

    identityCache.set(cacheKey, resolvedName);
    return resolvedName;
}

export const activeSessions = new Map();
export const lastActivity = new Map(); // Novedad: Registro de última actividad
console.log("🚀🚀🚀 WHATSAPP.MJS LOADED AT " + new Date().toISOString());
export const qrCodes = new Map();
export const pairingCodes = new Map();
const startingSessions = new Set();
const reconnectAttempts = new Map(); // Track reconnect attempts for exponential backoff

// Cache para evitar pedir la foto de perfil en cada mensaje (válida por 1 hora)
const profilePicCache = new Map();
const INLINE_MEDIA_ENRICHMENT_CONCURRENCY = 2;
const HISTORICAL_MEDIA_BACKFILL_LIMIT = 200;
const HISTORICAL_MEDIA_BACKFILL_MIN_INTERVAL_MS = 5 * 60 * 1000;
const inlineMediaEnrichmentQueue = [];
const inlineMediaEnrichmentQueuedIds = new Set();
const historicalMediaBackfillActive = new Set();
const historicalMediaBackfillLastAttempt = new Map();
let inlineMediaEnrichmentActive = 0;

function normalizeSemanticSeed(value = '') {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized || isPlaceholderOnlyText(normalized)) return '';
    return normalized;
}

function mergeMediaSemanticText(existingText = '', derivedText = '', mediaType = '') {
    const base = normalizeSemanticSeed(existingText);
    const derived = normalizeSemanticSeed(derivedText);
    if (!base && !derived) return '';
    if (!base) return derived;
    if (!derived) return base;
    if (base.toLowerCase() === derived.toLowerCase()) return base;

    const label = mediaType === 'audio'
        ? 'Transcripcion'
        : mediaType === 'image'
            ? 'Descripcion visual'
            : mediaType === 'document'
                ? 'Contenido del documento'
                : 'Descripcion';

    return `${base}\n${label}: ${derived}`.trim();
}

function fileExtensionForMedia(mediaType = '', mimeType = '') {
    const normalizedMime = String(mimeType || '').toLowerCase();
    if (normalizedMime.includes('ogg')) return '.ogg';
    if (normalizedMime.includes('mpeg')) return '.mp3';
    if (normalizedMime.includes('wav')) return '.wav';
    if (normalizedMime.includes('png')) return '.png';
    if (normalizedMime.includes('jpeg') || normalizedMime.includes('jpg')) return '.jpg';
    if (normalizedMime.includes('webp')) return '.webp';
    if (normalizedMime.includes('pdf')) return '.pdf';
    if (normalizedMime.includes('word')) return '.docx';
    if (normalizedMime.includes('sheet')) return '.xlsx';

    if (mediaType === 'audio') return '.ogg';
    if (mediaType === 'image') return '.jpg';
    if (mediaType === 'video') return '.mp4';
    if (mediaType === 'document') return '.bin';
    return '.bin';
}

function shouldInlineEnrichMedia(mediaType = '') {
    return ['audio', 'image', 'document'].includes(String(mediaType || '').trim().toLowerCase());
}

async function updateRawMessageEnrichment(rawMessageId, patch = {}, metadataPatch = {}) {
    const { data: row, error } = await supabase
        .from('raw_messages')
        .select('metadata, processed, semantic_text')
        .eq('id', rawMessageId)
        .maybeSingle();

    if (error) throw error;

    const metadata = {
        ...(row?.metadata || {}),
        ...(metadataPatch || {})
    };

    const previousSemantic = normalizeSemanticSeed(row?.semantic_text || row?.metadata?.semantic_text || '');
    const nextSemantic = normalizeSemanticSeed(
        patch?.semantic_text
        ?? metadataPatch?.semantic_text
        ?? row?.semantic_text
        ?? row?.metadata?.semantic_text
        ?? ''
    );
    const shouldRequeueProcessing = Boolean(nextSemantic)
        && row?.processed === true
        && !metadata?.exclude_from_memory
        && previousSemantic.toLowerCase() !== nextSemantic.toLowerCase();

    const updatePayload = {
        ...patch,
        metadata
    };
    if (shouldRequeueProcessing) {
        updatePayload.processed = false;
    }

    const { error: updateError } = await supabase
        .from('raw_messages')
        .update(updatePayload)
        .eq('id', rawMessageId);

    if (updateError) throw updateError;
    return { requeued: shouldRequeueProcessing };
}

async function runInlineMediaEnrichment({ clientId, rawMessage, downloadableMessage, sock }) {
    if (!rawMessage?.id || !rawMessage?.media_type || !downloadableMessage?.message) return;

    const rawMessageId = rawMessage.id;
    const baseSemantic = rawMessage.semantic_text || rawMessage.media_caption || '';
    const shouldEnrichInline = shouldInlineEnrichMedia(rawMessage.media_type);

    if (!shouldEnrichInline) {
        const fallbackSemantic = normalizeSemanticSeed(baseSemantic);
        await updateRawMessageEnrichment(rawMessageId, {
            semantic_text: fallbackSemantic || null,
            content_ready: Boolean(fallbackSemantic),
            media_status: 'captured',
            enrichment_status: 'unsupported'
        }, {
            semantic_text: fallbackSemantic || null,
            media_status: 'captured',
            enrichment_status: 'unsupported',
            last_enriched_at: new Date().toISOString()
        });

        if (fallbackSemantic && !rawMessage.metadata?.exclude_from_memory) {
            await triggerMemoryTimer(clientId);
        }
        return;
    }

    await updateRawMessageEnrichment(rawMessageId, {
        media_status: 'processing',
        enrichment_status: 'processing'
    }, {
        media_status: 'processing',
        enrichment_status: 'processing'
    });

    let tempFilePath;
    try {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(downloadableMessage, 'buffer', {}, {
            logger: sock.logger,
            reuploadRequest: sock.updateMediaMessage
        });

        const ext = fileExtensionForMedia(rawMessage.media_type, rawMessage.media_mime_type);
        const tempFileName = `${clientId}_${rawMessage.source_message_id || rawMessage.id}_${crypto.randomBytes(4).toString('hex')}${ext}`;
        tempFilePath = `./uploads/${tempFileName}`;

        await fs.mkdir('./uploads', { recursive: true });
        await fs.writeFile(tempFilePath, buffer);

        const enrichment = await enrichMediaFile({
            filePath: tempFilePath,
            mediaType: rawMessage.media_type,
            mimeType: rawMessage.media_mime_type,
            originalName: rawMessage.metadata?.mediaFilename || rawMessage.metadata?.filename || tempFileName
        });

        const mergedSemanticText = mergeMediaSemanticText(baseSemantic, enrichment.semanticText, rawMessage.media_type);

        await updateRawMessageEnrichment(rawMessageId, {
            semantic_text: mergedSemanticText || null,
            content_ready: Boolean(mergedSemanticText),
            media_status: mergedSemanticText ? 'enriched' : 'failed',
            enrichment_status: mergedSemanticText ? 'ready' : 'failed'
        }, {
            semantic_text: mergedSemanticText || null,
            media_status: mergedSemanticText ? 'enriched' : 'failed',
            enrichment_status: mergedSemanticText ? 'ready' : 'failed',
            enrichment_kind: enrichment.enrichmentKind || null,
            last_enriched_at: new Date().toISOString()
        });

        if (mergedSemanticText && !rawMessage.metadata?.exclude_from_memory) {
            await triggerMemoryTimer(clientId);
        }
    } catch (error) {
        const fallbackSemantic = normalizeSemanticSeed(baseSemantic);
        await updateRawMessageEnrichment(rawMessageId, {
            semantic_text: fallbackSemantic || null,
            content_ready: Boolean(fallbackSemantic),
            media_status: 'failed',
            enrichment_status: 'failed'
        }, {
            semantic_text: fallbackSemantic || null,
            media_status: 'failed',
            enrichment_status: 'failed',
            enrichment_error: error.message,
            last_enriched_at: new Date().toISOString()
        }).catch(() => { });
        console.warn(`[WhatsApp Media] Error enriqueciendo ${rawMessageId}: ${error.message}`);
        if (fallbackSemantic && !rawMessage.metadata?.exclude_from_memory) {
            await triggerMemoryTimer(clientId);
        }
    } finally {
        if (tempFilePath) {
            await fs.unlink(tempFilePath).catch(() => { });
        }
    }
}

function drainInlineMediaEnrichmentQueue() {
    while (inlineMediaEnrichmentActive < INLINE_MEDIA_ENRICHMENT_CONCURRENCY && inlineMediaEnrichmentQueue.length > 0) {
        const job = inlineMediaEnrichmentQueue.shift();
        inlineMediaEnrichmentActive += 1;

        Promise.resolve()
            .then(() => runInlineMediaEnrichment(job))
            .catch(error => {
                console.warn(`[WhatsApp Media] Cola inline falló: ${error.message}`);
            })
            .finally(() => {
                if (job?.rawMessage?.id) {
                    inlineMediaEnrichmentQueuedIds.delete(job.rawMessage.id);
                }
                inlineMediaEnrichmentActive = Math.max(0, inlineMediaEnrichmentActive - 1);
                drainInlineMediaEnrichmentQueue();
            });
    }
}

function scheduleInlineMediaEnrichment(job) {
    const rawMessageId = job?.rawMessage?.id;
    if (rawMessageId && inlineMediaEnrichmentQueuedIds.has(rawMessageId)) return;
    if (rawMessageId) {
        inlineMediaEnrichmentQueuedIds.add(rawMessageId);
    }
    inlineMediaEnrichmentQueue.push(job);
    drainInlineMediaEnrichmentQueue();
}

async function backfillHistoricalMediaForClient(clientId, clientSlug, sock) {
    const backfillKey = String(clientId);
    if (historicalMediaBackfillActive.has(backfillKey)) return;
    historicalMediaBackfillActive.add(backfillKey);

    try {
        const { data: rows, error } = await supabase
            .from('raw_messages')
            .select('id, client_id, remote_id, sender_role, source_message_id, participant_jid, semantic_text, media_caption, media_type, media_mime_type, content_ready, processed, enrichment_status, channel, metadata')
            .eq('client_id', clientId)
            .eq('has_media', true)
            .or('content_ready.eq.false,enrichment_status.eq.pending,enrichment_status.eq.failed')
            .order('created_at', { ascending: true })
            .limit(HISTORICAL_MEDIA_BACKFILL_LIMIT);

        if (error) throw error;

        const candidates = (rows || []).filter(row => {
            if (!row?.id || !row?.source_message_id || !row?.metadata?.mediaPayload) return false;
            return looksLikeWhatsAppChannel(row.channel, row.remote_id, row.participant_jid || row.metadata?.participantJid);
        });

        if (!candidates.length) {
            console.log(`[${clientSlug}] ðŸŽ¯ No hay media histÃ³rica pendiente para rehidratar.`);
            return;
        }

        console.log(`[${clientSlug}] ðŸ§ª Rehidratando ${candidates.length} raws multimedia histÃ³ricos pendientes...`);

        for (const row of candidates) {
            scheduleInlineMediaEnrichment({
                clientId,
                sock,
                rawMessage: row,
                downloadableMessage: buildWhatsAppDownloadableMessage({
                    remoteJid: row.remote_id,
                    messageId: row.source_message_id,
                    fromMe: row.sender_role === 'Yo' || row.sender_role === 'assistant',
                    participantJid: row.participant_jid || row.metadata?.participantJid || null,
                    mediaPayload: row.metadata?.mediaPayload || null
                })
            });
        }
    } catch (error) {
        console.warn(`[${clientSlug}] âš ï¸ Backfill de media histÃ³rica fallÃ³: ${error.message}`);
    } finally {
        historicalMediaBackfillActive.delete(backfillKey);
    }
}

function maybeScheduleHistoricalMediaBackfill(clientId, clientSlug, sock, delayMs = 12000) {
    const backfillKey = String(clientId);
    const lastAttempt = historicalMediaBackfillLastAttempt.get(backfillKey) || 0;
    if (Date.now() - lastAttempt < HISTORICAL_MEDIA_BACKFILL_MIN_INTERVAL_MS) return;
    historicalMediaBackfillLastAttempt.set(backfillKey, Date.now());
    setTimeout(() => {
        backfillHistoricalMediaForClient(clientId, clientSlug, sock).catch(error => {
            console.warn(`[${clientSlug}] âš ï¸ No se pudo lanzar el backfill multimedia: ${error.message}`);
        });
    }, delayMs);
}

// --- HIBERNACIÓN DE SESIONES (WAKE/SLEEP) ---
const MAX_IDLE_TIME_MS = 48 * 60 * 60 * 1000; // 48 horas de inactividad

setInterval(async () => {
    const now = Date.now();
    for (const [sessionKey, sock] of activeSessions.entries()) {
        const lastAct = lastActivity.get(sessionKey) || 0;

        // Si han pasado más de 48h desde el último mensaje y el socket sigue abierto
        if (now - lastAct > MAX_IDLE_TIME_MS && sock) {
            console.log(`💤 [Hibernación] ${sessionKey} inactivo por 48h. Cerrando socket para liberar RAM.`);
            try {
                // End the socket cleanly but don't delete auth data (NOT a logout)
                sock.end(undefined);
            } catch (e) {
                console.warn(`[Hibernación] Error cerrando socket de ${sessionKey}:`, e.message);
            }
            activeSessions.delete(sessionKey);
            lastActivity.delete(sessionKey);
        }
    }
}, 60 * 60 * 1000); // Check every hour
// ---------------------------------------------
// Helper robusto para extraer contenido de mensajes anidados (ephemeral, viewOnce, etc)
const extractMessageContent = (m) => {
    if (!m) return '';
    if (typeof m === 'string') return m;

    // Si m es el objeto msg.message completo, intentamos sacar el contenido real
    // Desglosar capas de envoltorio (Ephemeral, ViewOnce, Edited, Protocol)
    let content = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.editedMessage?.message || m;

    // Si sigue habiendo un envoltorio de editedMessage dentro (visto en algunos casos)
    if (content.editedMessage?.message) content = content.editedMessage.message;

    // Si es un messageContextInfo, bajar un nivel
    if (content.messageContextInfo?.message) content = content.messageContextInfo.message;

    if (content.conversation) return content.conversation;
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
    if (content.imageMessage?.caption) return content.imageMessage.caption;
    if (content.videoMessage?.caption) return content.videoMessage.caption;
    if (content.documentMessage?.caption) return content.documentMessage.caption;
    if (content.buttonsResponseMessage?.selectedButtonId) return content.buttonsResponseMessage.selectedButtonId;
    if (content.listResponseMessage?.singleSelectReply?.selectedRowId) return content.listResponseMessage.singleSelectReply.selectedRowId;
    if (content.templateButtonReplyMessage?.selectedId) return content.templateButtonReplyMessage.selectedId;
    if (content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) return content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson;

    // Protocol Message (History sync uses this)
    if (content.protocolMessage) {
        // Si es una edición
        if (content.protocolMessage.editedMessage) return extractMessageContent(content.protocolMessage.editedMessage);
        // Silenciamos otros tipos de protocolo para no ensuciar logs, pero no son texto
        return '';
    }

    // Recursión para mensajes citados si no hay texto arriba
    if (content.quotedMessage) return extractMessageContent(content.quotedMessage);

    return '';
};

/**
 * Escudo Anti-Spam (Rate Limiting)
 * Permite un máximo de 15 mensajes por minuto por usuario.
 */
async function checkRateLimit(clientId, senderId) {
    if (!redisClient) return false;
    const limit = 15;
    const ttl = 60; // 60 segundos

    try {
        const key = `ratelimit:${clientId}:${senderId}`;
        const currentCount = await redisClient.incr(key);

        if (currentCount === 1) {
            await redisClient.expire(key, ttl);
        }

        if (currentCount > limit) {
            console.warn(`🛡️ [Anti-Spam] Bloqueando a ${senderId}. Límite excedido (${currentCount}/${limit} msgs/min).`);
            return true; // Es spam
        }
        return false;
    } catch (e) {
        console.warn('⚠️ [Rate Limiter] Error en Redis:', e.message);
        return false; // Ante la duda, dejamos pasar para no romper el servicio
    }
}

/**
 * Inicia una sesión WebSocket pura para WhatsApp (Consumo: ~10MB RAM)
 */
export async function startWhatsAppClient(clientId, clientSlug, phoneNumber = null) {
    const normalizedClientId = normalizeUuid(clientId, null);
    if (!normalizedClientId) {
        console.error(`[WhatsApp-Baileys] Invalid clientId for ${clientSlug}:`, clientId);
        return { status: 'error', message: 'client_id inválido para iniciar WhatsApp.' };
    }

    clientId = normalizedClientId;
    const sessionKey = normalizedClientId;
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
                pairingCodes.set(sessionKey, code);
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
        browser: ['Mac OS', 'Chrome', '121.0.6167.85'],
        syncFullHistory: true, // Re-activado para capturar mensajes no leídos (Inbox)
        markOnlineOnConnect: true,
        qrTimeout: 120_000,
        logger: pino({ level: 'error' }) // Solo errores críticos de Baileys
    });

    // Debug: Capturar errores de eventos globales
    sock.ev.on('error', (err) => {
        console.error(`[${clientSlug}] 🔴 Error de Baileys Event:`, err);
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
            pairingCodes.delete(sessionKey);
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
            pairingCodes.delete(sessionKey);
            startingSessions.delete(sessionKey);
            reconnectAttempts.delete(sessionKey); // Reset attempts on successful connection

            // 🔑 CRITICAL: Deeply request message history and contacts sync
            setTimeout(async () => {
                const results = await Promise.allSettled([
                    (async () => {
                        console.log(`[${clientSlug}] 📬 Solicitando historial profundo (10000 msgs)...`);
                        await sock.fetchMessageHistory(10000, { remoteJid: '0@s.whatsapp.net', id: '' }, 0);
                        console.log(`[${clientSlug}] ✅ Historial solicitado.`);
                    })(),
                    (async () => {
                        console.log(`[${clientSlug}] 📖 Sincronizando agenda de contactos...`);
                        await sock.resyncAppState(['critical_unblock_low', 'regular_low']);
                        console.log(`[${clientSlug}] ✅ Resync de agenda solicitado.`);
                    })()
                ]);

                results.forEach((res, i) => {
                    if (res.status === 'rejected') {
                        console.warn(`[${clientSlug}] ⚠️ Tarea post-conexión ${i} falló:`, res.reason?.message);
                    }
                });

                // 🤖 ASISTENTE IA: Enviar mensaje de bienvenida al self-chat
                // Esto crea/surfea el chat "Mensajes a ti mismo" en WhatsApp
                try {
                    const myJid = sock.user?.id;
                    if (myJid) {
                        // Normalizar JID (quitar device suffix) → "34667789805@s.whatsapp.net"
                        const myNormalizedJid = myJid.split(':')[0] + '@s.whatsapp.net';

                        // Verificar si ya enviamos el mensaje de bienvenida recientemente (1x por sesión)
                        const welcomeKey = `ai_welcome_sent:${clientId}`;
                        const redisCheck = redisClient ? await redisClient.get(welcomeKey) : null;

                        if (!redisCheck) {
                            const welcomeText = `🤖 *OpenClaw AI — Tu Asistente Personal*\n\n¡Hola! Soy tu asistente de inteligencia artificial. Puedes preguntarme cualquier cosa sobre tus contactos, conversaciones y recuerdos.\n\n*Ejemplos:*\n• _¿Quién es Víctor?_\n• _¿De qué hablé con María la semana pasada?_\n• _¿Qué sé sobre el proyecto X?_\n\nTodo lo que me preguntes será procesado usando tu base de conocimiento personal (GraphRAG + Memoria Vectorial).\n\n_Escribe aquí tu primera pregunta_ 👇`;
                            await rememberTrackedOutboundMessage(clientId, myNormalizedJid, welcomeText, {
                                generated_by: 'welcome_message',
                                exclude_from_memory: true
                            });
                            console.log(`[🤖 Self-Chat AI] Enviando mensaje de bienvenida a ${myNormalizedJid}...`);
                            await sock.sendMessage(myNormalizedJid, {
                                text: `🤖 *OpenClaw AI — Tu Asistente Personal*\n\n¡Hola! Soy tu asistente de inteligencia artificial. Puedes preguntarme cualquier cosa sobre tus contactos, conversaciones y recuerdos.\n\n*Ejemplos:*\n• _¿Quién es Víctor?_\n• _¿De qué hablé con María la semana pasada?_\n• _¿Qué sé sobre el proyecto X?_\n\nTodo lo que me preguntes será procesado usando tu base de conocimiento personal (GraphRAG + Memoria Vectorial).\n\n_Escribe aquí tu primera pregunta_ 👇`
                            });
                            console.log(`[🤖 Self-Chat AI] ✅ Mensaje de bienvenida enviado.`);

                            // Marcar como enviado por 24h para no repetir
                            if (redisClient) {
                                await redisClient.set(welcomeKey, '1', { EX: 86400 });
                            }
                        }
                    }
                } catch (welcomeErr) {
                    console.warn(`[🤖 Self-Chat AI] ⚠️ Error enviando bienvenida:`, welcomeErr.message);
                }
                setTimeout(() => {
                    backfillHistoricalMediaForClient(clientId, clientSlug, sock).catch(error => {
                        console.warn(`[${clientSlug}] âš ï¸ No se pudo lanzar el backfill multimedia: ${error.message}`);
                    });
                }, 12000);
                maybeScheduleHistoricalMediaBackfill(clientId, clientSlug, sock, 12000);
            }, 6000); // 6s to ensure session is fully ready
        }
    });

    // Helper: Sincronización de Agenda (Nombres + Avatares)
    const syncContacts = async (contacts) => {
        if (!redisClient || !contacts?.length) return;
        try {
            console.log(`[${clientSlug}] 📖 Sincronizando agenda (${contacts.length} contactos)...`);

            // FASE 1: Guardar NOMBRES inteligentemente
            for (const contact of contacts) {
                if (!contact.id) continue;
                const key = `contacts:${clientId}:${contact.id}`;

                // Intentamos rescatar lo que ya hay para no pisar nombres de agenda con pushnames
                const existing = await redisClient.get(key);
                const parsedExisting = existing ? JSON.parse(existing) : null;

                const newName = contact.name || contact.notify || (parsedExisting ? parsedExisting.name : null);

                // Solo actualizamos si tenemos un nombre mejor o si no existía
                // Si el existente tiene .name (agenda) y el nuevo solo tiene .notify (pushname), ignoramos el cambio de nombre
                const contactData = {
                    name: (parsedExisting?.name && !contact.name) ? parsedExisting.name : newName,
                    avatar: parsedExisting?.avatar || null,
                    updatedAt: Date.now()
                };

                await redisClient.set(key, JSON.stringify(contactData), { EX: 7 * 24 * 60 * 60 });
            }

            // FASE 2: Avatares en BACKGROUND
            setTimeout(async () => {
                let fetched = 0;
                for (const contact of contacts) {
                    if (!contact.id || !contact.id.endsWith('@s.whatsapp.net')) continue;
                    try {
                        const avatarUrl = await sock.profilePictureUrl(contact.id, 'image').catch(() => null);
                        if (avatarUrl) {
                            const key = `contacts:${clientId}:${contact.id}`;
                            const existing = await redisClient.get(key);
                            const parsed = existing ? JSON.parse(existing) : {};
                            parsed.avatar = avatarUrl;
                            await redisClient.set(key, JSON.stringify(parsed), { EX: 7 * 24 * 60 * 60 });
                            fetched++;
                        }
                    } catch (e) { }
                    await new Promise(r => setTimeout(r, 200));
                }
                if (fetched > 0) console.log(`[${clientSlug}] 📸 Avatares actualizados: ${fetched}/${contacts.length}`);
            }, 20000);
        } catch (e) {
            console.warn(`[${clientSlug}] ⚠️ Error en syncContacts:`, e.message);
        }
    };

    // 2.5 Sincronización de Agenda (Eventos Incrementales)
    sock.ev.on('contacts.upsert', async (contacts) => {
        await syncContacts(contacts);
    });

    // 3.1 Sincronización de Historial — Ahora extrae Agenda y Grupos pero ignora mensajes
    sock.ev.on('messaging-history.set', async ({ messages, contacts, chats }) => {
        try {
            console.log(`[${clientSlug}] 📚 Historial recibido: ${messages?.length || 0} msgs, ${contacts?.length || 0} contactos, ${chats?.length || 0} chats.`);
            if (chats?.length > 0) {
                const unreadChats = chats.filter(c => c.unreadCount > 0);
                console.log(`[${clientSlug}] 📂 Chats con no leídos: ${unreadChats.length} de ${chats.length}`);
                if (unreadChats.length > 0) {
                    console.log(`[${clientSlug}] 📝 JIDs no leídos: ${unreadChats.map(c => c.id).join(', ')}`);
                }
            }

            // Sincronizar agenda inicial
            if (contacts) await syncContacts(contacts);

            const { data: existingRows } = await supabase
                .from('raw_messages')
                .select('id, metadata, source_message_id')
                .eq('client_id', clientId);
            const knownRowsByMsgId = new Map(
                (existingRows || [])
                    .map(row => [row.source_message_id || row.metadata?.msgId, row])
                    .filter(([msgId]) => Boolean(msgId))
            );

            // Sincronizar metadatos de grupos iniciales
            if (chats && redisClient) {
                for (const chat of chats) {
                    if (chat.id.endsWith('@g.us')) {
                        const groupCacheKey = `group_meta:${clientId}:${chat.id}`;
                        const hasCachedMeta = await redisClient.get(groupCacheKey);
                        if (!hasCachedMeta) {
                            try {
                                const metadata = await sock.groupMetadata(chat.id).catch(() => null);
                                if (metadata) {
                                    let groupAvatar = await sock.profilePictureUrl(chat.id, 'image').catch(() => null);
                                    const simplifiedMeta = {
                                        id: metadata.id,
                                        subject: metadata.subject,
                                        avatar: groupAvatar,
                                        owner: metadata.owner || 'Unknown',
                                        creation: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
                                        desc: metadata.desc || 'No description',
                                        participantsCount: metadata.participants?.length || 0
                                    };
                                    await redisClient.set(groupCacheKey, JSON.stringify(simplifiedMeta), { EX: 86400 });
                                }
                            } catch (e) { }
                        }
                    }
                }
            }

            // --- 🚀 NOVEDAD: Ingesta Masiva de Historial (Memoria + Inbox) ---
            console.log(`[${clientSlug}] 🔍 Evaluando ${chats.length} chats del historial masivo...`);
            let totalHistorySaved = 0;
            let unreadsTagged = 0;
            let messagesToInsert = [];
            const historyMediaJobsById = new Map();
            const historyIdentityCache = new Map();
            let totalHistoryUpgraded = 0;

            for (const chat of chats) {
                const chatMessages = (messages || []).filter(m => m.key.remoteJid === chat.id);
                if (chatMessages.length === 0) continue;

                // Ordenar por timestamp para procesar en orden cronológico
                chatMessages.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

                // Identificar cuáles mensajes son estrictamente los "no leídos" actuales
                const unreadMsgs = chat.unreadCount > 0 ? chatMessages.slice(-chat.unreadCount) : [];
                const unreadMsgIds = new Set(unreadMsgs.map(m => m.key.id));

                for (const msg of chatMessages) {
                    if (msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) continue;

                    const text = extractMessageContent(msg.message);
                    if (!text && !msg.message?.imageMessage && !msg.message?.audioMessage && !msg.message?.videoMessage && !msg.message?.documentMessage && !msg.message?.stickerMessage) continue;

                    const isSentByMe = msg.key.fromMe;
                    const isUnread = unreadMsgIds.has(msg.key.id);
                    const quotedMessageId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null;
                    const pushName = msg.pushName || null;
                    const participantJid = chat.id.endsWith('@g.us') ? msg.key.participant : chat.id;
                    const canonicalSenderName = isSentByMe
                        ? 'Yo'
                        : await resolveCachedIdentityName(historyIdentityCache, clientId, participantJid, pushName);
                    const conversationName = chat.name || chat.id;
                    const mediaPayload = extractWhatsAppMediaPayload(msg.message);
                    const messageTimestampIso = resolveWhatsAppMessageTimestamp(msg.messageTimestamp);
                    const historyContent = text || '';
                    const excludeFromHistoryMemory = isSentByMe && looksLikeBotText(historyContent);
                    const existingRow = knownRowsByMsgId.get(msg.key.id) || null;
                    const shouldUpgradeExistingRow = Boolean(existingRow)
                        && Boolean(mediaPayload)
                        && !existingRow?.metadata?.mediaPayload;
                    if (existingRow && !shouldUpgradeExistingRow) continue;

                    const rawRecord = buildRawMessageRecord({
                        id: shouldUpgradeExistingRow ? existingRow.id : undefined,
                        clientId,
                        senderRole: isSentByMe
                            ? 'user_sent'
                            : (canonicalSenderName || fallbackNameFromRemoteId(participantJid) || 'Contacto'),
                        content: historyContent,
                        remoteId: chat.id,
                        createdAt: messageTimestampIso,
                        processed: excludeFromHistoryMemory,
                        channel: 'whatsapp',
                        sourceMessageId: msg.key.id,
                        participantJid,
                        canonicalSenderName: canonicalSenderName || fallbackNameFromRemoteId(participantJid) || null,
                        conversationName,
                        isGroup: chat.id.endsWith('@g.us'),
                        isHistory: true,
                        quotedMessageId,
                        pushName,
                        deliveryStatus: isSentByMe ? 'read' : 'sent',
                        mediaPayload,
                        mediaMimeType: extractMediaMimeType(mediaPayload),
                        mediaFilename: extractMediaFilename(mediaPayload, msg.key.id),
                        excludeFromMemory: excludeFromHistoryMemory,
                        metadata: {
                            ...(existingRow?.metadata || {}),
                            is_new_unread: isUnread
                        }
                    });

                    if (!rawRecord.client_id) {
                        console.warn(`[${clientSlug}] Omitiendo raw histórico ${msg.key.id}: client_id inválido.`);
                        continue;
                    }

                    messagesToInsert.push(rawRecord);
                    if (rawRecord.has_media) {
                        historyMediaJobsById.set(rawRecord.id, {
                            clientId,
                            rawMessage: rawRecord,
                            downloadableMessage: buildWhatsAppDownloadableMessage({
                                remoteJid: chat.id,
                                messageId: msg.key.id,
                                fromMe: isSentByMe,
                                participantJid,
                                mediaPayload
                            }),
                            sock
                        });
                    }

                    knownRowsByMsgId.set(msg.key.id, {
                        id: rawRecord.id,
                        source_message_id: rawRecord.source_message_id,
                        metadata: rawRecord.metadata
                    });
                    if (shouldUpgradeExistingRow) totalHistoryUpgraded++;
                    if (isUnread) unreadsTagged++;
                }
            }

            // Inserción Masiva por Lotes (Batch Insert) para evitar congestionar la Base de Datos
            if (messagesToInsert.length > 0) {
                console.log(`[${clientSlug}] 🚀 Iniciando inyección masiva en DB de ${messagesToInsert.length} mensajes...`);

                // Dividimos en lotes de 200 mensajes máximo por petición para evitar payload too large request limits de Supabase
                const BATCH_SIZE = 200;
                for (let i = 0; i < messagesToInsert.length; i += BATCH_SIZE) {
                    const batch = messagesToInsert.slice(i, i + BATCH_SIZE);
                    try {
                        const res = await supabase.from('raw_messages').upsert(batch, { onConflict: 'id' });
                        console.log(`[${clientSlug}] Lote ${i / BATCH_SIZE} Status: ${res.status} | Data: ${!!res.data} | Err: ${res.error?.message || 'none'}`);
                        if (!res.error) {
                            totalHistorySaved += batch.length;
                            for (const row of batch) {
                                const mediaJob = historyMediaJobsById.get(row.id);
                                if (mediaJob) scheduleInlineMediaEnrichment(mediaJob);
                            }
                        } else {
                            console.error(`[${clientSlug}] ❌ Fallo fatal (Lote ${i / BATCH_SIZE}):`, res.error.message);
                        }
                    } catch (insertErr) {
                        console.error(`[${clientSlug}] ❌ Excepción fatal (Lote ${i / BATCH_SIZE}):`, insertErr.message);
                    }
                }
            }

            if (totalHistorySaved > 0) {
                console.log(`[${clientSlug}] 🎉 Ingesta completada: ${totalHistorySaved} mensajes históricos en total. ${unreadsTagged} marcados como Inbox unread.`);
                await triggerMemoryTimer(clientId);
            }
        } catch (setErr) {
            console.error(`[${clientSlug}] ❌ Error procesando messaging-history.set:`, setErr.message);
        }
    });

    // 3. El Tubo Neural: Escuchar mensajes y enviarlos a nuestro Cerebro Central
    sock.ev.on('messages.upsert', async (m) => {
        console.log(`[${clientSlug}] 🔍 messages.upsert triggered. Type: ${m.type}, Count: ${m.messages?.length}`);

        maybeScheduleHistoricalMediaBackfill(clientId, clientSlug, sock, 4000);
        for (const msg of m.messages) {
            try {
                const textRaw = extractMessageContent(msg.message);

                // 🔑 CONTACT CACHING: Save sender's name to Redis when we see messages
                if (redisClient && msg.key && msg.pushName && !msg.key.fromMe) {
                    try {
                        const senderJid = msg.key.participant || msg.key.remoteJid;
                        if (senderJid && !senderJid.endsWith('@g.us') && !senderJid.endsWith('@broadcast')) {
                            const contactKey = `contacts:${clientId}:${senderJid}`;
                            const existing = await redisClient.get(contactKey);
                            if (!existing) {
                                const contactData = JSON.stringify({ name: msg.pushName, avatar: null });
                                await redisClient.set(contactKey, contactData);
                                console.log(`[${clientSlug}] 📇 Contacto cacheado desde mensaje: ${senderJid} -> "${msg.pushName}"`);
                            }
                        }
                    } catch (cacheErr) { }
                }

                if (!msg.message || (!textRaw && !msg.message.imageMessage && !msg.message.audioMessage && !msg.message.videoMessage && !msg.message.documentMessage && !msg.message.stickerMessage)) {
                    // Solo loguear si es el único mensaje o si es relevante
                    if (m.messages.length === 1) console.log(`[${clientSlug}] ℹ️ Mensaje sin contenido útil ignorado (msgId=${msg.key.id}).`);
                    continue;
                }

                console.log(`📩 [${clientSlug}] msgId=${msg.key.id} RECEIVED (Type: ${m.type})`);

                const isSentByMe = msg.key.fromMe;
                const senderId = msg.key.remoteJid;
                const participantJid = msg.key.participant || senderId; // Participant en grupos, remoteJid en privado
                const msgContent = msg.message;
                const isGroup = senderId.endsWith('@g.us');

                // EXTRAER NOMBRE REAL DE LA AGENDA (No el de WhatsApp público)
                let contactIdentity = null;
                if (!isSentByMe) {
                    const targetJid = isGroup ? participantJid : senderId;
                    contactIdentity = await resolveIdentity(clientId, targetJid, msg.pushName);
                }
                const pushName = pickBestHumanName(
                    contactIdentity?.name,
                    msg.pushName,
                    fallbackNameFromRemoteId(participantJid),
                    isSentByMe ? 'Yo' : 'Contacto'
                ) || (isSentByMe ? 'Yo' : 'Contacto');

                const hasImage = !!msgContent.imageMessage;
                const hasAudio = !!(msgContent.audioMessage || msgContent.pttMessage);
                const hasDocument = !!msgContent.documentMessage;
                const hasVideo = !!msgContent.videoMessage;
                const hasSticker = !!msgContent.stickerMessage;

                // 🛡️ [ANTI-SPAM] Only rate-limit real-time messages (type=notify), NOT history sync
                if (m.type === 'notify' && await checkRateLimit(clientId, senderId)) {
                    return; // Ignorar el mensaje silenciosamente (ahorra IA y DB)
                }

                // [SKILL: WhatsApp Groups] Cacheo Eager de Metadatos de Grupos
                if (isGroup && redisClient) {
                    const groupCacheKey = `group_meta:${clientId}:${senderId}`; // Usamos group_meta para consistencia con la skill
                    const hasCachedMeta = await redisClient.get(groupCacheKey);

                    if (!hasCachedMeta && sock) {
                        try {
                            console.log(`[${clientSlug}] 🌐 Solicitando metadata a WhatsApp para el grupo nuevo: ${senderId}`);
                            const metadata = await sock.groupMetadata(senderId);

                            let groupAvatar = null;
                            try {
                                groupAvatar = await sock.profilePictureUrl(senderId, 'image').catch(() => null);
                            } catch (e) { }

                            const simplifiedMeta = {
                                id: metadata.id,
                                subject: metadata.subject,
                                avatar: groupAvatar,
                                owner: metadata.owner || 'Unknown',
                                creation: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
                                desc: metadata.desc || 'No description',
                                participantsCount: metadata.participants?.length || 0
                            };
                            // Guardar en Redis por 24 horas
                            await redisClient.set(groupCacheKey, JSON.stringify(simplifiedMeta), { EX: 86400 });
                        } catch (gErr) {
                            console.warn(`[${clientSlug}] ⚠️ Error obteniendo metadata del grupo:`, gErr.message);
                        }
                    }
                }

                // Novedad: Actualizar registro de actividad
                lastActivity.set(sessionKey, Date.now());

                let text = extractMessageContent(msgContent);
                const mediaPayload = extractWhatsAppMediaPayload(msgContent);
                let finalText = text || '';

                if (!finalText && !mediaPayload) {
                    if (isSentByMe) finalText = '[Mensaje del usuario]';
                }

                if (!finalText && !mediaPayload) {
                    console.log(`[${clientSlug}] ℹ️ Mensaje vacío ignorado. Tipos presentes: ${Object.keys(msgContent).join(', ')}`);
                    // Debug extra: si es protocolMessage, ver qué trae
                    if (msgContent.protocolMessage) {
                        console.log(`[${clientSlug}] 📂 Es ProtocolMessage type: ${msgContent.protocolMessage.type}`);
                    }
                    return;
                }

                console.log(`[${clientSlug} - ${isSentByMe ? 'Sent' : 'Recv'}]: ${(finalText || '[Media]').slice(0, 50)}...`);
                const groupMeta = isGroup ? await discoverWhatsAppGroup(clientId, senderId).catch(() => null) : null;
                const conversationName = isGroup
                    ? (pickBestHumanName(groupMeta?.subject, fallbackNameFromRemoteId(senderId)) || senderId)
                    : pushName;

                // 👤 Obtener Avatar URL (con caché de 1h)
                let avatarUrl = null;
                const cacheKey = `${sessionKey}_${senderId}`;
                if (profilePicCache.has(cacheKey) && Date.now() - profilePicCache.get(cacheKey).time < 3600000) {
                    avatarUrl = profilePicCache.get(cacheKey).url;
                } else {
                    try {
                        avatarUrl = await sock.profilePictureUrl(senderId, 'image');
                        profilePicCache.set(cacheKey, { url: avatarUrl, time: Date.now() });
                    } catch (e) {
                        profilePicCache.set(cacheKey, { url: null, time: Date.now() });
                    }
                }

                const messageTimestampIso = resolveWhatsAppMessageTimestamp(msg.messageTimestamp);
                const baseRecord = buildRawMessageRecord({
                    clientId,
                    senderRole: isSentByMe ? 'user_sent' : pushName,
                    content: finalText,
                    remoteId: senderId,
                    createdAt: messageTimestampIso,
                    processed: false,
                    channel: 'whatsapp',
                    sourceMessageId: msg.key.id,
                    participantJid,
                    canonicalSenderName: isSentByMe ? 'Yo' : pushName,
                    conversationName,
                    isGroup,
                    isHistory: false,
                    quotedMessageId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
                    pushName,
                    avatarUrl,
                    deliveryStatus: isSentByMe ? 'sent' : 'read',
                    mediaPayload,
                    mediaMimeType: extractMediaMimeType(mediaPayload),
                    mediaFilename: extractMediaFilename(mediaPayload, msg.key.id),
                    metadata: {}
                });
                const previewText = baseRecord.semantic_text || baseRecord.content;
                const assistantEcho = isSentByMe
                    ? await consumeTrackedOutboundMessage(clientId, senderId, previewText)
                    : null;
                const excludeFromMemory = Boolean(assistantEcho?.exclude_from_memory) || (isSentByMe && looksLikeBotText(previewText));
                const rawRecord = buildRawMessageRecord({
                    ...baseRecord,
                    processed: excludeFromMemory,
                    excludeFromMemory,
                    assistantEcho: Boolean(assistantEcho),
                    generatedBy: assistantEcho?.generated_by || null,
                    metadata: {
                        ...(baseRecord.metadata || {})
                    }
                });

                if (!rawRecord.client_id) {
                    console.warn(`[${clientSlug}] Omitiendo raw en tiempo real ${msg.key.id}: client_id inválido.`);
                    continue;
                }

                const { error: dbErr, data: insertedRows } = await supabase
                    .from('raw_messages')
                    .insert([rawRecord])
                    .select('id, created_at');

                if (dbErr) {
                    console.error(`[${clientSlug}] ❌ DB Insert Error:`, dbErr.message);
                } else {
                    console.log(`[${clientSlug}] ✅ Message stored in raw_messages`);
                    if (rawRecord.has_media) {
                        scheduleInlineMediaEnrichment({
                            clientId,
                            rawMessage: rawRecord,
                            downloadableMessage: buildWhatsAppDownloadableMessage({
                                remoteJid: senderId,
                                messageId: msg.key.id,
                                fromMe: isSentByMe,
                                participantJid,
                                mediaPayload
                            }),
                            sock
                        });
                    }

                    // 🔴 BROADCAST: Real-time WebSocket event for the native clone
                    if (global.__wss) {
                        const insertedMsg = insertedRows?.[0];
                        const wsPayload = JSON.stringify({
                            type: 'new_message',
                            data: {
                                conversation_id: senderId,
                                participant_jid: participantJid,
                                id: msg.key.id, // Usamos el ID de Baileys para tracking en el front
                                text: rawRecord.semantic_text || rawRecord.content,
                                from_me: isSentByMe,
                                timestamp: messageTimestampIso || insertedMsg?.created_at || new Date().toISOString(),
                                sender_name: isSentByMe ? 'Yo' : pushName,
                                media_url: null,
                                media_type: rawRecord.media_type,
                                status: isSentByMe ? 'sent' : 'read'
                            }
                        });
                        global.__wss.clients.forEach(ws => {
                            if (ws.readyState === 1 && ws.userId === clientId) {
                                ws.send(wsPayload);
                            }
                        });
                    }
                }

                // Notificar al worker de memoria (Amnesia Consolidator) en cada interacción
                if (!excludeFromMemory && !rawRecord.has_media) {
                    await triggerMemoryTimer(clientId);
                }

                // ====================================================================
                // 🤖 MODO ASISTENTE PERSONAL (Self-Chat AI)
                // Solo responde cuando TÚ escribes en tu propio chat ("Mensajes a ti mismo").
                // Los mensajes de otros contactos se guardan en la DB pero NO se responden.
                // ====================================================================
                const myJid = sock.user?.id;
                const myLid = sock.user?.lid; // Baileys LID (e.g. "159755754573992:45@lid")
                const myNormalizedJid = myJid?.replace(/:.*@/, '@'); // → "34678688954@s.whatsapp.net"
                const myNormalizedLid = myLid?.replace(/:.*@/, '@'); // → "159755754573992@lid"

                // Self-chat messages arrive with @lid, so check BOTH formats
                const isSelfChat = isSentByMe && !isGroup && (
                    senderId === myNormalizedJid ||
                    senderId === myNormalizedLid ||
                    senderId === myJid
                );

                if (isSentByMe && !isGroup) {
                    console.log(`[🤖 Self-Chat Debug] senderId=${senderId} | myJid=${myNormalizedJid} | myLid=${myNormalizedLid} | match=${isSelfChat}`);
                }

                if (isSelfChat) {
                    if (assistantEcho) {
                        console.log(`[🤖 Self-Chat AI] Ignorando eco del bot marcado en salida.`);
                        continue;
                    }
                    // 🛡️ Evitar bucle: No procesar mensajes que el propio bot generó
                    const selfChatText = finalText || previewText || rawRecord.semantic_text || rawRecord.content || '';
                    if (selfChatText.startsWith('🤖') || selfChatText.startsWith('[OpenClaw')) {
                        console.log(`[🤖 Self-Chat AI] ℹ️ Ignorando mensaje propio del bot.`);
                    } else {
                        // 🧠 El usuario está hablando consigo mismo → Activar el Asistente IA
                        console.log(`[🤖 Self-Chat AI] 📬 Pregunta del usuario detectada: "${selfChatText.slice(0, 60)}..."`);

                        // 🔥 FEEDBACK VISUAL: Mostrar "escribiendo..." inmediatamente
                        try {
                            await sock.sendPresenceUpdate('composing', senderId);
                        } catch (presenceErr) {
                            console.warn(`[🤖 Self-Chat AI] No se pudo enviar 'composing': ${presenceErr.message}`);
                        }

                        console.log(`[🤖 Self-Chat AI] Encolando a incomingMessagesQueue para ${clientSlug}...`);
                        await incomingQueue.add('process_message', {
                            clientId,
                            clientSlug,
                            channel: 'whatsapp',
                            senderId, // Responderá al propio JID del usuario
                            text: selfChatText,
                            isSentByMe: true,
                            metadata: { pushName: 'Yo (Asistente)', isGroup: false, isSelfChat: true }
                        }, {
                            removeOnComplete: true,
                            removeOnFail: 50
                        });
                    }
                }
            } catch (handlerErr) {
                console.error(`[${clientSlug}] 💀 CRITICAL HANDLER ERROR:`, handlerErr.message);
            }
        } // Cierre del for loop
    });

    // 3.5 Status Updates: Ticks azules y recibos de lectura
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.status) {
                const statusMap = {
                    1: 'sent',      // PENDING/SENT (Reloj o un tick)
                    2: 'sent',      // DELIVERED (Dos ticks grises)
                    3: 'read',      // READ (Dos ticks azules)
                    4: 'played',    // PLAYED (Audio escuchado)
                };
                const status = statusMap[update.update.status];
                if (!status) continue;

                console.log(`[${clientSlug}] 🏷️ Update status para ${update.key.id}: ${status}`);

                // 1. Actualizar DB (Búsqueda por el ID original de Baileys en metadata)
                const { error } = await supabase.rpc('update_raw_message_status', {
                    p_client_id: clientId,
                    p_msg_id: update.key.id,
                    p_status: status
                });

                // Si la RPC falla (no existe), intentamos un update manual via select
                if (error) {
                    // console.warn(`[${clientSlug}] RAG update status error:`, error.message);
                }

                // 2. Notificar al front vía WebSocket
                if (global.__wss) {
                    const payload = JSON.stringify({
                        type: 'message_status',
                        data: {
                            id: update.key.id,
                            jid: update.key.remoteJid,
                            status: status
                        }
                    });
                    global.__wss.clients.forEach(ws => {
                        if (ws.readyState === 1 && ws.userId === clientId) {
                            ws.send(payload);
                        }
                    });
                }
            }
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
/**
 * Envía un mensaje simulando comportamiento humano (Typing... + Delay aleatorio)
 * para reducir el riesgo de baneos de WhatsApp.
 */
export async function sendHumanLikeMessage(clientId, jid, content, opts = {}, tracking = {}) {
    const sock = activeSessions.get(String(clientId));
    if (!sock) throw new Error('WhatsApp no conectado');

    // Normalize: Baileys sendMessage expects { text: '...' }, never a raw string
    if (typeof content === 'string') {
        content = { text: content };
    }
    const text = content.text || '';
    const shouldTrackEcho = tracking.excludeFromMemory === true;

    try {
        // 1. Simular "Escribiendo..."
        await sock.presenceSubscribe(jid);
        await new Promise(r => setTimeout(r, 500));
        await sock.sendPresenceUpdate('composing', jid);

        // 2. Calcular delay basado en longitud (p.ej. 50ms por caracter, min 2s, max 8s) + jitter
        const baseDelay = Math.min(Math.max(text.length * 40, 2000), 8000);
        const jitter = Math.random() * 2000;
        const finalDelay = baseDelay + jitter;

        console.log(`[Anti-Ban] ⏳ Simulando escritura para ${jid} (${Math.round(finalDelay)}ms)...`);
        await new Promise(r => setTimeout(r, finalDelay));

        // 3. Enviar mensaje
        if (shouldTrackEcho && text) {
            await rememberTrackedOutboundMessage(clientId, jid, text, {
                generated_by: tracking.generatedBy || 'core_engine',
                exclude_from_memory: true
            });
        }
        const sent = await sock.sendMessage(jid, content, opts);
        if (shouldTrackEcho && sent?.key?.id) {
            await syncAssistantMessageId(
                clientId,
                jid,
                tracking.logicalText || text,
                sent.key.id,
                tracking.generatedBy || 'core_engine',
                text
            );
        }

        // 4. Detener "Escribiendo..."
        await sock.sendPresenceUpdate('paused', jid);

        return sent;
    } catch (e) {
        console.error(`[Anti-Ban] ❌ Error enviando mensaje humanizado:`, e.message);
        // Fallback: intentar enviar normal si la simulación falla
        if (shouldTrackEcho && text) {
            await rememberTrackedOutboundMessage(clientId, jid, text, {
                generated_by: tracking.generatedBy || 'core_engine',
                exclude_from_memory: true
            });
        }
        const sent = await sock.sendMessage(jid, content, opts);
        if (shouldTrackEcho && sent?.key?.id) {
            await syncAssistantMessageId(
                clientId,
                jid,
                tracking.logicalText || text,
                sent.key.id,
                tracking.generatedBy || 'core_engine',
                text
            );
        }
        return sent;
    }
}

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

// ------------------------------------------------------------------
// LAZY LOADING MEDIA (Historical Extraction)
// ------------------------------------------------------------------
export async function fetchHistoricalMedia(clientId, remoteJid, messageId) {
    const sessionKey = String(clientId);
    const sock = activeSessions.get(sessionKey);
    if (!sock) throw new Error("WhatsApp socket not online for this client.");

    try {
        console.log(`[Lazy Media] 🔍 Buscando BD metadata histórica para ${messageId}...`);

        // 1. Obtener los metadatos y las llaves de desencriptado directamente de PostgreSQL
        let { data: records, error } = await supabase
            .from('raw_messages')
            .select('metadata')
            .eq('client_id', clientId)
            .eq('source_message_id', messageId)
            .limit(1);

        if ((!records || records.length === 0) && !error) {
            const fallback = await supabase
                .from('raw_messages')
                .select('metadata')
                .eq('client_id', clientId)
                .contains('metadata', { msgId: messageId })
                .limit(1);
            records = fallback.data;
            error = fallback.error;
        }

        if (error || !records || records.length === 0) {
            throw new Error(`Mensaje ${messageId} no encontrado en la base de datos local.`);
        }

        const metadata = records[0].metadata;
        if (!metadata || !metadata.mediaPayload) {
            throw new Error(`El mensaje ${messageId} no tiene mediaPayload almacenado (historial antiguo o texto puro).`);
        }

        const msgContent = metadata.mediaPayload;

        // 2. Reconstruir el objeto de mensaje que Baileys espera para desencriptar
        const msgInfo = {
            key: {
                remoteJid: remoteJid,
                id: messageId,
                fromMe: metadata.status === 'read' || metadata.status === 'played'
            },
            message: msgContent
        };

        const isMedia = msgContent.imageMessage || msgContent.videoMessage || msgContent.audioMessage || msgContent.documentMessage || msgContent.stickerMessage;
        if (!isMedia) throw new Error("El payload reconstruido no contiene una estructura multimedia válida.");

        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        console.log(`[Lazy Media] 📥 Descargando e inyectando buffer multimedia histórico desde Meta (Lazy-Load)...`);

        // 3. Descarga y decodifica sobre la marcha sin necesidad de Store en RAM
        const buffer = await downloadMediaMessage(msgInfo, 'buffer', {}, { logger: sock.logger, reuploadRequest: sock.updateMediaMessage });

        let mediaType = 'unknown';
        let mimeType = '';
        if (msgContent.imageMessage) { mediaType = 'image'; mimeType = msgContent.imageMessage.mimetype; }
        else if (msgContent.audioMessage) { mediaType = 'audio'; mimeType = msgContent.audioMessage.mimetype; }
        else if (msgContent.videoMessage) { mediaType = 'video'; mimeType = msgContent.videoMessage.mimetype; }
        else if (msgContent.documentMessage) { mediaType = 'document'; mimeType = msgContent.documentMessage.mimetype; }
        else if (msgContent.stickerMessage) { mediaType = 'sticker'; mimeType = msgContent.stickerMessage.mimetype; }

        return { buffer, mediaType, mimeType };
    } catch (e) {
        console.error(`[Lazy Media] Error buscando/descargando media para ${messageId}:`, e.message);
        throw e;
    }
}

// ------------------------------------------------------------------
// EL BOCA-OREJA: WORKER DE SALIDA (OUTGOING)
// ------------------------------------------------------------------
// Este worker vive en el proceso del "Cuerpo". Su único trabajo es
// escuchar lo que el "Cerebro" manda y "escupirlo" por WhatsApp simulando
// ser un humano (Typing delay).

const outgoingWorker = new Worker('outgoingMessagesQueue', async (job) => {
    const { clientId, clientSlug, senderId, text, memoryText } = job.data;
    console.log(`[Queue] 📥 Recibida respuesta generada por IA para ${clientSlug}...`);

    try {
        await sendHumanLikeMessage(clientId, senderId, text, {}, {
            excludeFromMemory: true,
            generatedBy: 'core_engine',
            logicalText: memoryText || text
        });
        console.log(`[Queue-WhatsApp] ✅ Mensaje enviado a ${senderId} correctamente.`);
    } catch (err) {
        console.error(`[Queue-WhatsApp] ❌ Error enviando el mensaje: ${err.message}`);
        throw err; // Reintenta según políticas de BullMQ
    }
}, {
    connection: new (await import('ioredis')).default({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
        maxRetriesPerRequest: null,
    }), concurrency: 10 // Puede enviar hasta 10 mensajes en paralelo para evitar embudos
});

outgoingWorker.on('failed', (job, err) => {
    console.error(`[BullMQ-Worker Outgoing] ⚠️ Job ID ${job.id} falló:`, err.message);
});

console.log('👷 [Workers] Worker de salida de WhatsApp inicializado (Escuchando outgoingMessagesQueue).');
