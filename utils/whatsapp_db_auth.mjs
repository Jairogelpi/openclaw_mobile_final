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
                    try {
                        const CHUNK_SIZE = 100;
                        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
                            const chunk = ids.slice(i, i + CHUNK_SIZE);
                            const { data: results, error } = await supabase
                                .from('whatsapp_sessions')
                                .select('data_id, data_json')
                                .eq('client_id', clientId)
                                .eq('data_type', type)
                                .in('data_id', chunk);

                            if (error) {
                                console.error(`[DB-Auth] Bulk read error for ${type}:`, error.message);
                            }

                            if (results) {
                                for (const row of results) {
                                    let value = JSON.parse(JSON.stringify(row.data_json), BufferJSON.reviver);
                                    if (type === 'app-state-sync-key' && value) {
                                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                                    }
                                    data[row.data_id] = value;
                                }
                            }
                        }
                        
                        // Ensure all requested keys exist, even if null
                        for (const id of ids) {
                            if (data[id] === undefined) data[id] = null;
                        }
                    } catch (e) {
                        console.error(`[DB-Auth] Bulk read crashed for ${type}:`, e.message);
                        for (const id of ids) data[id] = null;
                    }
                    return data;
                },
                set: async (data) => {
                    const upserts = [];
                    const deletes = [];

                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (value) {
                                upserts.push({
                                    client_id: clientId,
                                    data_type: category,
                                    data_id: id,
                                    data_json: JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
                                    updated_at: new Date().toISOString()
                                });
                            } else {
                                deletes.push({ type: category, id });
                            }
                        }
                    }

                    try {
                        // Bulk Upsert in chunks to respect Supabase payload limits
                        const CHUNK_SIZE = 500;
                        for (let i = 0; i < upserts.length; i += CHUNK_SIZE) {
                            const chunk = upserts.slice(i, i + CHUNK_SIZE);
                            const { error } = await supabase
                                .from('whatsapp_sessions')
                                .upsert(chunk, { onConflict: 'client_id, data_type, data_id' });
                            
                            if (error) console.error(`[DB-Auth] Bulk upsert error:`, error.message);
                        }

                        // Execute deletes
                        if (deletes.length > 0) {
                            const tasks = deletes.map(d => 
                                supabase.from('whatsapp_sessions')
                                        .delete()
                                        .eq('client_id', clientId)
                                        .eq('data_type', d.type)
                                        .eq('data_id', d.id)
                            );
                            await Promise.all(tasks);
                        }
                    } catch(e) {
                        console.error(`[DB-Auth] Bulk set crashed:`, e.message);
                    }
                },
            },
        },
        saveCreds: () => writeData('creds', 'main', credsData),
    };
};
