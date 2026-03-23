#!/usr/bin/env node
/**
 * 🔬 WhatsApp Deep History Extractor
 * Fetches messages per-chat using the active Baileys socket's store.
 * This works WITHIN an existing session — no re-pairing needed.
 * 
 * Usage: node extract_wa_history.mjs
 */
import 'dotenv/config';
import supabase from '../../config/supabase.mjs';
import { activeSessions } from '../../channels/whatsapp.mjs';
import { resolveIdentity } from './skills/whatsapp_contacts.mjs';
import { fallbackNameFromRemoteId, pickBestHumanName } from '../../utils/message_guard.mjs';

const CID = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';
const SLUG = 'jairogelpi-cc2af';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Helper to extract text content from Baileys message
function extractText(m) {
    if (!m) return '';
    const c = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
    return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || '';
}

async function main() {
    console.log('🔬 WhatsApp Deep History Extractor');
    
    const sock = activeSessions.get(CID);
    if (!sock) {
        console.error('❌ No active WhatsApp session found for', SLUG);
        console.log('Active sessions:', [...activeSessions.keys()]);
        process.exit(1);
    }

    console.log('✅ Socket found. Fetching chat list...');

    // Get all chats from the socket's store
    let chats = [];
    try {
        // Method 1: Use fetchMessageHistory to request from server
        // Method 2: Use the socket's store to get existing chats
        const { data: existingChats } = await supabase
            .from('raw_messages')
            .select('remote_id')
            .eq('client_id', CID);
        
        const existingRemoteIds = [...new Set(existingChats?.map(c => c.remote_id) || [])];
        console.log(`📊 Known chats from raw_messages: ${existingRemoteIds.length}`);
        
        // Also try to get chats from WhatsApp directly
        // Baileys doesn't have a direct listChats API, so we use the known chats
        chats = existingRemoteIds;
    } catch (e) {
        console.error('Error getting chats:', e.message);
    }

    if (chats.length === 0) {
        console.log('No chats found. Try reconnecting WhatsApp first.');
        process.exit(1);
    }

    let totalFetched = 0;
    let totalInserted = 0;
    const identityCache = new Map();

    for (const chatId of chats) {
        try {
            // Skip non-WhatsApp IDs
            if (chatId === 'terminal-admin' || chatId === 'test-terminal') continue;
            
            console.log(`📱 Fetching history for: ${chatId}...`);
            
            // Use Baileys fetchMessageHistory for each chat
            const messages = await sock.fetchMessagesFromWA(chatId, 500);
            
            if (!messages?.length) {
                console.log(`   ⚠️ No messages returned for ${chatId}`);
                continue;
            }

            console.log(`   📦 Got ${messages.length} messages`);
            totalFetched += messages.length;

            // Insert into raw_messages
            const batch = [];
            for (const msg of messages) {
                const text = extractText(msg.message);
                if (!text && !msg.message?.imageMessage && !msg.message?.audioMessage) continue;

                const participantJid = msg.key.participant || chatId;
                const cacheKey = `${participantJid}::${msg.pushName || ''}`;
                let canonicalSenderName = identityCache.get(cacheKey);
                if (canonicalSenderName === undefined) {
                    const identity = msg.key.fromMe
                        ? null
                        : await resolveIdentity(CID, participantJid, msg.pushName || null).catch(() => null);
                    canonicalSenderName = pickBestHumanName(
                        identity?.name,
                        msg.pushName,
                        fallbackNameFromRemoteId(participantJid)
                    ) || null;
                    identityCache.set(cacheKey, canonicalSenderName);
                }
                 
                batch.push({
                    client_id: CID,
                    remote_id: chatId,
                    sender_role: msg.key.fromMe
                        ? 'user_sent'
                        : (canonicalSenderName || fallbackNameFromRemoteId(participantJid) || 'Contacto'),
                    content: text || '[Media]',
                    processed: false,
                    metadata: {
                        msgId: msg.key.id,
                        timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString(),
                        isHistory: true,
                        is_new_unread: false,
                        channel: 'whatsapp',
                        participantJid,
                        pushName: msg.pushName || null,
                        canonicalSenderName: msg.key.fromMe ? 'Yo' : (canonicalSenderName || fallbackNameFromRemoteId(participantJid) || null)
                    }
                });
            }

            if (batch.length > 0) {
                const { error } = await supabase.from('raw_messages').insert(batch);
                if (error) {
                    console.log(`   ❌ Insert error: ${error.message}`);
                } else {
                    totalInserted += batch.length;
                    console.log(`   ✅ Inserted ${batch.length} messages`);
                }
            }

            await sleep(1000);
        } catch (e) {
            console.log(`   ❌ Error for ${chatId}: ${e.message}`);
        }
    }

    console.log(`\n🏁 Done. Fetched: ${totalFetched} | Inserted: ${totalInserted}`);
    
    const { count } = await supabase.from('raw_messages').select('id', { count: 'exact', head: true });
    console.log(`📊 Total raw_messages now: ${count}`);
    
    process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
