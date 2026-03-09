import test from 'node:test';
import assert from 'node:assert/strict';
import { rerankEvidenceCandidates } from '../services/reranker.mjs';

test('prioriza media con anclaje explicito frente a recuerdo debil', async () => {
    const ranked = await rerankEvidenceCandidates({
        queryText: 'recuerdas el audio de Mireya',
        plan: { intent: 'media_lookup', entities: ['Mireya'] },
        semanticEnabled: false,
        maxCandidates: 2,
        candidates: [
            {
                source_id: 'weak',
                source_kind: 'memory_chunk',
                directness: 'direct',
                evidence_text: 'Mireya dijo algo y luego hablaron.',
                speaker: 'Mireya',
                timestamp: new Date().toISOString(),
                recall_score: 0.95,
                metadata: {}
            },
            {
                source_id: 'strong',
                source_kind: 'memory_chunk',
                directness: 'direct',
                evidence_text: 'Escuchaste mi audio de llorona.',
                speaker: 'Mireya',
                timestamp: new Date().toISOString(),
                recall_score: 0.9,
                metadata: {
                    explicitMediaAnchor: true,
                    mediaSnippet: 'Escuchaste mi audio de llorona.'
                }
            }
        ]
    });

    assert.equal(ranked[0].source_id, 'strong');
});

test('penaliza evidencia conflictiva en preguntas relacionales', async () => {
    const ranked = await rerankEvidenceCandidates({
        queryText: 'que relacion hay entre Jairo y Mireya',
        plan: { intent: 'relationship_lookup', entities: ['Jairo', 'Mireya'], relation_filter: 'PAREJA_DE' },
        semanticEnabled: false,
        maxCandidates: 2,
        candidates: [
            {
                source_id: 'conflicted',
                source_kind: 'fact',
                directness: 'direct',
                evidence_text: 'Jairo tiene relacion [PAREJA_DE] con Mireya.',
                speaker: 'Jairo',
                timestamp: new Date().toISOString(),
                recall_score: 0.99,
                metadata: {
                    fact_type: 'relationship_edge',
                    relation_type: '[PAREJA_DE]',
                    cognitive_flags: ['conflicted'],
                    stability_tier: 'stable',
                    stable_score: 12
                }
            },
            {
                source_id: 'clean',
                source_kind: 'fact',
                directness: 'direct',
                evidence_text: 'Jairo tiene relacion [PAREJA_DE] con Mireya.',
                speaker: 'Jairo',
                timestamp: new Date().toISOString(),
                recall_score: 0.92,
                metadata: {
                    fact_type: 'relationship_edge',
                    relation_type: '[PAREJA_DE]',
                    stability_tier: 'stable',
                    stable_score: 12
                }
            }
        ]
    });

    assert.equal(ranked[0].source_id, 'clean');
});
