import redisClient from '../config/redis.mjs';

/**
 * Skill: WhatsApp Group Discovery
 * 
 * Lee la meta-información de un grupo (cacheada de de forma "eager" por el gateway en Redis)
 * para traducir IDs numéricos a títulos legibles para la IA.
 */

export async function discoverWhatsAppGroup(clientId, jid) {
    if (!jid.endsWith('@g.us')) {
        return null;
    }

    if (!redisClient) return null;

    try {
        // Normalizar JID: asegurar que tenga el sufijo correcto si solo viene el ID
        let normalizedJid = jid;
        if (!jid.endsWith('@g.us')) {
            normalizedJid = jid.includes('@') ? jid : `${jid}@g.us`;
        }

        const cacheKey = `group_meta:${clientId}:${normalizedJid}`;
        const cachedMeta = await redisClient.get(cacheKey);
        
        if (cachedMeta) {
            try {
                const parsed = JSON.parse(cachedMeta);
                console.log(`[Skill: WA Groups] ⚡ Resuelto: ${jid} -> "${parsed.subject}"`);
                return parsed;
            } catch (err) {
                console.log(`[Skill: WA Groups] ⚡ Resuelto (Legacy String): ${jid} -> "${cachedMeta}"`);
                return { subject: cachedMeta, avatar: null };
            }
        } else {
            console.log(`[Skill: WA Groups] ⏳ Metadata no disponible aún en Redis para ${jid}`);
            return null;
        }
    } catch (e) {
        console.warn(`[Skill: WA Groups] Redis error:`, e.message);
        return null;
    }
}

