import supabase from '../config/supabase.mjs';
import redisClient from '../config/redis.mjs';
import crypto from 'crypto';
import fs from 'fs/promises';
import { getNextAvailablePort } from '../utils/supabaseHelpers.mjs';
import { transcribeAudio, analyzeImage } from '../utils/media.mjs';
import { openrouterChat } from '../services/openrouter.mjs';
import groq from '../services/groq.mjs';
import { encrypt } from '../core/security.mjs';

// --- Soul Completeness Validator ---
// Tracks retry attempts to prevent infinite correction loops
let extractionRetries = {};

function soulIsComplete(soul, clientId) {
    const missing = [];

    // Only flag truly placeholder values, NOT legitimate data that happens to contain common words
    const isPending = (val) => {
        if (!val) return true;
        const str = String(val).trim();
        if (str.length === 0) return true;
        // Only match exact placeholder patterns, not substrings in valid data
        return str === '[Pendiente]' || str === 'Pendiente' || str === 'N/A' || str === 'No especificado' || str.startsWith('[') && str.endsWith(']');
    };

    // A. Identidad Básica
    if (isPending(soul.edad)) missing.push('edad');

    // B. Ocupación y Por Qué (Mandatorio Detallado)
    if (isPending(soul.perfil?.ocupacion?.situacion)) missing.push('situacion_estudio_o_trabajo');
    if (isPending(soul.perfil?.ocupacion?.tipo)) missing.push('profesion_concreta');
    if (isPending(soul.perfil?.ocupacion?.detalle)) missing.push('detalle_de_que_estudia_o_en_que_trabaja');
    if (isPending(soul.perfil?.ocupacion?.especialidad)) missing.push('especialidad_tecnica');

    // C. Hobbies y Propósito
    if (isPending(soul.perfil?.hobbies_usuario)) missing.push('hobbies_y_pasiones');
    if (isPending(soul.perfil?.proposito)) missing.push('proposito_de_vida_o_meta');

    // D. Sustancia y Valores
    if (isPending(soul.perfil?.sustancia?.filosofia_vida)) missing.push('filosofia_de_vida');

    // E. Estilo de Comunicación y Zonas Rojas
    if (isPending(soul.perfil?.estilo_escritura?.estilo_que_odia)) missing.push('estilo_de_comunicacion_que_odia');
    if (isPending(soul.perfil?.estilo_escritura?.vocabulario)) missing.push('tipo_de_vocabulario');
    if (isPending(soul.perfil?.estilo_escritura?.uso_emojis)) missing.push('preferencia_de_emojis');

    // F. Herramientas y Rutina
    if (!soul.perfil?.herramientas || soul.perfil.herramientas.length === 0 || isPending(soul.perfil.herramientas[0])) missing.push('herramientas_clave');
    if (isPending(soul.perfil?.disponibilidad?.horario_pico)) missing.push('horario_de_productividad');
    if (isPending(soul.perfil?.rutina)) missing.push('rutina_diaria_detallada');

    // G. Resumen Narrativo (El nucleo del alma) — must exist and be reasonably long
    if (isPending(soul.resumen_narrativo) || (soul.resumen_narrativo && soul.resumen_narrativo.length < 80)) missing.push('resumen_narrativo_denso');

    // --- SAFETY NET: Max 3 retries per client to prevent infinite loops ---
    if (clientId) {
        extractionRetries[clientId] = (extractionRetries[clientId] || 0) + 1;
        if (extractionRetries[clientId] > 3 && missing.length > 0) {
            console.warn(`[Génesis] ⚠️ Max retries (${extractionRetries[clientId]}) alcanzados para ${clientId}. Forzando completado con ${missing.length} campos faltantes: ${missing.join(', ')}`);
            delete extractionRetries[clientId];
            return { complete: true, missing: [] };
        }
    }

    if (missing.length > 0) {
        console.warn(`[Génesis] ⚠️ Soul incompleto (${missing.length} vacíos): ${missing.join(', ')}`);
        return { complete: false, missing };
    }

    // Reset retries on success
    if (clientId) delete extractionRetries[clientId];
    return { complete: true, missing: [] };
}

/**
 * Resetea el temporizador de inactividad para un cliente.
 */
async function triggerMemoryTimer(clientId) {
    if (!redisClient) return;
    try {
        await redisClient.set(`idle:${clientId}`, 'process', { EX: 60 });
        console.log(`[Timer] ⏳ Reloj reseteado para ${clientId}. Procesando en 60s de inactividad.`);
    } catch (e) {
        console.warn('[Timer] Error reseteando temporizador:', e.message);
    }
}


