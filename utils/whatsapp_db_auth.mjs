import supabase from '../config/supabase.mjs';
import { proto } from '@whiskeysockets/baileys';
import { BufferJSON } from '@whiskeysockets/baileys';

/**
 * Custom Baileys Auth Adapter for Supabase/PostgreSQL.
 * This replaces useMultiFileAuthState to survive restarts and multi-node deployments.
 */
export const useSupabaseAuthState = async (clientId) => {

    // Helper to read data from DB
    const readData = async (type, id) => {
        try {
            const { data, error } = await supabase
                .from('whatsapp_sessions')
                .select('data_json')
                .eq('client_id', clientId)
                .eq('data_type', type)
                .eq('data_id', id)
                .single();

            if (error || !data) return null;
            return JSON.parse(JSON.stringify(data.data_json), BufferJSON.reviver);
        } catch (e) {
            return null;
        }
    };

    // Helper to write data to DB
    const writeData = async (type, id, data) => {
        try {
            const { error } = await supabase
                .from('whatsapp_sessions')
                .upsert({
                    client_id: clientId,
                    data_type: type,
                    data_id: id,
                    data_json: JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'client_id, data_type, data_id' });

            if (error) console.error(`[DB-Auth] Error writing ${type}/${id}:`, error.message);
        } catch (e) {
            console.error(`[DB-Auth] Crash writing ${type}/${id}:`, e.message);
        }
    };

    // Helper to delete data from DB
    const removeData = async (type, id) => {
        try {
            await supabase
                .from('whatsapp_sessions')
                .delete()
                .eq('client_id', clientId)
                .eq('data_type', type)
                .eq('data_id', id);
        } catch (e) { }
    };

    // 1. Initialize Credentials
    let credsData = await readData('creds', 'main');

    if (!credsData) {
        const { initAuthCreds } = await import('@whiskeysockets/baileys');
        credsData = initAuthCreds();
    }

    return {
        state: {
            creds: credsData,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(type, id);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const category_id = id;
                            if (value) {
                                tasks.push(writeData(category, category_id, value));
                            } else {
                                tasks.push(removeData(category, category_id));
                            }
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData('creds', 'main', credsData),
    };
};
