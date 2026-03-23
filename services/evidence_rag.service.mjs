import { CognitiveContextService } from './intelligence/cognitive_context.service.mjs';
import { rerankEvidenceCandidates } from './reranker.mjs';
import { assignCitationLabels } from '../utils/rag_helpers.mjs';

/**
 * Neural-Only RAG Orquestrator.
 * Eliminates heuristics in favor of a unified cognitive context.
 */
export async function findEvidence(clientId, queryText, options = {}) {
    console.log(`[NeuralBrain] Processing query through mathematical context: "${queryText}"`);

    // 1. Unified Cognitive Retrieval (Math + Neural)
    // No "planning" or "intent" switching. Just build the context map.
    const cognitiveMap = await CognitiveContextService.buildCognitiveMap(clientId, queryText, options);

    // 2. Candidate Aggregation
    const candidates = [
        ...(cognitiveMap.episodic_memories || []).map(m => ({ 
            ...m, 
            source_id: m.id,
            evidence_text: m.content || '',
            speaker: m.sender,
            timestamp: m.date,
            source_kind: 'memory_chunk',
            directness: 'direct'
        })),
        ...(cognitiveMap.knowledge || []).map(n => ({ 
            source_id: n.id,
            evidence_text: `${n.entity_name}: ${n.description || (n.entity_type === 'RELACIÓN_HOP1' ? n.knowledge : 'sin descripción')}`,
            source_kind: 'graph_node',
            directness: 'direct',
            metadata: { type: n.entity_type, stability_tier: n.stability_tier, support_count: n.support_count }
        })),
        ...(cognitiveMap.relational_assets?.facts || []).map(f => ({
            ...f,
            source_kind: 'fact',
            directness: 'direct'
        }))
    ];

    // 3. Neural Reranking
    // Reranking is the final "mathematical filter" that decides relevance based on the unified context
    const ranked = await rerankEvidenceCandidates({
        queryText,
        plan: { entities: cognitiveMap.knowledge.map(n => n.entity_name) }, // Injected from graph
        candidates
    });
    trace?.setQueryStyle?.(detectQueryStyle(plan, queryText, candidates));

    return {
        candidates: assignCitationLabels(ranked.slice(0, 15)),
        cognitiveMap,
        system_instructions: `Eres el cerebro de ${cognitiveMap.identity.nombre || 'OpenClaw'}. 
Usa el contexto unificado para responder con consciencia de tu identidad y pasado.`
    };
}
