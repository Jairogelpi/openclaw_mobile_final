import { searchWeb } from '../services/tavily.mjs';

/**
 * Skill: Tavily Web Search
 * AI-optimized web search via Tavily API. Returns concise, relevant results for AI agents.
 */
export default {
    name: 'tavily_search',
    description: 'Use this skill to search the internet for real-time information, news, external facts, or current events. Do not use this for personal memory.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The exact search query to look up on the internet.'
            }
        },
        required: ['query']
    },
    async execute(params, context) {
        const { query } = params;

        if (!query) return "[Tavily Search] Error: No query provided.";

        console.log(`🌐 [Skill: tavily_search] Ejecutando búsqueda para: "${query}"`);

        const results = await searchWeb(query);

        if (results) {
            return results;
        } else {
            return `[Tavily Search] ❌ No se encontraron resultados o hubo un error al buscar: "${query}"`;
        }
    }
};
