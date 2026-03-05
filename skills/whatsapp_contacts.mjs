import redisClient from '../config/redis.mjs';

/**
 * Skill: WhatsApp Identity Resolver (Contacts & Avatars)
 * 
 * Intercepta los contactos de la sesión activa de WhatsApp (guardados por whatsapp.mjs en Redis)
 * y permite resolver un JID a su nombre real y foto de perfil.
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
        // Normalizar JID: asegurar que tenga el sufijo correcto si solo viene el número
        let normalizedJid = jid;
        if (!jid.includes('@')) {
            normalizedJid = `${jid}@s.whatsapp.net`;
        }

        // Caso especial: Mi propio JID
        // Si el JID resuelto es el del propio usuario, devolver una etiqueta amigable
        // (En logs de Baileys a veces el propio JID aparece en history.set)
        if (jid === 'me' || jid.includes('me@') || jid.startsWith('self')) {
            return { name: "Mi Clon (Yo)", avatar: null };
        }

        // Intento 1: Búsqueda directa (funciona para @s.whatsapp.net)
        const key = `contacts:${clientId}:${normalizedJid}`;
        const data = await redisClient.get(key);

        if (data) {
            try {
                const parsed = JSON.parse(data);
                console.log(`[Skill: WA Contacts] ✅ Resuelto (JSON): ${jid} -> "${parsed.name}"`);
                return {
                    name: parsed.name,
                    avatar: parsed.avatar
                };
            } catch (parseError) {
                console.log(`[Skill: WA Contacts] ✅ Resuelto (Legacy): ${jid} -> "${data}"`);
                return {
                    name: data,
                    avatar: null
                };
            }
        }

        // Intento 2: Si es un @lid, buscar en todos los contactos del cliente
        // Los LIDs son IDs internos de Baileys que no coinciden con el número de teléfono
        if (jid.endsWith('@lid')) {
            console.log(`[Skill: WA Contacts] 🔍 Buscando @lid ${jid} en cache de contactos...`);
            // Scan all contact keys for this client
            const pattern = `contacts:${clientId}:*`;
            let cursor = 0;
            do {
                const result = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 100 });
                cursor = result.cursor;
                for (const contactKey of result.keys) {
                    const contactData = await redisClient.get(contactKey);
                    if (contactData) {
                        try {
                            const parsed = JSON.parse(contactData);
                            // Match by name if pushName matches stored name
                            if (pushName && parsed.name && (
                                parsed.name.toLowerCase() === pushName.toLowerCase() ||
                                parsed.name.toLowerCase().includes(pushName.toLowerCase()) ||
                                pushName.toLowerCase().includes(parsed.name.toLowerCase())
                            )) {
                                console.log(`[Skill: WA Contacts] ✅ @lid resuelto por nombre: ${jid} -> "${parsed.name}"`);
                                return { name: parsed.name, avatar: parsed.avatar };
                            }
                        } catch (e) {}
                    }
                }
            } while (cursor !== 0);
        }

        // Intento 3: Usar pushName como fallback
        if (pushName) {
            console.log(`[Skill: WA Contacts] ℹ️ Usando pushName como fallback: ${jid} -> "${pushName}"`);
            return { name: pushName, avatar: null };
        }

        console.log(`[Skill: WA Contacts] ❌ Contacto no encontrado en agenda: ${jid}`);
        return null;
    } catch (e) {
        console.warn(`[Skill: WA Contacts] Error crítico leyendo Redis: ${e.message}`);
        return pushName ? { name: pushName, avatar: null } : null;
    }
}
