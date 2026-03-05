import fs from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import supabase from '../config/supabase.mjs';
import { encrypt, decrypt } from '../security.mjs';
import redisClient from '../config/redis.mjs';
import { processMessage } from '../core_engine.mjs';
import { getAggregatedMetrics } from '../services/rag_metrics.mjs';
import { getAllConfig, setConfig } from '../services/config.service.mjs';

const execPromise = util.promisify(exec);

export async function adminHealthDashboard(req, res, activeSessions) {
    const token = req.query.token;
    if (token !== process.env.ADMIN_TOKEN) return res.status(401).send('No autorizado');

    try {
        const { data: clients } = await supabase
            .from('user_souls')
            .select('client_id, slug, port, last_active, restart_count');

        // Obtener uso de RAM del proceso Node.js actual
        const memoryUsage = process.memoryUsage();
        const ramMB = (memoryUsage.rss / 1024 / 1024).toFixed(2);

        const report = (clients || []).map(c => {
            const isOnline = activeSessions.has(c.client_id);
            return {
                slug: c.slug || 'N/A',
                status: isOnline ? '🟢 Online (Node)' : '🔴 Suspendido',
                restarts: c.restart_count || 0,
                lastActive: c.last_active ? new Date(c.last_active).toLocaleString('es-ES') : 'Nunca'
            };
        });

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OpenClaw Mission Control</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', sans-serif; background: #0f0f23; color: #e0e0e0; padding: 40px; margin: 0; }
  h1 { color: #00d4ff; font-size: 28px; margin-bottom: 5px; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; }
  th { background: #1a1a3e; color: #00d4ff; padding: 12px 16px; text-align: left; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; }
  td { padding: 10px 16px; border-bottom: 1px solid #2a2a4e; font-size: 14px; }
  tr:hover { background: #1a1a3e; }
  .ok { color: #00ff88; } .warn { color: #ffaa00; } .err { color: #ff4444; }
  .footer { margin-top: 20px; color: #666; font-size: 13px; }
  .actions { display: flex; gap: 6px; }
  .btn { border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; transition: opacity 0.2s; }
  .btn:hover { opacity: 0.8; }
  .btn-restart { background: #00d4ff; color: #0f0f23; }
  .btn-logs { background: #6c5ce7; color: white; }
  .btn-delete { background: #ff4444; color: white; }
  form { display: inline; margin: 0; }
</style></head><body>
<h1>🚀 Control de Misión OpenClaw</h1>
<p class="subtitle">${report.length} cliente(s) registrado(s) | Auto-refresh: <a href="?token=${token}" style="color:#00d4ff">↻</a></p>
<table>
  <tr><th>Cliente</th><th>Estado</th><th>Reinicios</th><th>Última Actividad</th><th>Acciones</th></tr>
  ${report.map(r => `<tr>
    <td><b>${r.slug}</b></td>
    <td>${r.status}</td>
    <td class="${r.restarts > 3 ? 'err' : r.restarts > 0 ? 'warn' : 'ok'}">${r.restarts}</td>
    <td>${r.lastActive}</td>
    <td class="actions">
      <form method="POST" action="/admin/restart/${r.slug}?token=${token}">
        <button class="btn btn-restart" type="submit">🔄 Iniciar/Reiniciar</button>
      </form>
      <a href="/admin/logs/${r.slug}?token=${token}" target="_blank">
        <button class="btn btn-logs" type="button">📋 Logs</button>
      </a>
      <form method="POST" action="/admin/delete/${r.slug}?token=${token}" onsubmit="return confirm('⚠️ ¿ELIMINAR a ${r.slug}? Esto borrará sus archivos y datos. IRREVERSIBLE.')">
        <button class="btn btn-delete" type="submit">🗑️ Borrar</button>
      </form>
    </td>
  </tr>`).join('')}
</table>
<p class="footer">Actualizado: ${new Date().toLocaleString('es-ES')} | Motor: OpenClaw v1.0</p>
</body></html>`;

        res.send(html);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

export async function adminRestartClient(req, res, activeSessions, startWhatsAppClient) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).send('No autorizado');
    const { slug } = req.params;

    try {
        const { data: soul } = await supabase.from('user_souls').select('client_id').eq('slug', slug).single();
        if (!soul?.client_id) throw new Error("Cliente no encontrado en DB");

        console.log(`🔄 [Admin] Reiniciando sesión de WhatsApp para ${slug}...`);

        // Si ya había una sesión, cerramos la conexión de Baileys
        if (activeSessions.has(soul.client_id)) {
            const session = activeSessions.get(soul.client_id);
            if (session && session.sock && typeof session.sock.logout === 'function') {
                try { await session.sock.logout(); } catch (e) { }
            }
            activeSessions.delete(soul.client_id);
        }

        // Borramos de Supabase para forzar re-vinculación limpia
        await supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('client_id', soul.client_id);

        const clientDir = `./clients/${slug}`;

        // Borramos carpetas Baileys auth locales por si acaso
        await Promise.all([
            fs.rm(`${clientDir}/baileys_auth_info`, { recursive: true, force: true }).catch(() => { }),
            fs.rm(`./clients_sessions/${slug}`, { recursive: true, force: true }).catch(() => { })
        ]);

        // Incrementamos contador
        await supabase.rpc('increment_restart', { p_client_id: soul.client_id });

        // Relanzamos
        startWhatsAppClient(soul.client_id, slug, clientDir).catch(e => {
            console.error(`Error de fondo en reinicio de ${slug}:`, e);
        });

        // Registrar en logs
        await supabase.from('system_logs').insert({
            level: 'warn',
            message: `Reinicio manual lanzado para cliente ${slug} org: Panel Web.`
        });
        res.redirect(`/admin/health?token=${req.query.token}`);
    } catch (err) {
        res.status(500).send(`Error reiniciando ${slug}: ${err.message}`);
    }
}

export async function adminLogoutWhatsApp(req, res, activeSessions) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { slug } = req.params;

    try {
        const { data: soul } = await supabase.from('user_souls').select('client_id').eq('slug', slug).single();
        if (!soul?.client_id) throw new Error("Cliente no encontrado en DB");

        console.log(`🔌 [Admin] Cerrando sesión (Logout) para ${slug}...`);

        if (activeSessions.has(soul.client_id)) {
            const session = activeSessions.get(soul.client_id);
            if (session && session.sock && typeof session.sock.logout === 'function') {
                await session.sock.logout().catch(() => { });
            }
            activeSessions.delete(soul.client_id);
        }

        // 1. Borrar de Supabase (MANDATORIO ya que usamos useSupabaseAuthState)
        const { error: dbError } = await supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('client_id', soul.client_id);

        if (dbError) console.error(`[Admin-Logout] Error DB:`, dbError.message);

        // 2. También borramos los archivos locales (Legacy o cache)
        const sessionDir = `./clients_sessions/${slug}`;
        const clientAuthDir = `./clients/${slug}/baileys_auth_info`;

        await Promise.all([
            fs.rm(sessionDir, { recursive: true, force: true }).catch(() => { }),
            fs.rm(clientAuthDir, { recursive: true, force: true }).catch(() => { })
        ]);

        res.json({ success: true, message: `Sesión de ${slug} CERRADA y ELIMINADA (DB + Local).` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

export async function adminDeleteClient(req, res, activeSessions) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).send('No autorizado');
    const { slug } = req.params;

    try {
        const { data: soul } = await supabase.from('user_souls').select('client_id').eq('slug', slug).single();

        // 1. Desconectar sesión activa de WhatsApp
        if (soul?.client_id && activeSessions.has(soul.client_id)) {
            const sessionData = activeSessions.get(soul.client_id);
            if (sessionData && sessionData.sock && typeof sessionData.sock.logout === 'function') {
                try { await sessionData.sock.logout(); } catch (e) { }
            }
            activeSessions.delete(soul.client_id);
            console.log(`🛑 [Delete] Sesión activa de WhatsApp terminada para ${slug}`);
        }

        // 2. Eliminar archivos locales (SOUL.md, USER.md, baileys_auth, etc.)
        const clientDir = `./clients/${slug}`;
        try {
            await fs.rm(clientDir, { recursive: true, force: true });
            console.log(`🗑️ [Delete] Archivos locales de ${slug} eliminados.`);
        } catch (e) {
            console.warn(`[Delete] Nota: Carpeta de ${slug} no encontrada o ya borrada.`);
        }

        // 3. PURGA NUCLEAR EN CASCADA — Eliminar TODOS los datos huérfanos
        let userIdToKill = soul?.client_id;
        if (!userIdToKill) {
            const { data: clientData } = await supabase.from('clients').select('user_id').eq('name', slug).single();
            if (clientData) userIdToKill = clientData.user_id;
        }

        if (userIdToKill) {
            console.log(`🧨 [Delete] Iniciando purga nuclear para ${slug} (${userIdToKill})...`);

            // Orden importa: primero las tablas dependientes, luego las principales
            const tablesToPurge = [
                'knowledge_edges',    // Relaciones del grafo
                'knowledge_nodes',    // Nodos del grafo
                'user_memories',      // Memorias vectoriales
                'raw_messages',       // Mensajes sin procesar
                'inbox_summaries',    // Resúmenes del inbox
                'contact_personas',   // Perfiles de contactos
                'system_logs',        // Logs del sistema
            ];

            for (const table of tablesToPurge) {
                try {
                    const { count, error } = await supabase
                        .from(table)
                        .delete({ count: 'exact' })
                        .eq('client_id', userIdToKill);

                    if (error) {
                        console.warn(`  ⚠️ [${table}] Error: ${error.message}`);
                    } else {
                        console.log(`  🗑️ [${table}] ${count || 0} filas eliminadas.`);
                    }
                } catch (e) {
                    console.warn(`  ⚠️ [${table}] Tabla no encontrada o error: ${e.message}`);
                }
            }

            // Finalmente, eliminar la cuenta principal
            await supabase.from('user_souls').delete().eq('client_id', userIdToKill);
            await supabase.from('clients').delete().eq('user_id', userIdToKill);
            console.log(`✅ [Delete] Cuenta ${slug} y TODOS sus datos eliminados completamente.`);
        }

        await supabase.from('system_logs').insert({
            level: 'info',
            message: `Cliente ${slug} eliminado completamente con purga nuclear en cascada.`
        });

        res.redirect(`/admin/health?token=${req.query.token}`);
    } catch (err) {
        console.error(`[Error] Fallo al borrar ${slug}:`, err);
        res.status(500).send(`Error eliminando ${slug}: ${err.message}`);
    }
}

/**
 * API: Eliminar cliente completo (Purga Nuclear) via JSON
 */
export async function adminApiDeleteClient(req, res, activeSessions) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { slug } = req.params;

    try {
        console.log(`🧨 [Admin API] Iniciando purga nuclear para ${slug}...`);
        const { data: soul } = await supabase.from('user_souls').select('client_id').eq('slug', slug).single();

        // 1. Desconectar sesión activa de WhatsApp
        if (soul?.client_id && activeSessions.has(soul.client_id)) {
            const sessionData = activeSessions.get(soul.client_id);
            if (sessionData && sessionData.sock && typeof sessionData.sock.logout === 'function') {
                try { await sessionData.sock.logout(); } catch (e) { }
            }
            activeSessions.delete(soul.client_id);
        }

        // 2. Eliminar archivos locales
        const clientDir = `./clients/${slug}`;
        const sessionDir = `./clients_sessions/${slug}`;
        await fs.rm(clientDir, { recursive: true, force: true }).catch(() => { });
        await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => { });

        // 3. Purga en base de datos
        let userIdToKill = soul?.client_id;
        if (!userIdToKill) {
            const { data: clientData } = await supabase.from('clients').select('user_id').eq('name', slug).single();
            if (clientData) userIdToKill = clientData.user_id;
        }

        if (userIdToKill) {
            const tablesToPurge = [
                'knowledge_edges', 'knowledge_nodes', 'user_memories',
                'raw_messages', 'inbox_summaries', 'contact_personas', 'system_logs'
            ];

            for (const table of tablesToPurge) {
                await supabase.from(table).delete().eq('client_id', userIdToKill).catch(() => { });
            }

            await supabase.from('user_souls').delete().eq('client_id', userIdToKill);
            await supabase.from('clients').delete().eq('user_id', userIdToKill);
        }

        await supabase.from('system_logs').insert({
            level: 'info',
            message: `Cliente ${slug} ELIMINADO permanentemente desde el Dashboard.`
        });

        res.json({ success: true, message: `Cliente ${slug} y todos sus datos han sido eliminados.` });
    } catch (err) {
        console.error(`[Admin API] Fallo al borrar ${slug}:`, err);
        res.status(500).json({ error: err.message });
    }
}

export async function adminViewLogs(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).send('No autorizado');
    const { slug } = req.params;

    try {
        const { data: logs } = await supabase
            .from('system_logs')
            .select('*')
            .filter('message', 'ilike', `%${slug}%`)
            .order('created_at', { ascending: false })
            .limit(100);

        let logOutput = logs?.map(l => `[${new Date(l.created_at).toISOString()}] [${l.level.toUpperCase()}] ${l.message}`).join('\n') || 'Sin logs.';

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Logs: ${slug}</title>
<style>
  body { font-family: 'Courier New', monospace; background: #0a0a1a; color: #00ff88; padding: 30px; }
  pre { background: #111; padding: 20px; border-radius: 8px; overflow-x: auto; line-height: 1.6; font-size: 13px; border: 1px solid #2a2a4e; white-space: pre-wrap; }
</style></head><body>
<h1>📋 Logs de <b>${slug}</b></h1>
<pre>${logOutput.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body></html>`;
        res.send(html);
    } catch (err) {
        res.status(500).send(err.message);
    }
}

export async function adminGetLogs(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { slug } = req.params;
    try {
        const { data: logs } = await supabase
            .from('system_logs')
            .select('*')
            .filter('message', 'ilike', `%${slug}%`)
            .order('created_at', { ascending: false })
            .limit(50);
        res.json(logs || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}


/**
 * API: Retorna estadísticas base para el dashboard SPA
 */
export async function adminGetStats(req, res, activeSessions, qrCodes, pairingCodes) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

    try {
        // Fetch clients with stability fallback
        const { data: clients, error: clientError } = await supabase
            .from('user_souls')
            .select('client_id, slug, port, last_active, restart_count, is_processing, worker_status, soul_json');

        if (clientError) {
            console.error('[AdminStats] Supabase client fetch error:', clientError);
        }

        const memoryUsage = process.memoryUsage();

        // Get Docker containers info
        let dockerContainers = [];
        try {
            const { stdout } = await execPromise('docker ps -a --format "{{.Names}}\\t{{.Status}}\\t{{.Image}}"');
            dockerContainers = stdout.trim().split('\n').filter(Boolean).map(line => {
                const [name, status, image] = line.split('\t');
                return { name, status, image };
            });
        } catch (e) {
            console.error('[AdminStats] Docker error:', e.message);
        }

        // Get Docker stats for CPU/Memory usage
        let dockerStats = {};
        try {
            const { stdout: statsOut } = await execPromise('docker stats --no-stream --format "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}"');
            statsOut.trim().split('\n').filter(Boolean).forEach(line => {
                const [name, cpu, mem, memPerc] = line.split('\t');
                dockerStats[name] = { cpu, mem, memPerc };
            });
        } catch (e) {
            console.warn('[AdminStats] Docker stats error:', e.message);
        }

        const stats = {
            system: {
                ram_rss: (memoryUsage.rss / 1024 / 1024).toFixed(2),
                ram_heap: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2),
                uptime: process.uptime(),
                sessions_active: activeSessions.size
            },
            clients: (clients || []).map(c => {
                // Calculate dynamic identity score based on soul_json completion
                const soul = c.soul_json || {};
                const criticalFields = ['nombre', 'bio', 'profile', 'network', 'goals', 'playbook', 'axiomas_filosoficos'];
                const completedFields = criticalFields.filter(f => soul[f] && (typeof soul[f] === 'object' ? Object.keys(soul[f]).length > 0 : soul[f].length > 0));
                const identityScore = Math.min(100, Math.round((completedFields.length / criticalFields.length) * 100));

                return {
                    client_id: c.client_id,
                    slug: c.slug,
                    port: c.port,
                    last_active: c.last_active,
                    restart_count: c.restart_count,
                    is_processing: c.is_processing,
                    worker_status: c.worker_status || (c.is_processing ? '🧠 Procesando...' : '○ Cerebro en reposo'),
                    identity_score: identityScore || (soul.is_onboarded ? 85 : 10), // Base score if onboarded
                    is_online: activeSessions.has(c.client_id),
                    whatsapp: {
                        connected: activeSessions.has(c.client_id) && activeSessions.get(c.client_id)?.user ? true : false,
                        has_qr: qrCodes ? qrCodes.has(c.client_id) : false,
                        qr: qrCodes ? qrCodes.get(c.client_id) : null,
                        pairing_code: pairingCodes ? pairingCodes.get(c.client_id) : null
                    }
                };
            }),
            containers: dockerContainers.map(ct => ({
                ...ct,
                resources: dockerStats[ct.name] || { cpu: '0%', mem: '0B / 0B', memPerc: '0%' }
            }))
        };

        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * API: Controla un contenedor Docker
 */
export async function adminControlContainer(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { action, containerName } = req.params;

    const allowedActions = ['start', 'stop', 'restart', 'logs'];
    if (!allowedActions.includes(action)) {
        return res.status(400).json({ error: 'Acción no permitida' });
    }

    try {
        console.log(`[Admin] Container Action: ${action} on ${containerName}`);

        if (action === 'logs') {
            const { stdout } = await execPromise(`docker logs --tail 100 ${containerName}`);
            return res.json({ logs: stdout });
        }

        await execPromise(`docker ${action} ${containerName}`);

        // Log to system_logs
        await supabase.from('system_logs').insert({
            level: 'info',
            message: `Docker ${action} ejecutado sobre ${containerName} desde Panel.`
        });

        res.json({ success: true, message: `Contenedor ${containerName} ha sido ${action}ed` });
    } catch (err) {
        console.error(`[Admin] Container action failed:`, err.message);
        res.status(500).json({ error: err.message });
    }
}

/**
 * API: Obtiene y descifra todos los archivos de memoria (.md) de un cliente
 */
export async function adminGetClientFiles(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { slug } = req.params;

    try {
        const clientDir = path.resolve(`./clients/${slug}`);
        const files = await fs.readdir(clientDir);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        const result = {};
        for (const file of mdFiles) {
            const content = await fs.readFile(path.join(clientDir, file), 'utf8');
            result[file] = decrypt(content);
        }

        res.json({ files: result });
    } catch (err) {
        res.status(500).json({ error: `Error leyendo archivos de ${slug}: ${err.message}` });
    }
}

/**
 * API: Neural Terminal - Prueba el cerebro directamente (con RAG Trace)
 */
export async function adminNeuralChat(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { clientId, text, remoteId } = req.body;

    if (!clientId || !text) return res.status(400).json({ error: 'Faltan parámetros' });

    try {
        // Fetch slug for the client
        const { data: soul } = await supabase.from('user_souls').select('slug').eq('client_id', clientId).single();
        const clientSlug = soul?.slug || 'unknown';

        console.log(`🧠 [Neural Terminal] Testing for ${clientId} (${clientSlug}): "${text.slice(0, 30)}..."`);
        const reply = await processMessage({
            clientId,
            clientSlug,
            text,
            senderId: remoteId || 'terminal-admin',
            pushName: 'Admin Debugger',
            channel: 'terminal'
        });

        // Fetch latest RAG trace for this client to show in the dashboard
        let trace = null;
        try {
            const { data } = await supabase
                .from('rag_metrics')
                .select('*')
                .eq('client_id', clientId)
                .order('created_at', { ascending: false })
                .limit(1);
            if (data?.[0]) trace = data[0];
        } catch (e) { /* non-critical */ }

        res.json({ reply, trace });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * API: RAG Quality Metrics — Métricas de calidad del pipeline cognitivo
 */
export async function adminGetRagMetrics(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { clientId, days } = req.query;

    try {
        const metrics = await getAggregatedMetrics(clientId || null, parseInt(days) || 7);
        res.json(metrics);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * API: Get all system config (for dashboard editor)
 */
export async function adminGetConfig(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    try {
        const config = await getAllConfig();
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * API: Update a system config value
 */
export async function adminSetConfig(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Falta key' });
    try {
        await setConfig(key, value);
        res.json({ success: true, key, value });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}
/**
 * API: Post feedback for a RAG response
 */
export async function adminPostFeedback(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { traceId, feedback } = req.body;

    if (!traceId || !feedback) return res.status(400).json({ error: 'Faltan parámetros' });

    try {
        const { data: trace } = await supabase.from('rag_metrics').select('metadata').eq('id', traceId).single();
        if (!trace) throw new Error("Trace no encontrado");

        const updatedMetadata = { ...trace.metadata, user_feedback: feedback };

        const { error } = await supabase
            .from('rag_metrics')
            .update({ metadata: updatedMetadata })
            .eq('id', traceId);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * API: Obtiene las últimas 5 entradas de caché semántica de un cliente
 */
export async function adminGetCache(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { clientId } = req.params;

    try {
        const cacheKey = `semcache:${clientId}`;
        const rawCache = await redisClient.get(cacheKey);
        const entries = rawCache ? JSON.parse(rawCache) : [];
        // Devolvemos solo lo relevante para el dashboard
        res.json(entries.slice(0, 5).map(e => ({
            query: e.query || "Query no registrada (Legacy)",
            reply: e.reply,
            timestamp: e.timestamp
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * API: Limpia la caché semántica de un cliente
 */
export async function adminClearCache(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { clientId } = req.params;

    try {
        const cacheKey = `semcache:${clientId}`;
        await redisClient.del(cacheKey);
        res.json({ success: true, message: "Caché semántica purgada." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * API: Guarda un archivo (.md) editado por el administrador
 */
export async function adminSaveClientFile(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
    const { slug, filename } = req.params;
    const { content } = req.body;

    if (!content) return res.status(400).json({ error: 'Falta el contenido' });

    try {
        const clientDir = path.resolve(`./clients/${slug}`);
        const filePath = path.join(clientDir, filename);

        // Seguridad: Verificar que el archivo existe y es .md
        if (!filename.endsWith('.md')) throw new Error("Solo archivos .md permitidos");

        await fs.access(filePath); // Asegurar que existe

        // Cifrar y guardar
        const encryptedContent = encrypt(content);
        await fs.writeFile(filePath, encryptedContent, 'utf8');

        // Log
        await supabase.from('system_logs').insert({
            level: 'warn',
            message: `Edición manual "Cirujano" en ${filename} para cliente ${slug}.`
        });

        res.json({ success: true, message: `${filename} actualizado y cifrado.` });
    } catch (err) {
        res.status(500).json({ error: `Error guardando archivo: ${err.message}` });
    }
}

