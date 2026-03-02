import fs from 'fs/promises';
import JSON5 from 'json5';
import supabase from '../config/supabase.mjs';
import { getClientSlug } from '../utils/helpers.mjs';

// These must be passed from server.mjs since they use security.mjs module-level functions
export async function handleUpdateSettings(req, res, params, id, encrypt, decrypt) {
    const clientId = req.clientId;
    const clientSlug = getClientSlug(req.user.email, req.user.id);
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

        // 1. Get existing soul and gateway config (if any)
        const { data: soulData, error: soulError } = await supabase
            .from('user_souls')
            .select('soul_json, gateway_config')
            .eq('client_id', clientId)
            .maybeSingle();

        let soulJson = {};
        let gateway = {};
        if (!soulError && soulData) {
            soulJson = soulData.soul_json || {};
            gateway = soulData.gateway_config || {};
        }

        // Si es la primera vez y el gateway está vacío, rellenamos defaults críticos
        if (Object.keys(gateway).length === 0) {
            try {
                const template = await fs.readFile('./gateway.json5', 'utf8');
                gateway = JSON5.parse(template);
                gateway.client_id = clientId;
                gateway.slug = clientSlug;
                gateway.models = { providers: { openrouter: { apiKey: process.env.OPENROUTER_API_KEY } } };
                gateway.agents = { defaults: { model: { primary: "openrouter/deepseek/deepseek-chat" } } };
            } catch (e) {
                console.warn(`[Bridge] Warning parsing base gateway.json5 template:`, e.message);
            }
        }

        // Merge soul updates (name, tone, etc)
        soulJson = { ...soulJson, ...soulUpdates };

        // Map UI preferences to gateway_config structure
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

        const { error: updateError } = await supabase
            .from('user_souls')
            .upsert({
                client_id: clientId,
                soul_json: soulJson,
                gateway_config: gateway,
                last_updated: new Date()
            });

        if (updateError) {
            console.error(`[Bridge] ❌ Error upserting soul and gateway for ${clientSlug}:`, updateError.message, updateError.details);
            throw updateError;
        }

        return res.json({ result: { success: true }, id });
    } catch (err) {
        return res.status(500).json({ error: { message: err.message }, id });
    }
}
