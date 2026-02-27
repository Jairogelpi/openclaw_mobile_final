import axios from 'axios';
import fs from 'fs/promises';
import supabase from '../config/supabase.mjs';
import { getClientSlug } from '../utils/helpers.mjs';

const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

export async function handleAccountDelete(req, res, id) {
    const clientId = req.clientId;
    const clientSlug = getClientSlug(req.user.email);
    const clientDir = `./clients/${clientSlug}`;
    const stateDir = `${clientDir}/state`;

    try {
        console.log(`🚨[Panic Button] Destrucción total solicitada para: ${clientSlug}(${clientId})`);

        // 1. WhatsApp Unlink (via client's assigned port)
        try {
            const { data: delPortData } = await supabase
                .from('user_souls')
                .select('port')
                .eq('client_id', clientId)
                .single();

            if (delPortData?.port) {
                await axios.post(`http://localhost:${delPortData.port}/rpc`, {
                    method: 'whatsapp.unlink',
                    params: {},
                    id: 'internal'
                }, {
                    headers: {
                        'x-openclaw-state-dir': stateDir,
                        'Authorization': `Bearer ${GATEWAY_TOKEN}`
                    }
                });
            }
        } catch (e) { }

        // 2. Delete Supabase Data (Cascade will handle messages/memories)
        await supabase.from('user_souls').delete().eq('client_id', clientId);

        // 3. Delete Local Files
        try {
            await fs.rm(clientDir, { recursive: true, force: true });
        } catch (e) {
            console.log("[Delete] Error removing client folder:", e.message);
        }

        // 4. Delete Auth User (Admin API)
        const { error: authError } = await supabase.auth.admin.deleteUser(clientId);
        if (authError) {
            console.warn("[Delete] Could not delete auth user:", authError.message);
        }

        return res.json({ result: { success: true }, id });
    } catch (err) {
        return res.status(500).json({ error: { message: err.message }, id });
    }
}
