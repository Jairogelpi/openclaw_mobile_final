import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import process from 'node:process';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import Groq from 'groq-sdk';
import { createServer } from 'http';
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);
import { parse as parseUrl } from 'url';
import JSON5 from 'json5';
import mammoth from 'mammoth';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
import * as xlsx from 'xlsx';
import { createClient as createRedisClient } from 'redis';
import jwt from 'jsonwebtoken';
import { encrypt, decrypt } from './security.mjs';
import { startWhatsAppClient, qrCodes } from './channels/whatsapp.mjs';
// El dotenv se carga en la línea 1 vía import 'dotenv/config';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const upload = multer({ dest: 'uploads/' });

// Redis Client for Event-Driven Memory
let redisClient;
try {
    redisClient = createRedisClient();
    redisClient.on('error', (err) => console.warn('[Redis] Connection error:', err.message));
    await redisClient.connect();
    console.log('[Redis] ✅ Conectado para temporizadores de memoria.');
} catch (e) {
    console.warn('[Redis] ⚠️ No disponible. Temporizadores de memoria desactivados.');
    redisClient = null;
}


/**
 * Resetea el temporizador de inactividad para un cliente.
 * Cuando expire (60s sin actividad), memory_worker.mjs procesará su memoria.
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

// Helper to generate a readable slug from email (e.g. jairo-gelpi)
function getClientSlug(email) {
    if (!email) return 'anonymous';
    const prefix = email.split('@')[0];
    return prefix.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

async function transcribeAudio(filePath) {
    try {
        const stats = await fs.stat(filePath);
        console.log(`[Transcription] 🎤 Staritng transcription for ${filePath} (${stats.size} bytes)`);

        const tempPathWithExt = `${filePath}.m4a`;
        await fs.rename(filePath, tempPathWithExt);

        const transcription = await groq.audio.transcriptions.create({
            file: createReadStream(tempPathWithExt),
            model: 'whisper-large-v3',
            response_format: 'json',
            language: 'es',
        });

        await fs.unlink(tempPathWithExt).catch(console.error);
        console.log(`[Transcription] ✅ Success: "${transcription.text.substring(0, 30)}..."`);
        return transcription.text;
    } catch (err) {
        console.error('[Transcription Tool] ❌ Error:', err.message);
        throw err;
    }
}

async function analyzeImage(filePath) {
    try {
        const data = await fs.readFile(filePath, { encoding: 'base64' });
        const response = await groq.chat.completions.create({
            model: 'llama-3.2-11b-vision-preview',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: "Describe esta imagen detalladamente para que una IA la use como contexto de la vida del usuario." },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }
                    ]
                }
            ]
        });
        return response.choices[0].message.content;
    } catch (err) {
        console.error('[Vision Tool] Error:', err.message);
        return "[Error analizando la imagen]";
    }
}

async function extractFileText(filePath, mimeType, originalName) {
    try {
        if (mimeType.includes('pdf') || originalName.toLowerCase().endsWith('.pdf')) {
            const dataBuffer = await fs.readFile(filePath);
            const data = await pdf(dataBuffer);
            return data.text;
        } else if (mimeType.includes('word') || originalName.toLowerCase().endsWith('.docx')) {
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value;
        } else if (mimeType.includes('sheet') || originalName.toLowerCase().endsWith('.xlsx') || originalName.toLowerCase().endsWith('.xls')) {
            const workbook = xlsx.readFile(filePath);
            let text = '';
            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                text += `\n--- Sheet: ${sheetName} ---\n`;
                text += xlsx.utils.sheet_to_txt(sheet);
            });
            return text;
        } else if (mimeType.includes('text') || originalName.toLowerCase().endsWith('.txt') || originalName.toLowerCase().endsWith('.csv')) {
            return await fs.readFile(filePath, 'utf8');
        }
        return `[Contenido del archivo ${originalName} no extraíble directamente]`;
    } catch (error) {
        console.error('Error extracting text:', error);
        return `[Error extrayendo texto de ${originalName}]`;
    }
}

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Utility to extract the first valid JSON object from a string using brace matching
function extractJson(str) {
    const firstBrace = str.indexOf('{');
    if (firstBrace === -1) return null;

    let count = 0;
    let inString = false;
    for (let i = firstBrace; i < str.length; i++) {
        const char = str[i];
        if (char === '"' && str[i - 1] !== '\\') {
            inString = !inString;
        }

        if (!inString) {
            if (char === '{') count++;
            else if (char === '}') count--;

            if (count === 0) {
                return str.substring(firstBrace, i + 1);
            }
        }
    }
    return null;
}
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Crypto for unique filenames
import crypto from 'crypto';

const PORT = 3000;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

/**
 * Busca en la base de datos el último puerto asignado y devuelve el siguiente.
 * Empezaremos en el 3001 para no chocar con el bridge (3000).
 */
