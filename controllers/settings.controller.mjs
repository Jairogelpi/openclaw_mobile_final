import fs from 'fs/promises';
import JSON5 from 'json5';
import supabase from '../config/supabase.mjs';
import { getClientSlug } from '../utils/helpers.mjs';

// These must be passed from server.mjs since they use security.mjs module-level functions
export async function handleUpdateSettings(req, res, params, id, encrypt, decrypt) {
    const clientId = req.clientId;
    const clientSlug = getClientSlug(req.user.email);
    const clientDir = `./clients/${clientSlug}`;
    const { soulUpdates, preferences } = params;

    try {
        // -1. Auto-heal public.users to satisfy FK constraint
        const { error: healErr } = await supabase.from('users').upsert({ id: clientId, email: req.user.email, password_hash: 'managed_by_auth' });
        if (healErr) console.warn('[Bridge] Warning inserting users during updateSettings:', healErr.message);

        // 0. Ensure the client row exists first (required by user_souls FK)
        const { error: clientUpsertError } = await supabase
            .from('clients')
            .upsert({
                user_id: clientId,
                name: soulUpdates?.nombre || req.user?.user_metadata?.name || clientSlug,
                whatsapp_number: ''
            }, { onConflict: 'user_id' });
        if (clientUpsertError) {
            console.warn(`[Bridge] Warning: could not upsert client row for ${clientSlug}:`, clientUpsertError.message);
        }

        // 1. Get existing soul (if any)
        const { data: soulData, error: soulError } = await supabase
            .from('user_souls')
            .select('soul_json')
            .eq('client_id', clientId)
            .maybeSingle();

        let soulJson = {};
        if (!soulError && soulData) {
            soulJson = soulData.soul_json;
        }

        // Merge updates (name, tone, etc)
        soulJson = { ...soulJson, ...soulUpdates };

        const { error: updateError } = await supabase
            .from('user_souls')
            .upsert({ client_id: clientId, soul_json: soulJson, last_updated: new Date() });

        if (updateError) {
            console.error(`[Bridge] ❌ Error upserting soul for ${clientSlug}:`, updateError.message, updateError.details);
            throw updateError;
        }

        try {
            const gatewayPath = `${clientDir}/gateway.json5`;
            let gateway = {};
            try {
                const rawContent = await fs.readFile(gatewayPath, 'utf8');
                const content = decrypt(rawContent);
                gateway = JSON5.parse(content);
            } catch (e) {
                const template = await fs.readFile('./gateway.json5', 'utf8');
                gateway = JSON5.parse(template);
            }

            if (!gateway.channels) gateway.channels = {};
            if (!gateway.channels.whatsapp) gateway.channels.whatsapp = {};

            if (preferences.autoReply !== undefined) {
                gateway.channels.whatsapp.replyToMode = preferences.autoReply ? "auto" : "off";
            }
            if (preferences.readGroups !== undefined) {
                gateway.channels.whatsapp.groupPolicy = preferences.readGroups ? "open" : "off";
            }

            if (preferences.summarizeSkill !== undefined) {
                if (!gateway.plugins) gateway.plugins = { entries: {} };
                if (!gateway.plugins.entries) gateway.plugins.entries = {};
                if (!gateway.plugins.entries.summarize) {
                    gateway.plugins.entries.summarize = {
                        enabled: true,
                        path: "./core/skills/summarize/index.mjs"
                    };
                }
                gateway.plugins.entries.summarize.enabled = preferences.summarizeSkill;
            }

            // Ensure directory exists
            await fs.mkdir(clientDir, { recursive: true });
            await fs.writeFile(gatewayPath, encrypt(JSON.stringify(gateway, null, 2)));

        } catch (err) {
            console.error(`[Bridge] Error updating gateway config for ${clientSlug}:`, err.message);
        }

        return res.json({ result: { success: true }, id });
    } catch (err) {
        return res.status(500).json({ error: { message: err.message }, id });
    }
}
