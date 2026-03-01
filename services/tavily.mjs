import { tavily } from '@tavily/core';

/**
 * Servicio para realizar búsquedas proactivas en la web usando el SDK oficial de Tavily.
 * Optimizado para proporcionar contexto relevante a LLMs.
 */
export async function searchWeb(query) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
        console.warn('⚠️ [Tavily] TAVILY_API_KEY no encontrada en .env.');
        return null;
    }

    try {
        console.log(`🔍 [Tavily SDK] Investigando: "${query}"...`);
        const client = tavily({ apiKey });

        const response = await client.search(query, {
            searchDepth: "advanced",
            maxResults: 3,
            includeAnswer: true
        });

        let context = `[RESULTADOS DE BÚSQUEDA WEB PARA: ${query}]\n`;
        if (response.answer) {
            context += `RESUMEN IA: ${response.answer}\n\n`;
        }

        response.results.forEach((res, i) => {
            context += `${i + 1}. ${res.title}\nURL: ${res.url}\nCONTENIDO: ${res.content}\n\n`;
        });

        return context;
    } catch (e) {
        console.error(`❌ [Tavily SDK] Error en la búsqueda:`, e.message);
        return null;
    }
}