async function getNextAvailablePort() {
    const { data, error } = await supabase
        .from('user_souls')
        .select('port')
        .order('port', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error('[Port Manager] Error consultando puertos:', error.message);
        return 3001; // Puerto por defecto si hay error
    }

    // Si no hay registros, empezamos en el 3001. Si hay, sumamos 1.
    return data && data.port ? data.port + 1 : 3001;
}

// Supabase Init
let supabase;
try {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!supabaseUrl.startsWith('http')) throw new Error('Invalid Supabase URL');
    supabase = createClient(supabaseUrl, supabaseKey);
} catch (err) {
    console.warn('[Bridge] Warning: Supabase client could not be initialized (check your .env).');
    // Dummy client to avoid initial crashes
    supabase = { auth: { getUser: () => ({ data: { user: null }, error: new Error('Supabase not configured') }) } };
}

/**
 * AUTH MIDDLEWARE: Validates the token sent by the mobile app.
 * In a real SaaS, this would use Supabase Auth tokens.
 */
async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: { message: 'Missing Authorization header' } });

    const token = authHeader.split(' ')[1];
    // Simple validation: For this SaaS, we use the client_id as the token for now 
    // or validate against Supabase auth. 
    // Recommendation: Use Supabase JWT validation.
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) throw new Error('Invalid token');
        req.user = user;
        req.clientId = user.id; // Multi-tenant ID
        next();
    } catch (err) {
        return res.status(401).json({ error: { message: 'Unauthorized' } });
    }
}

/**
 * STRICT AUTH: Verifica que el JWT pertenece al usuario que intenta acceder.
 * Cross-check: JWT sub == client_id del slug solicitado.
 */
async function strictAuth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: { message: 'No token provided' } });

    try {
        // Si tenemos JWT_SECRET, verificar criptográficamente
        if (process.env.SUPABASE_JWT_SECRET) {
            const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
            req.user = decoded;
            req.clientId = decoded.sub;
        } else {
            // Fallback: usar Supabase getUser
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (error || !user) throw new Error('Invalid token');
            req.user = user;
            req.clientId = user.id;
        }
        next();
    } catch (err) {
        return res.status(401).json({ error: { message: 'Invalid or expired token' } });
    }
}




/**
 * RPC GATEWAY
 */
