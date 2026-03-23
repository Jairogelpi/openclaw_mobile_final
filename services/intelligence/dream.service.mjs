import { LLMProviderService } from './llm_provider.service.mjs';
import supabase from '../../config/supabase.mjs';
import { generateEmbedding } from '../local_ai.mjs';

export class DreamService {
    /**
     * Discovers latent connections using neural-weighted semantic clusters.
     */
    static async performLatentDiscovery(clientId) {
        console.log(`🌙 [NeuralDream] Starting semantic consolidation for ${clientId}...`);
        
        // 1. Get high-entropy memories (the most semantically dense ones)
        // For now, we use recent ones as a proxy for 'fresh' cognitive load
        const { data: seedMemories } = await supabase
            .from('user_memories')
            .select('content, embedding')
            .eq('client_id', clientId)
            .order('created_at', { ascending: false })
            .limit(10);

        if (!seedMemories?.length) return;

        // 2. Neural Discovery: Find nodes semantically related to recent events
        // instead of random sampling.
        const seedText = seedMemories.map(m => m.content).join(' ');
        const seedVector = await generateEmbedding(seedText.slice(0, 500));

        const { data: relatedNodes } = await supabase.rpc('search_knowledge_nodes_v2', {
            cid: clientId,
            query: seedText.slice(0, 100), // Semantic hint
            lim: 30
        });

        const systemPrompt = `Eres el Subconsciente Neural. 
Tu tarea es realizar consolidación de memoria: integra hechos RECIENTES con el GRAFO existente.
Encuentra conexiones que no son obvias pero que tienen coherencia matemática/temática.

Responde SOLO JSON:
{"latent_connections": [{"source", "relation", "target", "reasoning", "confidence"}]}`;

        const responseText = await LLMProviderService.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `CONCEPTOS BASE:\n${relatedNodes?.map(n => n.entity_name).join(', ')}\n\nEVENTOS RECIENTES:\n${seedText}` }
        ], {
            model: 'llama-3.1-8b-instant',
            json: true,
            temperature: 0.4 // More "creativity" for dreaming
        });

        const discovery = LLMProviderService.parseJson(responseText);
        // ... (Save logic remains similar but uses LLMProvider)
    }
}