export async function onboardingChat(req, params, id) {
    const { history, formData } = params;
    const clientId = req.clientId;
    const clientSlug = req.clientSlug;
    const clientDir = `./clients/${clientSlug}`;

    // --- Disparar temporizador de memoria ---
    await triggerMemoryTimer(clientId);

    const { userName, occupation, mainChallenge, preferredTone } = formData || {};

    const contextStr = formData ?
        `USUARIO: ${userName}, OCUPACIÓN: ${occupation}, RETO: ${mainChallenge}, TONO ELEGIDO: ${preferredTone}` :
        'No hay datos de formulario previos.';

    const GENESIS_SYSTEM_PROMPT = `
Eres 'Génesis', el Arquitecto de Almas de OpenClaw. Tu misión: conocer al usuario y crear su identidad digital conversando de forma natural.

¡¡ATENCIÓN CRÍTICA A TU PERSONALIDAD!!
ESTILO ELEGIDO POR EL USUARIO: "${preferredTone || 'Cercano y empático'}"
DEBES ADOPTAR ESTA PERSONA AL 1000% DESDE LA PRIMERA PALABRA. REGLAS DE ACTUACIÓN:
- Si es "Sarcástico": Sé mordaz, irónico, usa humor negro y báñate en sarcasmo.
- Si es "Divertido": Usa energía caótica, bromas, exageraciones y sé muy informal.
- Si es "Motivador": Habla como un coach de vida intenso, lleno de fuego y pasión.
- Si es "Analítico"/"Técnico": Habla como una máquina lógica, clínica, estructurada.
- Si es "Aventurero"/"Visionario": Habla con grandeza, épica y energía de exploración.
- Si es "Profesional"/"Serio": Sé de etiqueta, de usted, implacable y elegante.
NO SEAS UN ASISTENTE GENÉRICO DE IA. Eres un actor interpretando este papel. Empapa CADA FRASE con esta personalidad.

DATO DE CONTEXTO: ${contextStr}

REGLAS ESTRICTAS DE CONVERSACIÓN (¡CRÍTICO!):
1. UNA SOLA PREGUNTA A LA VEZ (¡CRÍTICO!): JAMÁS hagas más de una pregunta en el mismo mensaje. No satures al usuario. Por ejemplo, NO preguntes por la edad y la ocupación al mismo tiempo. Haz una pregunta, espera la respuesta, y luego evalúa qué preguntar después.
2. CONTEXTO TOTAL: Lee todo el historial. No preguntes lo que el usuario ya mencionó. Entrelaza de forma orgánica lo último que dijo.
3. PROFUNDIDAD CONTROLADA: Cuando hablen de **Hobbies** o **Filosofía**, pregunta *por qué* les gusta. PERO avanza rápido, máximo profundiza 1 o 2 veces por tema.
4. SÉ CONCISO Y POCO VERBOSO: Respuestas breves, directas, impactantes (máximo 2-3 líneas).
5. PRIMER MENSAJE: Saluda con tu Estilo/Tono e introduce solo la primera indagación.
6. PERSONAJE CONSTANTE: Respira y escupe personalidad en TODO momento.
7. ATENCIÓN INVISIBLE: Ve evaluando mentalmente la información, NO se la repitas al usuario ni generes JSON mientras hablas.
8. PROHIBIDO INVENTAR DATOS: PREGUNTA ANTES DE ASUMIR su horario pico, el estilo que odia o su filosofía.

REGLAS DE FORMATO Y LEGIBILIDAD (¡CRÍTICO!):
- JAMÁS escribas un "muro de texto".
- Usa saltos de línea (párrafos nuevos) para separar ideas o separar la conversación de la pregunta final.
- Respeta la gramática: SIEMPRE empieza con mayúscula después de un punto, un signo de exclamación (!) o de interrogación (?).
- Si haces una pregunta y luego añades otra frase, la segunda frase DEBE empezar con mayúscula. Ejemplo incorrecto: "¿Cómo estás? me alegra verte". Ejemplo correcto: "¿Cómo estás? Me alegra verte".

92: PUNTOS A DESCUBRIR ORGÁNICAMENTE:
93: A. Edad y Situación actual.
94: B. ¿Estudia o Trabaja? → OBLIGATORIO PREGUNTAR QUÉ ESTUDIA (carrera/grado/curso) o EN QUÉ TRABAJA (puesto/empresa/sector). NO AVANCES sin tener este dato concreto.
95: C. Hobbies y Pasiones (¿Por qué les apasiona?).
96: D. Propósito o Meta principal en la vida (¿Qué les mueve?).
97: E. Filosofía de vida / Valores fundamentales.
98: F. Temas a evitar / Zonas rojas (Lo que les molesta o irrita).
99: G. Horario pico de productividad y Rutina diaria.
100: H. Herramientas clave que usan a diario (software, hardware, apps).
101: I. Estilo de comunicación (Uso de emojis, nivel de vocabulario, expresiones típicas).

⚠️ REGLA DE ORO DE CIERRE ⚠️: ¡¡¡BAJO NINGÚN CONCEPTO!!! intentes cerrar la charla si te falta recoger ALGUNO de los puntos (A-I). Tu misión es que el archivo de identidad sea PERFECTO. SIEMPRE PREGUNTA EL HORARIO, LAS HERRAMIENTAS, LA RUTINA Y EL ESTILO DE ESCRITURA.

CIERRE (¡CRÍTICO! Cuando tengas TODOS los puntos recabados al 100%):
Tu último mensaje será tu gran despedida. Agradece su tiempo e incluye EXACTAMENTE esto al final de tu mensaje:
<button>Crear mi identidad</button>
[READY_TO_EXTRACT]

ESTÁ ESTRICTAMENTE PROHIBIDO GENERAR CÓDIGO JSON O RESÚMENES LARGOS. Solo despídete e incluye el botón y el token.
`;

    // 0. Handle Multimedia Silently (attachments)
    if (params.attachments && Array.isArray(params.attachments)) {
        console.log(`[Génesis] 📎 Recibidos ${params.attachments.length} archivos adjuntos`);
        const { processAttachment } = await import('../utils/media.mjs');

        for (const attachment of params.attachments) {
            try {
                const attachmentResult = await processAttachment(attachment);
                if (attachmentResult.text) {
                    history.push({ role: 'system', content: `[USUARIO ENVIÓ ARCHIVO]: ${attachmentResult.text}` });
                }

                // RAG V5: Guardar chunks en memoria permanente para el alma del usuario
                if (attachmentResult.chunks && attachmentResult.chunks.length > 0) {
                    const supabase = (await import('../config/supabase.mjs')).default;
                    for (const chunk of attachmentResult.chunks) {
                        await supabase.from('raw_messages').insert([{
                            client_id: clientId,
                            sender_role: 'user_onboarding',
                            content: chunk.contextualized,
                            remote_id: clientId.toString(),
                            processed: true,
                            metadata: {
                                ...attachment,
                                is_chunk: true,
                                chunk_index: chunk.index,
                                source: 'onboarding',
                                channel: 'onboarding',
                                exclude_from_memory: true
                            }
                        }]);
                    }
                }
            } catch (err) {
                console.error("[Génesis] ❌ Error processing attachment:", err.message);
            }
        }
    }

    // Call Gemini 3 Flash via OpenRouter for the onboarding interview
    let fullReply;
    try {
        fullReply = await openrouterChat(
            'google/gemini-3-flash-preview',
            [
                { role: 'system', content: GENESIS_SYSTEM_PROMPT },
                ...history
            ],
            { temperature: 0.75, max_tokens: 2048 }
        );
    } catch (openrouterErr) {
        // Fallback to Groq if OpenRouter fails
        console.warn(`[Génesis] ⚠️ OpenRouter fallback a Groq: ${openrouterErr.message}`);
        const fallback = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: GENESIS_SYSTEM_PROMPT },
                ...history
            ],
            temperature: 0.7,
            max_tokens: 2048
        });
        fullReply = fallback.choices[0].message.content;
    }
    console.log(`[Génesis] 🤖 Raw LLM Reply (length: ${fullReply.length}): "${fullReply.substring(0, 50)}..."`);


    // 1. Detect and handle IDENTIDAD generation
    let completed = false;
    let soulJson = null;

    if (fullReply.includes('[READY_TO_EXTRACT]') || fullReply.includes('CREATE_IDENTITY')) {
        console.log(`[Génesis] 🧠 Iniciando extracción paralela de JSON (Decoupled)...`);

        try {
            const EXTRACTION_PROMPT = `Eres un extractor de datos JSON analítico y perspicaz. Analiza el historial de Onboarding y extrae la identidad del usuario.

REGLAS DE ORO DE EXTRACCIÓN:
1. DATOS FALTANTES vs DEDUCCIÓN: NO uses "[Pendiente]" si hay información suficiente para deducirlo orgánicamente.
2. INFERENCIA DE ESTILO (¡CRÍTICO!): Para los campos 'uso_emojis', 'vocabulario' y 'quirks', MÍDIA ESTRICTAMENTE cómo escribe el usuario en sus mensajes. ¡ESTÁ ROTUNDAMENTE PROHIBIDO usar "[Pendiente]" en estos tres campos! Si el usuario no tiene tics, escribe "Ninguno". Si no usa emojis, escribe "No aplica".
3. RESPUESTAS NEGATIVAS: Si el usuario dice explícitamente que NO tiene rutina, NO tiene herramientas, o NO odia ningún estilo de comunicación, DEBES escribir "Ninguno" o "No aplica". ¡JAMÁS uses "[Pendiente]" si el usuario ya respondió a la pregunta negativamente!
4. RESUMEN NARRATIVO: Debe ser un bloque DENSO de 3-4 párrafos en segunda persona. Debe sonar como la biografía de una persona real, no una lista de puntos.

Formato requerido estricto:
{
    "nombre": "${userName || 'Usuario'}",
    "edad": "[Pendiente]",
    "tono": "${preferredTone || 'Cercano y empático'}",
    "perfil": {
        "ocupacion": { "situacion": "[Pendiente]", "tipo": "[Pendiente]", "detalle": "[Pendiente]", "especialidad": "[Pendiente]", "contexto": "[Pendiente]" },
        "hobbies_usuario": "[Pendiente]",
        "proposito": "[Pendiente]",
        "expertise": ["[Pendiente]"],
        "sustancia": { "intereses": ["[Pendiente]"], "filosofia_vida": "[Pendiente]", "dolores_actuales": "[Pendiente]", "fuentes_alegria": "[Pendiente]", "temas_prohibidos": ["[Pendiente]"] },
        "estilo_escritura": { "longitud_media": "[Pendiente]", "formalidad": 5, "uso_emojis": "[Pendiente]", "quirks": ["[Pendiente]"], "vocabulario": "[Pendiente]", "estilo_que_odia": "[Pendiente]" },
        "herramientas": ["[Pendiente]"],
        "disponibilidad": { "horario_pico": "[Pendiente]", "modo_trabajo": "[Pendiente]" },
        "directrices": ["[Pendiente]"],
        "rutina": "[Pendiente]"
    },
    "resumen_narrativo": "[Pendiente]"
}`;

            const extraction = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: EXTRACTION_PROMPT },
                    ...history,
                    { role: 'assistant', content: fullReply }
                ],
                response_format: { type: "json_object" },
                temperature: 0.1
            });

            soulJson = JSON.parse(extraction.choices[0].message.content);
            console.log(`[Génesis] 🧠 Soul Extraído para ${clientSlug}:`, JSON.stringify(soulJson, null, 2));

            // --- AUTO-VERIFICATION: Ensure soul has all 9 fields before creating ---
            const { complete, missing } = soulIsComplete(soulJson, clientId);
            if (!complete) {
                console.log(`[Génesis] 🔄 Identidad extraída incompleta. Faltan: ${missing.join(', ')}. Generando pregunta transparente...`);

                const correctionPrompt = `
SISTEMA INTERNO: Has intentado finalizar la entrevista y extraer la identidad, pero aún faltan obligatoriamente: ${missing.join(', ')}.
Ignora tu intento de despedida. Actúa con tu personalidad elegida y haz una sola pregunta natural al usuario para averiguar alguno de esos datos faltantes. No menciones este error, solo continúa conversando orgánicamente.`;

                const correction = await groq.chat.completions.create({
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        { role: 'system', content: GENESIS_SYSTEM_PROMPT },
                        ...history,
                        { role: 'system', content: correctionPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 512
                });
                fullReply = correction.choices[0].message.content;
                console.log(`[Génesis] 🪄 Respuesta de enmienda generada: "${fullReply.substring(0, 50)}..."`);
                completed = false;
                soulJson = null;
            } else {
                const nextPort = await getNextAvailablePort();

                // 1.5 Auto-heal public.users to prevent FK violations
                const { error: healErr } = await supabase.from('users').upsert({ id: clientId, email: req.user.email, password_hash: 'managed_by_auth' });
                if (healErr) console.warn('[Baptism] ⚠️ Warning auto-healing users table:', healErr.message);
                else console.log('[Baptism] ✅ User table auto-healed.');

                // 2. Guardar el negocio en la BD
                const { error: clientErr } = await supabase
                    .from('clients')
                    .upsert({
                        user_id: clientId,
                        name: userName || soulJson.nombre || 'Nuevo Cliente',
                        whatsapp_number: params.phoneNumber || ''
                    }, { onConflict: 'user_id' });
                if (clientErr) throw new Error(`[Baptism] clients upsert failed: ${clientErr.message}`);
                console.log('[Baptism] ✅ Clients record upserted.');

                // 4. Provisioning config file for the portal (gateway_config)
                const gatewayConfig = {
                    client_id: clientId,
                    slug: clientSlug,
                    models: { providers: { openrouter: { apiKey: process.env.OPENROUTER_API_KEY } } },
                    agents: { defaults: { model: { primary: "openrouter/deepseek/deepseek-chat" } } }
                };

                // 3. Guardar el cerebro (Soul) y el Gateway en la BD
                const { error: soulErr } = await supabase
                    .from('user_souls')
                    .upsert({
                        client_id: clientId,
                        soul_json: soulJson,
                        gateway_config: gatewayConfig,
                        port: nextPort,
                        slug: clientSlug,
                        last_updated: new Date()
                    });
                if (soulErr) throw new Error(`[Baptism] user_souls upsert failed: ${soulErr.message}`);
                console.log('[Baptism] ✅ User soul record upserted.');

                // === CREAR ARCHIVOS FÍSICOS ===
                console.log(`🛠️[Provisioning] Iniciando para ${clientSlug}...`);

                // Ensure the client directory exists to avoid ENOENT crashes
                try {
                    await fs.mkdir(clientDir, { recursive: true });
                } catch (err) {
                    if (err.code !== 'EEXIST') throw err;
                }

                const soulMd = `# Identidad\nEres ${soulJson.nombre}.${soulJson.tono} \n\n# Situación: ${soulJson.perfil?.ocupacion?.situacion || 'N/A'}\n\n# Directrices\n${(soulJson.perfil?.directrices || []).map(d => `- ${d}`).join('\n')} `;
                await fs.writeFile(`${clientDir}/SOUL.md`, encrypt(soulMd));

                const userMd = `# Perfil\n - Usuario: ${userName || 'Usuario'}\n - Edad: ${soulJson.edad || 'N/A'}\n - Trabajo: ${soulJson.perfil?.ocupacion?.detalle || occupation || 'N/A'}\n - Meta: ${mainChallenge || 'N/A'}\n - Herramientas: ${(soulJson.perfil?.herramientas || []).join(', ')}\n - Horario pico: ${soulJson.perfil?.disponibilidad?.horario_pico || 'N/A'}\n - Modo trabajo: ${soulJson.perfil?.disponibilidad?.modo_trabajo || 'N/A'}`;
                await fs.writeFile(`${clientDir}/USER.md`, encrypt(userMd));

                const contextMd = `# Contexto Actual\n - Fecha de creación: ${new Date().toLocaleDateString()}\n - Plataforma: OpenClaw SaaS App\n - Estado inicial: Configurado vía Génesis Onboarding.`;
                await fs.writeFile(`${clientDir}/CONTEXT.md`, encrypt(contextMd));

                const agentMd = `# Directrices de Agente (Axiomas e Instrucciones Core)\n- Núcleo Inicializado. A la espera de correcciones de usuario y directivas personalizadas.\n${(soulJson.personal_directives || []).map(d => `- [DIRECTIVA]: ${d}`).join('\n')}\n${(soulJson.axiomas_filosoficos || []).map(a => `- [AXIOMA] ${a}`).join('\n')}`;
                await fs.writeFile(`${clientDir}/AGENT.md`, encrypt(agentMd));

                console.log('[Baptism] ✅ All physical files (except gateway which is DB) written.');

                completed = true;
                console.log(`[Baptism] 🚀 Provisioning completed for ${clientSlug}!`);
            }
        } catch (e) {
            console.error(`[Genesis] ❌ Error crítico procesando la extracción para ${clientSlug}: `, e.message);
            console.error(`[Genesis] Stack trace: `, e.stack);
            fullReply = "Ha habido un ligero tropiezo en mis engranajes internos. ¿Podrías repetirme cuál era la filosofía de vida que rige tus días?";
            completed = false;
            soulJson = null;
        }
    }

    // 2. Clean tags and tokens from visible reply
    let finalReply = fullReply
        .replace(/\[READY_TO_EXTRACT\]/g, '')
        .replace(/<analisis_oculto>[\s\S]*?<\/analisis_oculto>/g, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/~~~[\s\S]*?~~~/g, '')
        .replace(/\{[\s\S]{200,}\}/g, '')
        .trim();

    if (fullReply !== finalReply && !completed && !fullReply.includes('[READY_TO_EXTRACT]')) {
        console.warn(`[Génesis] ⚠️ Se eliminó contenido JSON/código de la respuesta visible para ${clientSlug}`);
    }

    if (completed && !finalReply.includes("[ACTION:")) {
        finalReply += "\n\n[ACTION: CREATE_IDENTITY]";
    }

    return { reply: finalReply, completed, soul: completed ? soulJson : null };
}