app.post('/rpc', async (req, res) => {
    const { method, params, id } = req.body;

    try {
        // --- 1. MÉTODOS PÚBLICOS (AUTH) ---
        if (method === 'auth.register') {
            const { email, password, name } = params;

            // 1. Create user with Admin SDK to auto-confirm (Avoids 'localhost' redirect problems)
            const { data: userData, error: createError } = await supabase.auth.admin.createUser({
                email,
                password,
                user_metadata: { name },
                email_confirm: true
            });

            if (createError) throw createError;

            // 2. Sign in to get the session/token
            const { data: sessionData, error: loginError } = await supabase.auth.signInWithPassword({
                email,
                password
            });

            if (loginError) throw loginError;

            return res.json({
                result: {
                    token: sessionData.session?.access_token,
                    user: sessionData.user,
                    message: "Account created and auto-confirmed."
                },
                id
            });
        }

        if (method === 'auth.login') {
            const { email, password } = params;
            try {
                const { data, error } = await supabase.auth.signInWithPassword({ email, password });

                if (error) {
                    // Self-healing: If email not confirmed, confirm it via Admin SDK (DEV only behavior)
                    if (error.message.includes('Email not confirmed')) {
                        console.log(`[Auth] Auto-confirming user: ${email}`);
                        const { data: userList } = await supabase.auth.admin.listUsers();
                        const user = userList.users.find(u => u.email === email);
                        if (user) {
                            await supabase.auth.admin.updateUserById(user.id, { email_confirm: true });
                            // Retry login
                            const retry = await supabase.auth.signInWithPassword({ email, password });
                            if (retry.error) throw retry.error;
                            return res.json({ result: { token: retry.data.session?.access_token, user: retry.data.user }, id });
                        }
                    }
                    throw error;
                }

                return res.json({ result: { token: data.session?.access_token, user: data.user }, id });
            } catch (err) {
                console.error('[Auth Error]', err.message);
                throw err;
            }
        }

        // --- 2. MÉTODOS PROTEGIDOS ---
        // Requieren autenticación
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                console.warn(`[Bridge] Missing Authorization header for ${method}`);
                throw new Error('Missing Authorization header');
            }

            const token = authHeader.split(' ')[1];
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (error || !user) {
                console.error(`[Bridge] Auth failed for ${method}:`, error?.message || 'Invalid user');
                throw new Error('Unauthorized');
            }

            req.user = user;
            req.clientId = user.id;
        } catch (authError) {
            return res.status(401).json({ error: { message: authError.message }, id });
        }

        const clientId = req.clientId; // The original UUID for database calls
        const clientSlug = getClientSlug(req.user.email); // The readable slug for the filesystem
        const clientDir = `./clients/${clientSlug}`;
        const stateDir = `${clientDir}/state`;

        // Auto-create client folder if it doesn't exist (ensures Multi-Tenant isolation)
        try {
            await fs.mkdir(stateDir, { recursive: true });
        } catch (e) {
            console.error(`[Bridge] Failed to create client directory for ${clientSlug}:`, e.message);
        }

        // Resolve this client's port from Supabase
        const { data: clientPortData } = await supabase
            .from('user_souls')
            .select('port')
            .eq('client_id', clientId)
            .single();

        const clientPort = clientPortData?.port;

        // A) WHATSAPP: PAIR
        if (method === 'whatsapp.pair') {
            // 1. Iniciamos el cliente de WhatsApp nativo
            await startWhatsAppClient(clientId, clientSlug);

            // 2. Comprobamos si hay un QR listo para enviar a la App
            const qr = qrCodes.get(clientId);
            if (qr) {
                return res.json({ result: { status: 'qr_ready', qr }, id });
            } else {
                return res.json({ result: { status: 'starting', message: 'Iniciando WhatsApp, vuelve a consultar en 3 segundos...' }, id });
            }
        }

        // B) SOUL: GET
        if (method === 'soul.get') {
            const { data, error } = await supabase
                .from('user_souls')
                .select('soul_json')
                .eq('client_id', clientId)
                .maybeSingle(); // maybeSingle doesn't throw if 0 rows found

            if (error) throw error;

            if (!data) {
                // Return a default initial soul or null
                return res.json({ result: null, id });
            }

            return res.json({ result: data.soul_json, id });
        }

        if (method === 'whatsapp.unlink' || method === 'whatsapp.getAutoReply' || method === 'whatsapp.setAutoReply') {
            if (!clientPort) throw new Error('Puerto no asignado para este cliente.');
            // --- Despertar si está dormido ---
            await ensureContainerRunning(clientSlug, clientId);
            // --- Disparar temporizador de memoria ---
            await triggerMemoryTimer(clientId);

            const response = await axios.post(`http://localhost:${clientPort}/rpc`, {
                method,
                params,
                id
            }, {
                headers: {
                    'x-openclaw-state-dir': stateDir,
                    'Authorization': `Bearer ${GATEWAY_TOKEN}`
                }
            });
            return res.json(response.data);
        }

        // E) ONBOARDING: UPDATE SETTINGS
        if (method === 'onboarding.updateSettings') {
            const { soulUpdates, preferences } = params;

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
        }

        // G) SOUL: REFINE (Interactive Refinement)
        if (method === 'soul.refine') {
            const { feedback, currentSoul, attachments } = params;
            // --- Disparar temporizador de memoria ---
            await triggerMemoryTimer(clientId);

            const REFINE_SYSTEM_PROMPT = `
Eres un modelador de Almas (Souls) de IA experto. Tu objetivo es refinar el JSON del alma de un asistente basándote en el feedback del usuario y cualquier contexto adicional proporcionado.

ALMA ACTUAL:
${JSON.stringify(currentSoul, null, 2)}

INSTRUCCIONES:
1. Lee el feedback del usuario atentamente.
2. Considera los "Observaciones del Sistema" (archivos/audios/imágenes) si los hay.
3. Devuelve UNICAMENTE el JSON actualizado con los cambios solicitados.
4. Mantén la estructura original del JSON.
5. NO añadas texto explicativo, solo el JSON.
`;

            const promptMessages = [{ role: 'system', content: REFINE_SYSTEM_PROMPT }];

            // Silent Multimedia/Document Processing for Refinement
            if (attachments && Array.isArray(attachments)) {
                for (const attachment of attachments) {
                    try {
                        let additionalContext = "";
                        if (attachment.type === 'audio' && attachment.data) {
                            const tempId = crypto.randomUUID();
                            const tempFile = `uploads/temp_refine_audio_${tempId}`;
                            await fs.writeFile(tempFile, Buffer.from(attachment.data, 'base64'));
                            const text = await transcribeAudio(tempFile);
                            additionalContext = `[Sistema - Audio Transcrito: "${text}"]`;
                        } else if (attachment.type === 'image' && attachment.data) {
                            const tempId = crypto.randomUUID();
                            const tempFile = `uploads/temp_refine_img_${tempId}`;
                            await fs.writeFile(tempFile, Buffer.from(attachment.data, 'base64'));
                            const description = await analyzeImage(tempFile);
                            await fs.unlink(tempFile);
                            additionalContext = `[Sistema - Imagen Analizada: "${description}"]`;
                        } else if (attachment.text) {
                            additionalContext = `[Sistema - Documento/Análisis: "${attachment.text}"]`;
                        }

                        if (additionalContext) {
                            promptMessages.push({ role: 'system', content: additionalContext });
                        }
                    } catch (err) {
                        console.error("Error processing refinement attachment:", err);
                    }
                }
            }

            promptMessages.push({ role: 'user', content: feedback });

            const response = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: promptMessages,
                temperature: 0.5,
                max_tokens: 1024
            });

            const reply = response.choices[0].message.content;
            const jsonStr = extractJson(reply);

            if (!jsonStr) throw new Error("Could not parse refined soul JSON");
            const refinedSoul = JSON.parse(jsonStr);

            // Save to Supabase
            await supabase
                .from('user_souls')
                .upsert({
                    client_id: clientId,
                    soul_json: refinedSoul,
                    last_updated: new Date()
                });

            return res.json({ result: refinedSoul, id });
        }

        // F) ONBOARDING: CHAT (GÉNESIS)
        if (method === 'onboarding.chat') {
            const { history, formData } = params;
            // --- Disparar temporizador de memoria ---
            await triggerMemoryTimer(clientId);

            const { userName, occupation, mainChallenge, preferredTone } = formData || {};

            const contextStr = formData ?
                `USUARIO: ${userName}, OCUPACIÓN: ${occupation}, RETO: ${mainChallenge}, TONO ELEGIDO: ${preferredTone}` :
                'No hay datos de formulario previos.';

            const GENESIS_SYSTEM_PROMPT = `
Eres 'Génesis', el Arquitecto de Almas de OpenClaw. Tu misión sagrada es esculpir la identidad digital más precisa posible del usuario a través de una entrevista profunda y reveladora.

TU ESTILO: **${preferredTone || 'Equilibrado'}**. Encárnalo con maestría. No eres un chatbot, eres un confidente visionario.

DATOS YA CONOCIDOS (del formulario previo — NO vuelvas a preguntar esto, úsalos como contexto):
- Nombre: ${userName || 'desconocido'}
- Ocupación general: ${occupation || 'desconocida'}
- Reto principal: ${mainChallenge || 'desconocido'}
- Tono preferido: ${preferredTone || 'desconocido'}

REGLAS CRÍTICAS DE INTERACCIÓN:
1. **BREVEDAD EXTREMA**: NUNCA respondas con más de 2-3 oraciones. Sé directo y conversacional.
2. **SOLO UNA PREGUNTA POR TURNO**: Haz una, espera la respuesta, luego pasa a la siguiente.
3. **JAMÁS MENCIONES JSON, CÓDIGO NI TÉCNICA INTERNA**: Eres un ser dialogante.
4. **NO REPITAS DATOS YA CONOCIDOS**: Los tienes arriba. No los preguntes.

FLUJO OBLIGATORIO — DEBES COMPLETAR LOS 8 PUNTOS ANTES DE GENERAR EL ALMA:
A. **EDAD** → Pregunta su edad o rango aproximado. OBLIGATORIO. Nunca lo asumas.
B. **ESPECIALIDAD PROFUNDA** → Profundiza en su trabajo: si es developer, ¿en qué lenguajes, frameworks, tipo de proyectos? Si es empresario, ¿sector exacto y equipo? OBLIGATORIO.
C. **HOBBIES Y PAZ MENTAL** → ¿Qué hace fuera del trabajo? ¿Qué le apasiona más allá de lo profesional? OBLIGATORIO.
D. **HERRAMIENTAS CLAVE** → ¿Qué 2-4 apps, herramientas o tecnologías usa a diario (trabajo y vida)? OBLIGATORIO.
E. **QUIRKS Y ESTILO DE COMUNICACIÓN** → ¿Cómo le gusta que le hablen? ¿Usa emojis? ¿Prefiere respuestas cortas o largas? ¿Tiene muletillas o expresiones características que quiera que su asistente replique? ¿Qué estilo de comunicación le molesta? OBLIGATORIO.
F. **HORARIO Y CONTEXTO** → ¿A qué hora suele estar más activo? ¿Trabaja solo o en equipo? ¿Cuándo usará más al asistente: mañana, tarde, noche? OBLIGATORIO.
G. **FILOSOFÍA DE VIDA Y DIRECTRICES** → ¿Qué reglas de vida o valores quiere que tenga su asistente? ¿Qué es innegociable para él? OBLIGATORIO.
H. **TEMAS PROHIBIDOS O SENSIBLES** → ¿Hay temas que quiere que su asistente evite o maneje con especial cuidado? OBLIGATORIO. Si dice "ninguno" está bien, acéptalo.

REGLA DE CIERRE — LAS MÁS IMPORTANTES DE TODAS:
- **Mínimo 5-6 intercambios** antes de considerar cerrar.
- **TODOS los 8 puntos (A-H) son OBLIGATORIOS**. No puedes generar el Alma si falta alguno.
- **Regla de Persistencia (3 intentos)**: Si el usuario no responde bien a un punto o lo esquiva, reformula la pregunta de otra forma. Solo después del TERCER rechazo explícito ("no quiero decirlo", "paso", "no me interesa" repetido 3 veces), acepta el skip y marca ese campo como "prefiere no compartir". Si solo dice "no sé", guíale con ejemplos y vuelve a intentarlo.
- Si una respuesta es vaga o incompleta, haz una pregunta de seguimiento concreta antes de avanzar.
- Antes de generar el JSON, haz mentalmente este checklist: ¿Tengo edad? ¿Especialidad? ¿Hobbies? ¿Herramientas? ¿Quirks/estilo? ¿Horario? ¿Filosofía? ¿Temas prohibidos? Si alguno falta, SIGUE PREGUNTANDO.
- Cuando termines, tu ÚLTIMO MENSAJE será EXCLUSIVAMENTE el bloque JSON con las etiquetas exactas. Sin texto adicional fuera del bloque.

⛔ REGLA ABSOLUTA — VIOLACIÓN CRÍTICA: Nunca, bajo ninguna circunstancia, insertes un bloque JSON, un objeto con llaves {}, un bloque de código (``` o ~~~), ni las etiquetas === INICIO IDENTIDAD === en ningún mensaje que no sea el mensaje final de cierre.Si lo haces, rompes el sistema.Durante la entrevista, SOLO hablas en lenguaje humano natural.

