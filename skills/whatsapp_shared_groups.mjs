import supabase from '../config/supabase.mjs';

/**
 * Skill: WhatsApp Shared Groups (ClawHub adapted)
 * 
 * Busca todos los grupos en común entre el usuario de OpenClaw y un número
 * inspeccionando los `sender-key` cacheados en la base de datos de sesiones.
 */

export async function findSharedGroups(clientId, phoneNumber) {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (!cleanPhone) return [];

    try {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('data_id')
            .eq('client_id', clientId)
            .eq('data_type', 'sender-key')
            // Using ilike to match the phone number inside the sender-key id. 
            // Format is usually <group_jid>::<sender_jid>
            .ilike('data_id', `%@g.us::${cleanPhone}%`);

        if (error || !data) return [];

        const groupIds = new Set();
        const groups = [];

        for (const row of data) {
            const match = row.data_id.match(/(.+@g\.us)::/);
            if (match && !groupIds.has(match[1])) {
                groupIds.add(match[1]);
                groups.push({ id: match[1], name: `Grupo (${match[1].split('-')[0]})` });
            }
        }

        return groups;
    } catch (e) {
        console.warn(`[Skill: Shared Groups] Error:`, e.message);
        return [];
    }
}
