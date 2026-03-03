import 'dotenv/config';
import cron from 'node-cron';
import supabase from './config/supabase.mjs';
import groq from './services/groq.mjs';
import { activeSessions, sendHumanLikeMessage } from './channels/whatsapp.mjs';
import logger from './utils/logger.mjs';

/**
 * Pulse Worker: El corazón proactivo de OpenClaw.
 * Este worker despierta periódicamente para analizar oportunidades de engagement.
 */

async function analyzeProactiveOpportunities(clientId) {
    try {
        console.log(`💓 [Pulse] Analizando oportunidades para: ${clientId}`);

        // 1. Obtener el Alma y el Perfil
        const { data: clientData } = await supabase
            .from('user_souls')
            .select('soul_json, slug')
            .eq('client_id', clientId)
            .single();

        if (!clientData) return;
        const { soul_json, slug } = clientData;

        // 2. Obtener resúmenes de inbox recientes
        const { data: summaries } = await supabase
            .from('inbox_summaries')
            .select('*')
            .eq('client_id', clientId)
            .order('last_message_time', { ascending: false })
            .limit(10);

        if (!summaries || summaries.length === 0) {
            console.log(`💓 [Pulse] No hay conversaciones recientes para analizar.`);
            return;
        }

        // 3. Filtrar conversaciones "frías" (ej: > 24h sin mensajes)
        const now = new Date();
        const coldConversations = summaries.filter(s => {
            const lastMsgTime = new Date(s.last_message_time);
            const hoursDiff = (now - lastMsgTime) / (1000 * 60 * 60);
            return hoursDiff > 24; // Fría si pasaron más de 24 horas
        });

        if (coldConversations.length === 0) {
            console.log(`💓 [Pulse] Todas las conversaciones están activas.`);
            return;
        }

        console.log(`💓 [Pulse] ${coldConversations.length} conversaciones frías detectadas.`);

        // 4. Razonamiento Proactivo por conversación
        for (const conv of coldConversations) {
            // Obtener perfil de la relación
            const { data: personaRow } = await supabase
                .from('contact_personas')
                .select('persona_json')
                .eq('client_id', clientId)
                .eq('remote_id', conv.conversation_id)
                .single();

            const persona = personaRow?.persona_json || {};

            const proactivePrompt = `Eres el Estratega de Relaciones de OpenClaw. Analizas una conversación estancada y decides si es oportuno enviar un "globo sonda" proactivo.

IDENTIDAD DEL DUEÑO:
${JSON.stringify(soul_json)}

ESTADO DE LA CONVERSACIÓN CON "${conv.contact_name || conv.group_name || conv.conversation_id}":
- Resumen previo: ${conv.summary}
- Último mensaje: ${conv.last_message_text}
- Perfil de relación: ${JSON.stringify(persona)}

TAREA:
1. Evalúa si tiene sentido escribirle ahora (basado en afinidad y contexto).
2. Si sí, redacta un mensaje BREVE y NATURAL usando el estilo único del dueño (revisa style_profile).
3. El mensaje debe ser una pregunta abierta o un recordatorio útil, NO un "hola" genérico.

Responde JSON:
{
  "should_send": boolean,
  "reasoning": "string",
  "suggested_message": "string"
}`;

            try {
                const response = await groq.chat.completions.create({
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'system', content: proactivePrompt }],
                    response_format: { type: 'json_object' },
                    temperature: 0.3
                });

                const decision = JSON.parse(response.choices[0].message.content);
                console.log(`🧠 [Pulse] Decisión para ${conv.conversation_id}: ${decision.reasoning}`);

                if (decision.should_send && decision.suggested_message) {
                    // 5. Verificación de permisos y envío
                    const sock = activeSessions.get(clientId);
                    if (sock) {
                        console.log(`🚀 [Pulse] Enviando mensaje proactivo a ${conv.conversation_id}...`);
                        await sendHumanLikeMessage(clientId, conv.conversation_id, { text: decision.suggested_message });

                        // Registrar en raw_messages como 'assistant' (proactivo)
                        await supabase.from('raw_messages').insert({
                            client_id: clientId,
                            sender_role: 'assistant',
                            content: decision.suggested_message,
                            remote_id: conv.conversation_id,
                            metadata: { proactive: true, reasoning: decision.reasoning }
                        });
                    } else {
                        console.log(`⚠️ [Pulse] Sesión no activa para ${clientId}. No se pudo enviar el pulso.`);
                    }
                }
            } catch (err) {
                console.error(`❌ [Pulse] Error razonando para ${conv.conversation_id}:`, err.message);
            }
        }
    } catch (e) {
        console.error(`❌ [Pulse] Error en el análisis proactivo:`, e.message);
    }
}

// === SCHEDULER: El Pulso late cada 4 horas ===
cron.schedule('0 */4 * * *', async () => {
    console.log('💓 [Pulse] Iniciando latido proactivo global...');
    const { data: clients } = await supabase.from('user_souls').select('client_id');
    for (const client of clients) {
        await analyzeProactiveOpportunities(client.client_id);
    }
});

// HEARTBEAT LOG
setInterval(() => {
    console.log('💓 [Pulse-Health] Worker Proactivo latiendo...');
}, 3600_000);

console.log('🚀 [Pulse Worker] Motor Proactivo Online. Próximo latido programado.');

// Export para trigger manual (si se necesita desde dashboard)
export { analyzeProactiveOpportunities };