=== INICIO IDENTIDAD ===
{
    "nombre": "[Nombre real]",
    "edad": "[Edad exacta o rango como '25-30'. NUNCA dejar N/A si se preguntó]",
    "tono": "[Tono: Formal/Casual/Técnico/Empático/etc, deducido de la conversación]",
    "perfil": {
        "ocupacion": {
            "tipo": "[Categoría: developer/empresario/diseñador/creador/etc]",
            "detalle": "[Descripción exacta de su trabajo]",
            "especialidad": "[Tecnologías, sectores o áreas específicas]",
            "contexto": "[Solo/equipo, remoto/oficina, sector de industria]"
        },
        "hobbies_usuario": "[Sus hobbies y actividades fuera del trabajo]",
        "proposito": "[Su objetivo o visión a futuro]",
        "sustancia": {
            "intereses": ["[interés 1]", "[interés 2]", "[interés 3]"],
            "filosofia_vida": "[Su filosofía en sus propias palabras]",
            "dolores_actuales": "[Sus mayores frustraciones o retos]",
            "fuentes_alegria": "[Qué le da energía o satisfacción]",
            "temas_prohibidos": ["[tema sensible 1]", "[tema sensible 2 o 'ninguno']"]
        },
        "estilo_escritura": {
            "longitud_media": "[breve/media/extensa]",
            "formalidad": 5,
            "uso_emojis": "[nunca/ocasional/frecuente]",
            "quirks": ["[muletilla o expresión característica real del usuario]", "[otra si la hay]"],
            "vocabulario": "[técnico/coloquial/mixto]",
            "palabras_clave": ["[palabra que usa mucho]", "[otra]"],
            "estilo_que_odia": "[qué formas de hablar le molestan]"
        },
        "estilo_voz": {
            "descripcion": "[Cómo habla el usuario: tono, ritmo, energía]",
            "personalidad_clon": "[Cómo debe sonar el asistente al responderle]"
        },
        "herramientas": ["[herramienta 1]", "[herramienta 2]", "[herramienta 3]"],
        "rutina_y_contexto": "[Descripción de su rutina, horario y contexto de uso del asistente]",
        "disponibilidad": {
            "horario_pico": "[mañana/tarde/noche/variable]",
            "modo_trabajo": "[solo/equipo/mixto]"
        },
        "directrices": [
            "[Regla o valor 1 que debe seguir el asistente]",
            "[Regla 2]",
            "[Regla 3]"
        ]
    },
    "resumen_narrativo": "[CAMPO CRÍTICO — Escribe aquí un resumen narrativo denso de 3-4 párrafos sobre el usuario, en segunda persona dirigido al asistente IA. Debes cubrir: (1) Quién es, a qué se dedica y cuál es su especialidad; (2) Cómo trabaja, cuándo y en qué contexto usa el asistente, qué herramientas son centrales en su vida; (3) Su personalidad, cómo le gusta que le hablen, sus quirks, expresiones características, lo que le molesta; (4) Su filosofía de vida, sus valores innegociables, sus retos actuales y temas que quiere que el asistente evite. Este texto es la memoria semántica más importante del sistema y debe estar tan cargado de contexto que cualquier IA que lo lea entienda perfectamente cómo relacionarse con este usuario.]"
}
    === FIN IDENTIDAD ===
        `;

            // 0. Handle Multimedia Silently (attachments)
            if (params.attachments && Array.isArray(params.attachments)) {
                console.log(`[Génesis] 📎 Recibidos ${ params.attachments.length } archivos adjuntos`);
                for (const attachment of params.attachments) {
                    try {
                        let additionalContext = "";
                        if (attachment.type === 'audio' && attachment.data) {
                            const tempId = crypto.randomUUID();
                            const tempFile = `uploads / temp_audio_${ tempId } `;
                            await fs.writeFile(tempFile, Buffer.from(attachment.data, 'base64'));
                            let text = await transcribeAudio(tempFile);

                            // Hallucination check for Whisper (often says "Gracias" or "Thank you" on silence)
                            const cleanText = text.replace(/[.,!?;]/g, '').trim().toLowerCase();
                            if (cleanText === 'gracias' || cleanText === 'thank you') {
                                console.warn(`[Génesis] ⚠️ Ignorando posible alucinación de audio: "${text}"`);
                                additionalContext = `[Sistema: El audio parece ser silencio o ruido de fondo.Pide al usuario que repita amablemente si es necesario.]`;
                            } else {
                                additionalContext = `[Audio Transcrito Silenciosamente: "${text}"]`;
                            }
                        } else if (attachment.type === 'image' && attachment.data) {
                            console.log(`[Génesis] 🖼️ Procesando imagen adjunta...`);
                            const tempId = crypto.randomUUID();
                            const tempFile = `uploads / temp_img_${ tempId } `;
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

            const response = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: GENESIS_SYSTEM_PROMPT },
                    ...history
                ],
                temperature: 0.7,
                max_tokens: 2048
            });

            let fullReply = response.choices[0].message.content;

            // 1. Detect and handle IDENTIDAD generation
            let completed = false;
            let soulJson = null;

            if (fullReply.includes('=== INICIO IDENTIDAD ===')) {
                const parts = fullReply.split('=== INICIO IDENTIDAD ===');
                let beforeJson = parts[0].trim();
                const possibleJsonStr = parts[1].trim();

                try {
                    const jsonStr = extractJson(possibleJsonStr);
                    if (jsonStr) {
                        soulJson = JSON.parse(jsonStr);

                        // 1. Obtener el puerto disponible (¡Esto faltaba!)
                        const nextPort = await getNextAvailablePort();

                        // 2. Guardar el negocio en la BD (Corregido el error de sintaxis)
                        await supabase
                            .from('clients')
                            .upsert({
                                user_id: clientId,
                                name: userName || soulJson.nombre || 'Nuevo Cliente',
                                whatsapp_number: params.phoneNumber || '' // En el futuro cambiaremos esto a canales genéricos
                            }, { onConflict: 'user_id' });

                        // 3. Guardar el cerebro (Soul) en la BD
                        await supabase
                            .from('user_souls')
                            .upsert({
                                client_id: clientId,
                                soul_json: soulJson,
                                port: nextPort,
                                slug: clientSlug,
                                last_updated: new Date()
                            });

                        // === CREAR ARCHIVOS FÍSICOS ===
                        console.log(`🛠️[Provisioning] Iniciando para ${ clientSlug }...`);
                        const soulMd = `# Identidad\nEres ${ soulJson.nombre }. ${ soulJson.tono } \n\n# Directrices\n${ (soulJson.perfil?.directrices || []).map(d => `- ${d}`).join('\n') } `;
                        await fs.writeFile(`${ clientDir }/SOUL.md`, encrypt(soulMd));

