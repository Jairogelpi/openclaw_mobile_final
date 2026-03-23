import 'dotenv/config';
import supabase from '../config/supabase.mjs';
import groq from '../services/groq.mjs';
import fetch from 'node-fetch';

/**
 * Worker para procesar enlaces y archivos multimedia en segundo plano.
 * Extrae contenido, lo resume y lo guarda en la Memoria Semántica (RAG).
 */

const urlRegex = /(https?:\/\/[^\s]+)/g;

async function extractTextFromURL(url) {
    let browser = null;
    try {
        console.log(`🔗 [Scraper] Intentando extracción rápida (fetch): ${url}`);
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });

        const html = await response.text();
        const isLowContent = html.length < 1000;
        const isBlocked = response.status === 403 || response.status === 401 || html.includes('CAPTCHA') || html.includes('detected unusual traffic');

        if (!isBlocked && !isLowContent) {
            console.log(`✅ [Scraper] Extracción rápida exitosa.`);
            return cleanHTML(html);
        }

        console.log(`🎭 [Scraper] Fetch bloqueado o poco contenido (${response.status}). Activando Playwright (Chromium)...`);
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        const content = await page.innerText('body');

        await browser.close();
        console.log(`🚀 [Scraper] Extracción con Playwright completada (${content.length} chars).`);
        return content.substring(0, 15000);

    } catch (e) {
        console.warn(`⚠️ [Scraper] Fallo total en URL ${url}:`, e.message);
        if (browser) await browser.close();
        return null;
    }
}

function cleanHTML(html) {
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 15000);
}

async function processNewLinks() {
    try {
        // Buscamos mensajes con URLs o Media que aún no han sido "scraped"
        const { data: messages, error } = await supabase
            .from('raw_messages')
            .select('*')
            .is('metadata->scraped', null)
            .ilike('content', '%http%') // Por ahora solo si tiene http o media
            .order('created_at', { ascending: false })
            .limit(10);

        // También buscamos los que tienen media explícita
        const { data: mediaMessages } = await supabase
            .from('raw_messages')
            .select('*')
            .is('metadata->scraped', null)
            .eq('metadata->hasMedia', true)
            .limit(10);

        const allMessages = [...(messages || []), ...(mediaMessages || [])];
        // Eliminar duplicados por ID
        const uniqueMessages = Array.from(new Map(allMessages.map(m => [m.id, m])).values());

        if (uniqueMessages.length === 0) return;

        for (const msg of uniqueMessages) {
            const urls = msg.content?.match(urlRegex);
            const hasMedia = msg.metadata?.hasMedia;
            let rawText = null;
            let summary = null;
            let sourceUrl = null;

            if (urls) {
                sourceUrl = urls[0];
                let isYouTube = sourceUrl.includes('youtube.com') || sourceUrl.includes('youtu.be');

                if (isYouTube) {
                    console.log(`📺 [Scraper] Detectado YouTube: ${sourceUrl}`);
                    try {
                        const { YoutubeTranscript } = await import('youtube-transcript');
                        const transcript = await YoutubeTranscript.fetchTranscript(sourceUrl);
                        if (transcript && transcript.length > 0) {
                            rawText = `[YOUTUBE TRANSCRIPT]: ${transcript.map(t => t.text).join(' ')}`;
                        }
                    } catch (ytErr) {
                        console.error(`❌ [Scraper] Error YouTube:`, ytErr.message);
                    }
                } else {
                    rawText = await extractTextFromURL(sourceUrl);
                }
            } else if (hasMedia) {
                console.log(`📦 [Scraper] Procesando media en mensaje ${msg.id}...`);
                try {
                    const { processAttachment } = await import('../utils/media.mjs');
                    const result = await processAttachment(msg.metadata);
                    if (result && result.text) {
                        rawText = result.text;
                    }
                } catch (mediaErr) {
                    console.error(`❌ [Scraper] Error en media:`, mediaErr.message);
                }
            }

            if (rawText && rawText.length > 50) {
                console.log(`🧠 [Scraper] Resumiendo contenido para memoria...`);
                try {
                    const aiResponse = await groq.chat.completions.create({
                        model: 'llama-3.3-70b-versatile',
                        messages: [
                            { role: 'system', content: 'Eres un analista. Resume este contenido en 2 párrafos útiles para memoria a largo plazo.' },
                            { role: 'user', content: `CONTENIDO: ${rawText}` }
                        ]
                    });
                    summary = aiResponse.choices[0].message.content.trim();
                } catch (llmErr) {
                    console.error(`❌ [Scraper] Error LLM:`, llmErr.message);
                }
            }

            if (summary) {
                await supabase.from('user_memories').insert({
                    client_id: msg.client_id,
                    content: `[KNOWLEDGE]: ${summary}`,
                    sender: 'SISTEMA_SCRAPER',
                    remote_id: msg.remote_id,
                    memory_type: 'knowledge',
                    metadata: { source: urls ? 'url' : 'media', url: sourceUrl, original_msg_id: msg.id }
                });
            }

            // Marcar como procesado
            await supabase.from('raw_messages').update({
                metadata: { ...(msg.metadata || {}), scraped: true }
            }).eq('id', msg.id);

            // --- FASE 3: DESTILACIÓN AGÉNTICA AL GRAFO ---
            if (rawText && rawText.length > 200) {
                console.log(`🕸️ [Scraper Graph] Extrayendo entidades del contenido...`);
                await distillKnowledgeFromContent(msg.client_id, rawText);
            }
        }
    } catch (err) {
        console.error('❌ [Scraper Worker] Error:', err.message);
    }
}

/**
 * Extrae tripletes y los inyecta en el grafo de conocimiento
 */
async function distillKnowledgeFromContent(clientId, text) {
    try {
        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{
                role: 'system', content: `Eres el Arquitecto de Grafos de OpenClaw. Extrae relaciones atómicas [Sujeto, Predicado, Objeto] del texto proporcionado.
                Enfócate en Personas, Empresas, Proyectos y Hechos fijos.
                
                Devuelve JSON: { "triplets": [ ["S", "P", "O"], ... ] }`
            }, { role: 'user', content: `TEXTO:\n${text.substring(0, 5000)}` }],
            response_format: { type: 'json_object' },
            temperature: 0.1
        });

        const { triplets } = JSON.parse(response.choices[0].message.content);
        if (triplets && triplets.length > 0) {
            const { upsertKnowledgeNode, upsertKnowledgeEdge } = await import('../services/graph.service.mjs');
            for (const [s, p, o] of triplets) {
                await upsertKnowledgeNode(clientId, s, 'ENTITY', '', { source: 'scraper' });
                await upsertKnowledgeNode(clientId, o, 'ENTITY', '', { source: 'scraper' });
                await upsertKnowledgeEdge(clientId, s, o, p, 1, null, ['direct'], { source: 'scraper' });
            }
            console.log(`✅ [Scraper Graph] ${triplets.length} conexiones añadidas.`);
        }
    } catch (e) {
        console.warn(`⚠️ [Scraper Graph] Error destilando:`, e.message);
    }
}

async function main() {
    console.log('🔗 [Scraper Worker] Activo. Procesando enlaces y multimedia...');
    setInterval(processNewLinks, 30000);
    await processNewLinks();
}

main().catch(console.error);
