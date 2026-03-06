import redisClient from '../config/redis.mjs';
import { normalizeComparableText, stripDecorativeText } from '../utils/message_guard.mjs';

/**
 * Skill: WhatsApp Identity Resolver (Contacts & Avatars)
 *
 * Reads contact data cached by whatsapp.mjs and resolves a JID to its
 * best available real-world identity without doing fuzzy merges.
 */

export async function lookupWhatsAppContactName(clientId, jid) {
    const identity = await resolveIdentity(clientId, jid);
    return identity?.name || null;
}

export async function resolveIdentity(clientId, jid, pushName) {
    if (!redisClient) {
        console.warn(`[Skill: WA Contacts] Redis NO DISPONIBLE. Imposible resolver ${jid}`);
        return pushName ? { name: pushName, avatar: null } : null;
    }

    try {
        let normalizedJid = jid;
        if (!jid.includes('@')) {
            normalizedJid = `${jid}@s.whatsapp.net`;
        }

        if (jid === 'me' || jid.includes('me@') || jid.startsWith('self')) {
            return { name: 'Mi Clon (Yo)', avatar: null };
        }

        const key = `contacts:${clientId}:${normalizedJid}`;
        const data = await redisClient.get(key);

        if (data) {
            try {
                const parsed = JSON.parse(data);
                console.log(`[Skill: WA Contacts] Resuelto (JSON): ${jid} -> "${parsed.name}"`);
                return {
                    name: parsed.name,
                    avatar: parsed.avatar
                };
            } catch (parseError) {
                console.log(`[Skill: WA Contacts] Resuelto (Legacy): ${jid} -> "${data}"`);
                return {
                    name: data,
                    avatar: null
                };
            }
        }

        if (jid.endsWith('@lid')) {
            console.log(`[Skill: WA Contacts] Buscando @lid ${jid} en cache de contactos...`);
            const normalizedPushName = normalizeComparableText(stripDecorativeText(pushName));
            const exactCandidates = [];
            const pattern = `contacts:${clientId}:*`;
            let cursor = 0;

            do {
                const result = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 100 });
                cursor = result.cursor;

                for (const contactKey of result.keys) {
                    const contactData = await redisClient.get(contactKey);
                    if (!contactData) continue;

                    try {
                        const parsed = JSON.parse(contactData);
                        const normalizedStoredName = normalizeComparableText(stripDecorativeText(parsed.name));
                        if (normalizedPushName && normalizedStoredName && normalizedStoredName === normalizedPushName) {
                            exactCandidates.push({ name: parsed.name, avatar: parsed.avatar });
                        }
                    } catch (e) {}
                }
            } while (cursor !== 0);

            if (exactCandidates.length === 1) {
                console.log(`[Skill: WA Contacts] @lid resuelto por coincidencia exacta unica: ${jid} -> "${exactCandidates[0].name}"`);
                return exactCandidates[0];
            }

            if (exactCandidates.length > 1) {
                console.warn(`[Skill: WA Contacts] @lid ambiguo para ${jid}. ${exactCandidates.length} contactos comparten "${pushName}". Se usa pushName sin fusionar.`);
            }
        }

        if (pushName) {
            console.log(`[Skill: WA Contacts] Usando pushName como fallback: ${jid} -> "${pushName}"`);
            return { name: pushName, avatar: null };
        }

        console.log(`[Skill: WA Contacts] Contacto no encontrado en agenda: ${jid}`);
        return null;
    } catch (e) {
        console.warn(`[Skill: WA Contacts] Error critico leyendo Redis: ${e.message}`);
        return pushName ? { name: pushName, avatar: null } : null;
    }
}