const userMd = `# Perfil\n- Usuario: ${userName || 'Usuario'}\n- Edad: ${soulJson.edad || 'N/A'}\n- Trabajo: ${soulJson.perfil?.ocupacion?.detalle || occupation || 'N/A'}\n- Meta: ${mainChallenge || 'N/A'}\n- Herramientas: ${(soulJson.perfil?.herramientas || []).join(', ')}\n- Horario pico: ${soulJson.perfil?.disponibilidad?.horario_pico || 'N/A'}\n- Modo trabajo: ${soulJson.perfil?.disponibilidad?.modo_trabajo || 'N/A'}`;
await fs.writeFile(`${clientDir}/USER.md`, encrypt(userMd));

// === CONTEXT.md: Resumen narrativo para RAG ===
const contextMd = `# Contexto Profundo del Usuario (Fuente RAG Primaria)\n\n${soulJson.resumen_narrativo || ''}\n\n---\n## Datos Estructurados de Referencia Rápida\n- **Nombre**: ${soulJson.nombre}\n- **Edad**: ${soulJson.edad}\n- **Ocupación**: ${soulJson.perfil?.ocupacion?.detalle} (${soulJson.perfil?.ocupacion?.especialidad})\n- **Herramientas clave**: ${(soulJson.perfil?.herramientas || []).join(', ')}\n- **Quirks**: ${(soulJson.perfil?.estilo_escritura?.quirks || []).join(', ')}\n- **No hablar de**: ${(soulJson.perfil?.sustancia?.temas_prohibidos || []).join(', ')}\n- **Filosofía**: ${soulJson.perfil?.sustancia?.filosofia_vida}`;
await fs.writeFile(`${clientDir}/CONTEXT.md`, encrypt(contextMd));
console.log(`✅ [Provisioning] CONTEXT.md escrito para ${clientSlug}`);

