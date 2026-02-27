import supabase from '../config/supabase.mjs';
import redisClient from '../config/redis.mjs';
import crypto from 'crypto';
import fs from 'fs/promises';
import { getNextAvailablePort } from '../utils/supabaseHelpers.mjs';
import { transcribeAudio, analyzeImage } from '../utils/media.mjs';
import { openrouterChat } from '../services/openrouter.mjs';
import groq from '../services/groq.mjs';
import { encrypt } from '../security.mjs';

// --- Soul Completeness Validator ---
function soulIsComplete(soul) {
    const missing = [];
    if (!soul.edad || soul.edad === '[Edad]' || soul.edad.includes('Edad')) missing.push('edad');
    if (!soul.perfil?.ocupacion?.tipo || soul.perfil.ocupacion.tipo === '[profesión]') missing.push('ocupacion');
    if (!soul.perfil?.ocupacion?.especialidad || soul.perfil.ocupacion.especialidad === '[tecnologías/áreas]') missing.push('especialidad');
    // hobbies can be in hobbies_usuario (string) OR sustancia.intereses (array)
    const hasHobbies = (soul.perfil?.hobbies_usuario && soul.perfil.hobbies_usuario !== '[detalle]') || (soul.perfil?.sustancia?.intereses?.length && soul.perfil.sustancia.intereses[0] !== 'int 1');
    if (!hasHobbies) missing.push('hobbies_y_pasiones');
    if (!soul.perfil?.disponibilidad?.horario_pico || soul.perfil.disponibilidad.horario_pico === '[mañana/tarde/noche]') missing.push('horario_de_trabajo_o_rutina');
    if (!soul.perfil?.sustancia?.filosofia_vida || soul.perfil.sustancia.filosofia_vida === '[regla de vida]') missing.push('filosofia_de_vida');
    if (!soul.perfil?.estilo_escritura?.estilo_que_odia || soul.perfil.estilo_escritura.estilo_que_odia === '[le irrita]') missing.push('estilo_de_comunicacion_que_odia');
    if (missing.length > 0) {
        console.warn(`[Génesis] ⚠️ Soul incompleto. Faltan: ${missing.join(', ')}. Continuando entrevista...`);
        return { complete: false, missing };
    }
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
1. RITMO FLUIDO Y CONVERSACIONAL: Puedes agrupar inteligentemente hasta 2 temas relacionados por mensaje si la charla fluye (ej. Trabajo + Horarios productivos, o Hobbies + Filosofía de vida). Haz que suene casual, ¡no como un formulario!
2. CONTEXTO TOTAL: Lee todo el historial. No preguntes lo que el usuario ya mencionó. Entrelaza de forma orgánica lo último que dijo.
3. PROFUNDIDAD CONTROLADA: Cuando hablen de **Hobbies** o **Filosofía**, pregunta *por qué* les gusta. PERO avanza rápido, máximo profundiza 1 o 2 veces por tema.
4. SÉ CONCISO Y POCO VERBOSO: Respuestas breves, directas, impactantes (máximo 2-3 líneas).
5. PRIMER MENSAJE: Saluda con tu Estilo/Tono e introduce solo la primera indagación.
6. PERSONAJE CONSTANTE: Respira y escupe personalidad en TODO momento.
7. ATENCIÓN INVISIBLE: Ve evaluando mentalmente la información, NO se la repitas al usuario ni generes JSON mientras hablas.
8. PROHIBIDO INVENTAR DATOS: PREGUNTA ANTES DE ASUMIR su horario pico, el estilo que odia o su filosofía.

PUNTOS A DESCUBRIR ORGÁNICAMENTE:
A. Edad y Situación actual
B. Trabajo/Estudios y su "Por qué"
C. Hobbies y Pasiones (¿Por qué?)
D. Filosofía de vida / Valores
E. Temas a evitar / Zonas rojas
F. Horario pico de productividad
G. Estilo de comunicación que más odian recibir

⚠️ REGLA DE ORO DE CIERRE ⚠️: ¡¡¡BAJO NINGÚN CONCEPTO!!! intentes cerrar la charla si te falta recoger o confirmar AL MENOS UNO de los 7 puntos (A-G). Quédate conversando hasta tenerlos todos. SIEMPRE PREGUNTA EL HORARIO Y EL ESTILO QUE ODIA.

CIERRE (¡CRÍTICO! Cuando tengas TODOS los 7 puntos recabados al 100%):
Tu último mensaje será tu gran despedida. Agradece su tiempo e incluye EXACTAMENTE esto al final de tu mensaje:
<button>Crear mi identidad</button>
[READY_TO_EXTRACT]

ESTÁ ESTRICTAMENTE PROHIBIDO GENERAR CÓDIGO JSON O RESÚMENES LARGOS. Solo despídete e incluye el botón y el token.
`;

    // 0. Handle Multimedia Silently (attachments)
    if (params.attachments && Array.isArray(params.attachments)) {
        console.log(`[Génesis] 📎 Recibidos ${params.attachments.length} archivos adjuntos`);
        for (const attachment of params.attachments) {
            try {
                let additionalContext = "";
                if (attachment.type === 'audio' && attachment.data) {
                    const tempId = crypto.randomUUID();
                    const tempFile = `uploads/temp_audio_${tempId}`;
                    await fs.writeFile(tempFile, Buffer.from(attachment.data, 'base64'));
                    let text = await transcribeAudio(tempFile);

                    // Hallucination check for Whisper (often hallucinates on silence)
                    const cleanText = text.replace(/[.,!?;¿¡]/g, '').trim().toLowerCase();
                    const hallucinations = [
                        'gracias', 'thank you', 'gracias por ver', 'amén', 'amen',
                        'subtítulos por la comunidad de amaraorg', 'subtítulos realizados por la comunidad de amaraorg',
                        'suscríbete', 'suscribete al canal'
                    ];

                    if (cleanText.length < 2 || hallucinations.includes(cleanText)) {
                        console.warn(`[Génesis] ⚠️ Ignorando posible alucinación de audio/silencio: "${text}"`);
                    } else {
                        additionalContext = `[Audio Transcrito Silenciosamente: "${text}"]`;
                    }
                } else if (attachment.type === 'image' && attachment.data) {
                    console.log(`[Génesis] 🖼️ Procesando imagen adjunta...`);
                    const tempId = crypto.randomUUID();
                    const tempFile = `uploads/temp_img_${tempId}`;
                    await fs.writeFile(tempFile, Buffer.from(attachment.data, 'base64'));
                    const description = await analyzeImage(tempFile);
                    await fs.unlink(tempFile);
                    additionalContext = `[Imagen Analizada Silenciosamente: "${description}"]`;
                } else if (attachment.text) {
                    additionalContext = `[Contexto Adicional: "${attachment.text}"]`;
                }

                if (additionalContext) {
                    history.push({ role: 'system', content: additionalContext });
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

        const EXTRACTION_PROMPT = `Eres un extractor de datos JSON analítico. Analiza el siguiente historial de conversación de Onboarding y extrae la identidad del usuario en el formato JSON estricto indicado. No inventes datos; si algo no se ha mencionado orgánicamente, usa valores por defecto o infiérelos sutilmente.

Formato requerido estricto:
{
    "nombre": "\${userName || 'Usuario'}",
    "edad": "string",
    "tono": "\${preferredTone || 'Cercano y empático'}",
    "perfil": {
        "ocupacion": { "situacion": "estudia/trabaja/etc", "tipo": "profesión", "detalle": "resumen", "especialidad": "área", "contexto": "remoto/oficina/etc" },
        "hobbies_usuario": "string",
        "proposito": "string",
        "sustancia": { "intereses": ["string"], "filosofia_vida": "string", "dolores_actuales": "string", "fuentes_alegria": "string", "temas_prohibidos": ["string"] },
        "estilo_escritura": { "longitud_media": "breve/extensa", "formalidad": 5, "uso_emojis": "sí/no", "quirks": ["expresiones"], "vocabulario": "técnico/coloquial", "estilo_que_odia": "string" },
        "herramientas": ["string"],
        "disponibilidad": { "horario_pico": "mañana/tarde/noche", "modo_trabajo": "solo/equipo" },
        "directrices": ["string"]
    },
    "resumen_narrativo": "Resumen denso de 3 párrafos en segunda persona para la IA receptora del Soul."
}`;

        try {
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

            // --- AUTO-VERIFICATION: Ensure soul has all 9 fields before creating ---
            const { complete, missing } = soulIsComplete(soulJson);
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
                if (healErr) console.warn('[Bridge] Warning inserting users during baptism:', healErr.message);

                // 2. Guardar el negocio en la BD
                const { error: clientErr } = await supabase
                    .from('clients')
                    .upsert({
                        user_id: clientId,
                        name: userName || soulJson.nombre || 'Nuevo Cliente',
                        whatsapp_number: params.phoneNumber || ''
                    }, { onConflict: 'user_id' });
                if (clientErr) throw new Error(`[Bridge] clients upsert failed: ${clientErr.message}`);

                // 3. Guardar el cerebro (Soul) en la BD
                const { error: soulErr } = await supabase
                    .from('user_souls')
                    .upsert({
                        client_id: clientId,
                        soul_json: soulJson,
                        port: nextPort,
                        slug: clientSlug,
                        last_updated: new Date()
                    });
                if (soulErr) throw new Error(`[Bridge] user_souls upsert failed: ${soulErr.message}`);

                // === CREAR ARCHIVOS FÍSICOS ===
                console.log(`🛠️[Provisioning] Iniciando para ${clientSlug}...`);
                const soulMd = `# Identidad\nEres ${soulJson.nombre}.${soulJson.tono} \n\n# Situación: ${soulJson.perfil?.ocupacion?.situacion || 'N/A'}\n\n# Directrices\n${(soulJson.perfil?.directrices || []).map(d => `- ${d}`).join('\n')} `;
                await fs.writeFile(`${clientDir}/SOUL.md`, encrypt(soulMd));

                const userMd = `# Perfil\n - Usuario: ${userName || 'Usuario'}\n - Edad: ${soulJson.edad || 'N/A'}\n - Trabajo: ${soulJson.perfil?.ocupacion?.detalle || occupation || 'N/A'}\n - Meta: ${mainChallenge || 'N/A'}\n - Herramientas: ${(soulJson.perfil?.herramientas || []).join(', ')}\n - Horario pico: ${soulJson.perfil?.disponibilidad?.horario_pico || 'N/A'}\n - Modo trabajo: ${soulJson.perfil?.disponibilidad?.modo_trabajo || 'N/A'}`;
                await fs.writeFile(`${clientDir}/USER.md`, encrypt(userMd));

                const contextMd = `# Contexto Actual\n - Fecha de creación: ${new Date().toLocaleDateString()}\n - Plataforma: OpenClaw SaaS App\n - Estado inicial: Configurado vía Génesis Onboarding.`;
                await fs.writeFile(`${clientDir}/CONTEXT.md`, encrypt(contextMd));

                // 4. Provisioning config file for the portal (gateway.json5)
                const gatewayConfig = {
                    client_id: clientId,
                    slug: clientSlug,
                    models: { providers: { openrouter: { apiKey: process.env.OPENROUTER_API_KEY } } },
                    agents: { defaults: { model: { primary: "openrouter/deepseek/deepseek-chat" } } }
                };
                await fs.writeFile(`${clientDir}/gateway.json5`, encrypt(JSON.stringify(gatewayConfig, null, 2)));

                completed = true;
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
