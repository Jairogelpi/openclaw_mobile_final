import groq from '../services/groq.mjs';

/**
 * Divide un texto largo en fragmentos semánticos y les añade contexto global del documento.
 * Inspirado en "Contextual Retrieval" de Anthropic.
 */
export async function chunkAndContextualize(fullText, metadata = {}) {
    const CHUNK_SIZE = 800; // Tokens aproximados/palabras
    const OVERLAP = 100;

    // Simplificación de tokenización por palabras
    const words = fullText.split(/\s+/);
    const chunks = [];

    for (let i = 0; i < words.length; i += (CHUNK_SIZE - OVERLAP)) {
        const chunkContent = words.slice(i, i + CHUNK_SIZE).join(' ');
        if (chunkContent.trim().length > 0) {
            chunks.push({
                content: chunkContent,
                index: chunks.length,
                total: 0 // Se actualizará al final
            });
        }
        if (i + CHUNK_SIZE >= words.length) break;
    }

    const totalChunks = chunks.length;
    console.log(`[Chunker] 🧩 Generando contexto para ${totalChunks} fragmentos...`);

    // Si solo hay un fragmento, no hace falta contextualizar
    if (totalChunks <= 1) {
        return chunks.map(c => ({ ...c, total: totalChunks, contextualized: c.content }));
    }

    // Generar un resumen global para la contextualización
    // Limitamos el texto enviado para el resumen si es masivo
    const previewText = fullText.substring(0, 5000);

    // Procesar en paralelo (limitado para no saturar API)
    const contextualizedChunks = await Promise.all(chunks.map(async (chunk) => {
        try {
            const response = await groq.chat.completions.create({
                model: 'llama-3.1-8b-instant',
                messages: [
                    {
                        role: 'system',
                        content: `Eres un Asistente de Contexto. Tu tarea es generar una breve frase (máximo 20 palabras) 
                        que sitúe el fragmento de texto proporcionado dentro del documento global.
                        
                        DOCUMENTO GLOBAL (Resumen/Inicio):
                        ${previewText}
                        
                        METADATOS:
                        ${JSON.stringify(metadata)}`
                    },
                    {
                        role: 'user',
                        content: `FRAGMENTO A CONTEXTUALIZAR (Índice ${chunk.index + 1}/${totalChunks}):\n${chunk.content.substring(0, 500)}...`
                    }
                ],
                temperature: 0.1,
                max_tokens: 100
            });

            const contextHeader = response.choices[0].message.content.trim();
            return {
                ...chunk,
                total: totalChunks,
                contextualized: `[Contexto: ${contextHeader}] ${chunk.content}`
            };
        } catch (err) {
            console.warn(`[Chunker] ⚠️ Error contextualizando chunk ${chunk.index}:`, err.message);
            return { ...chunk, total: totalChunks, contextualized: chunk.content };
        }
    }));

    return contextualizedChunks;
}