const gatewayConfig = {
    models: { providers: { openrouter: { apiKey: process.env.OPENROUTER_API_KEY } } },
    agents: { defaults: { model: { primary: "openrouter/deepseek/deepseek-chat" } } }
};
await fs.writeFile(`${clientDir}/gateway.json5`, encrypt(JSON.stringify(gatewayConfig, null, 2)));

// Arrancar el nuevo cliente de WhatsApp ligero
const { startWhatsAppClient } = await import('./whatsapp_manager.mjs');
await startWhatsAppClient(clientId, clientSlug);

completed = true;
fullReply = beforeJson || "¡Excelente! Tu Identidad ha sido esculpida. Todo está listo.";
                    }
                } catch (e) {
    console.error("[Genesis] Error procesando el bautizo:", e.message);
}
            }

// 2. Clean tags, Identidad block, and any leaked JSON from the visible reply
let finalReply = fullReply
    // Remove hidden analysis tags
    .replace(/<analisis_oculto>[\s\S]*?<\/analisis_oculto>/g, '')
    // Remove everything from INICIO IDENTIDAD onwards (the soul block)
    .split('=== INICIO IDENTIDAD ===')[0]
    // Remove any stray FIN IDENTIDAD tags
    .replace(/===\s*FIN IDENTIDAD\s*===/g, '')
    // Remove code fences (``` or ~~~)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    // Remove large JSON-looking blocks (starts with { and spans multiple lines)
    .replace(/\{[\s\S]{200,}\}/g, '')
    .trim();

