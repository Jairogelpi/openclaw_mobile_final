import fs from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import supabase from '../config/supabase.mjs';

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
            const sessionData = activeSessions.get(soul.client_id);
            if (sessionData && sessionData.sock && typeof sessionData.sock.logout === 'function') {
                try { await sessionData.sock.logout(); } catch (e) {
                    // Ignoramos errores de logout
                }
            }
            activeSessions.delete(soul.client_id);
        }

        const clientDir = `./clients/${slug}`;

        // Borramos la carpeta Baileys auth para forzar nuevo QR/Pair
        try {
            await fs.rm(`${clientDir}/baileys_auth_info`, { recursive: true, force: true });
        } catch (e) { }

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


export async function adminViewLogs(req, res) {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).send('No autorizado');
    const { slug } = req.params;

    try {
        const clientDir = path.resolve(`./clients/${slug}`);
        const tempLogsFile = path.join(clientDir, 'gateway.log'); // Por si loggeamos cosas por cliente aquí

        let logOutput = '';

        try {
            // Check if file exists in the filesystem directly
            logOutput = await fs.readFile(tempLogsFile, 'utf8');
        } catch (fsErr) {
            // Intento secundario: buscar en system_logs global por nombre del slug
            const { data: logs } = await supabase
                .from('system_logs')
                .select('*')
                .filter('message', 'ilike', `%${slug}%`)
                .order('created_at', { ascending: false })
                .limit(50);

            if (logs && logs.length > 0) {
                logOutput = logs.map(l => `[${new Date(l.created_at).toISOString()}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
            } else {
                logOutput = `No se encontraron logs locales ni en la DB para ${slug}.\n(El archivo físico podría no existir tras reiniciar el servidor).\n\nPara logs globales usa PM2 (pm2 logs) o el panel de Supabase.`;
            }
        }

        // Generar un HTML simple para leer logs oscuros estilo consola
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Logs: ${slug}</title>
<style>
  body { font-family: 'Courier New', monospace; background: #0a0a1a; color: #00ff88; padding: 30px; }
  h1 { color: #00d4ff; font-family: 'Segoe UI', sans-serif; }
  pre { background: #111; padding: 20px; border-radius: 8px; overflow-x: auto; line-height: 1.6; font-size: 13px; border: 1px solid #2a2a4e; white-space: pre-wrap; }
  a { color: #00d4ff; }
</style></head><body>
<h1>📋 Logs de <b>${slug}</b></h1>
<p><a href="/admin/health?token=${req.query.token}">← Volver al Dashboard</a> | <a href="/admin/logs/${slug}?token=${req.query.token}">↻ Refresh</a></p>
<pre>${logOutput.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body></html>`;

        res.send(html);
    } catch (err) {
        res.status(500).send(`Error crítico obteniendo logs de ${slug}: ${err.message}`);
    }
}