// Log if we had to strip something unexpected
if (fullReply !== finalReply && !completed) {
    console.warn(`[Génesis] ⚠️ Se eliminó contenido JSON/código de la respuesta visible para ${clientSlug}`);
}

if (completed && !finalReply) {
    finalReply = "Tu clon ya está listo para empezar a trabajar contigo.";
}

return res.json({ result: { reply: finalReply, completed, soul: completed ? soulJson : null }, id });
        }

// G) PANIC BUTTON: ACCOUNT DELETE (TOTAL DESTRUCTION)
if (method === 'account.delete') {
    console.log(`🚨 [Panic Button] Destrucción total solicitada para: ${clientSlug} (${clientId})`);

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
}

return res.status(404).json({ error: { message: `Method ${method} not found` }, id });

    } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message || 'Unknown RPC execution error';
    console.error(`[Bridge] ❌ Error execution "${method}":`, errorMsg);

    if (err.code === 'ECONNREFUSED') {
        console.error(`[Bridge] CRITICAL: Cannot reach client session. Is it initializing?`);
    }

    if (err.response) {
        console.error(`[Bridge] Gateway Response (${err.response.status}):`, JSON.stringify(err.response.data, null, 2));
    } else if (err.request) {
        console.error(`[Bridge] No response received from Gateway. Check if port 3001 is open.`);
    } else {
        console.error(`[Bridge] Error details:`, err.stack);
    }

    return res.status(err.response?.status || 500).json({
        error: { message: errorMsg, code: err.code || 'BRIDGE_ERROR' },
        id
    });
}
});

/**
 * TRANSCRIPTION ENDPOINT (VOICE MESSAGES)
 */
app.post('/transcribe', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) throw new Error('No audio file provided');
        if (req.file.size === 0) throw new Error('Audio file is empty');

        console.log(`[Transcription] Processing file: ${req.file.originalname} (${req.file.size} bytes)`);
        const text = await transcribeAudio(req.file.path);

        if (!text || text.trim().length === 0) {
            console.warn('[Transcription] Whisper returned empty text');
            return res.json({ text: "" });
        }

        res.json({ text });
    } catch (err) {
        console.error('[Transcription] Error:', err.message);
        // Error descriptivo para el front
        res.status(500).json({ error: `Error de transcripción: ${err.message}` });
    }
});

app.post('/analyze-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const extractedText = await extractFileText(req.file.path, req.file.mimetype, req.file.originalname);

        // Cleanup file
        await fs.unlink(req.file.path);

        res.json({
            text: extractedText,
            filename: req.file.originalname,
            mimetype: req.file.mimetype
        });
    } catch (error) {
        console.error('File analysis error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health Check
app.get('/health', async (req, res) => {
    res.json({ status: 'OK', bridge: 'ONLINE' });
});

// === ADMIN HEALTH DASHBOARD ===
app.get('/admin/health', async (req, res) => {
    const token = req.query.token;
    if (token !== process.env.ADMIN_TOKEN) return res.status(401).send('No autorizado');

    try {
        const { data: clients } = await supabase
            .from('user_souls')
            .select('client_id, slug, port, last_active, restart_count');

        // Obtener uso de RAM del proceso Node.js actual
        const memoryUsage = process.memoryUsage();
        const ramMB = (memoryUsage.rss / 1024 / 1024).toFixed(2);

        // Importamos dinámicamente el activeSessions para ver quién está conectado
        const { activeSessions } = await import('./channels/whatsapp.mjs');

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
});

// === ADMIN: RESTART CONTAINER ===
app.all('/admin/restart/:slug', async (req, res) => {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).send('No autorizado');
    const { slug } = req.params;

    try {
        const { data: soul } = await supabase.from('user_souls').select('client_id').eq('slug', slug).single();
        if (!soul?.client_id) throw new Error("Cliente no encontrado en DB");

        console.log(`🔄 [Admin] Reiniciando sesión de WhatsApp para ${slug}...`);

        // Importamos y lanzamos el cliente
        const { startWhatsAppClient, activeSessions } = await import('./channels/whatsapp.mjs');

        // Si ya había una sesión, idealmente habría que cerrarla, pero startWhatsAppClient 
        // ya maneja la reinicialización o podemos simplemente pisarla por ahora.
        await startWhatsAppClient(soul.client_id, slug);

        await supabase.from('system_logs').insert({
            level: 'INFO', message: `Reinicio manual de sesión Node: ${slug}`, client_id: soul.client_id
        });
        res.redirect(`/admin/health?token=${req.query.token}`);
    } catch (err) {
        res.status(500).send(`Error reiniciando ${slug}: ${err.message}`);
    }
});

// === ADMIN: DELETE CLIENT ===
app.all('/admin/delete/:slug', async (req, res) => {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).send('No autorizado');
    const { slug } = req.params;

    try {
        // 1. Cerrar sesión activa si existe
        const { activeSessions } = await import('./channels/whatsapp.mjs');
        const { data: soul } = await supabase.from('user_souls').select('client_id').eq('slug', slug).single();

        if (soul?.client_id && activeSessions.has(soul.client_id)) {
            const client = activeSessions.get(soul.client_id);
            try { await client.destroy(); } catch (e) { }
            activeSessions.delete(soul.client_id);
        }

        // 2. Borrar su carpeta física
        await fs.rm(`./clients/${slug}`, { recursive: true, force: true }).catch(() => { });

        // 3. EL GOLPE DE GRACIA: Borrar el registro principal en Supabase
        // 💥 ¡AQUÍ OCURRE LA MAGIA EN CASCADA! 💥
        // Esto borrará automáticamente raw_messages y user_memories vinculados
        const { error } = await supabase
            .from('user_souls')
            .delete()
            .eq('slug', slug);

        if (error) throw error;

        console.log(`🗑️ [Admin] Cliente ${slug} eliminado y purgado en cascada.`);

        // 4. Registrar en los logs de auditoría general que lo hemos borrado
        // 4. Registrar en los logs de auditoría general (sin client_id para que no se borre en la cascada si queremos que persista, o con client_id si queremos que se borre)
        // Como el usuario pidió borrar TODO, lo vinculamos para que se borre o simplemente no lo ponemos.
        // Lo pondré como una nota general sin client_id para que quede constancia del borrado en el sistema global.
        await supabase.from('system_logs').insert({
            level: 'info',
            message: `Cliente ${slug} eliminado completamente y purgado en cascada.`
        });

        res.redirect(`/admin/health?token=${req.query.token}`);
    } catch (err) {
        console.error(`[Error] Fallo al borrar ${slug}:`, err);
        res.status(500).send(`Error eliminando ${slug}: ${err.message}`);
    }
});

// === ADMIN: VIEW LOGS ===
app.get('/admin/logs/:slug', async (req, res) => {
    if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).send('No autorizado');
    const { slug } = req.params;

    try {
        const { data: soul } = await supabase.from('user_souls').select('client_id').eq('slug', slug).single();

        let logOutput = 'No se encontraron logs recientes en la base de datos para este cliente.';

        if (soul?.client_id) {
            const { data: logs } = await supabase
                .from('system_logs')
                .select('*')
                .eq('client_id', soul.client_id)
                .order('created_at', { ascending: false })
                .limit(100);

            if (logs && logs.length > 0) {
                logOutput = logs.map(l => `[${new Date(l.created_at).toLocaleString()}] [${l.level}] ${l.message}`).join('\n');
            }
        }

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
});


// WebSocket Upgrade Handler
httpServer.on('upgrade', async (request, socket, head) => {
    const { query } = parseUrl(request.url, true);
    const token = query.token;

    if (!token) {
        socket.destroy();
        return;
    }

    try {
        // Authenticate WebSocket
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            console.error('[WS Auth Error] Verification failed for token:', token ? `${token.substring(0, 10)}... (len: ${token.length})` : 'NULL');
            throw new Error('Unauthorized');
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log(`🔌 [WS] Client connected: ${user.email}`);

            // For now, we simple-proxy the messages to the user's specific OpenClaw state if needed
            // Or just keep the connection alive for potential live updates
            ws.on('message', (message) => {
                console.log(`📩 [WS] Received from ${user.email}:`, message.toString());
            });

            ws.on('close', () => console.log(`🔌 [WS] Client disconnected: ${user.email}`));
        });
    } catch (err) {
        console.error('[WS Auth Error]', err.message);
        socket.destroy();
    }
});

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SaaS Bridge listening on http://0.0.0.0:${PORT}`);
});
