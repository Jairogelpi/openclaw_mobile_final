import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeGraphExtractionNeed } from '../utils/graph_prefilter.mjs';

test('skips llm extraction for participant-only banter', () => {
    const result = analyzeGraphExtractionNeed({
        chunkText: 'Jairo: De verdad.\nNaiara: Y a mi que me lo des, me encanta.',
        ownerName: 'Jairo',
        contactName: 'Naiara',
        isGroup: false
    });

    assert.equal(result.shouldRunLLM, false);
    assert.equal(result.reason, 'participant_only_banter');
});

test('runs llm extraction when there is an explicit work cue', () => {
    const result = analyzeGraphExtractionNeed({
        chunkText: 'Jairo: Trabajo en una empresa nueva y mi jefe está contento.',
        ownerName: 'Jairo',
        contactName: 'Naiara',
        isGroup: false
    });

    assert.equal(result.shouldRunLLM, true);
    assert.equal(result.reason, 'explicit_graph_cue');
});

test('runs llm extraction when there is a third-party reference', () => {
    const result = analyzeGraphExtractionNeed({
        chunkText: 'Jairo: He hablado con Victor sobre Madrid.',
        ownerName: 'Jairo',
        contactName: 'Naiara',
        isGroup: false
    });

    assert.equal(result.shouldRunLLM, true);
    assert.equal(result.reason, 'explicit_graph_cue');
});

test('skips llm extraction when deterministic relationship is enough', () => {
    const result = analyzeGraphExtractionNeed({
        chunkText: 'Mireya: Te amo mi vida.',
        ownerName: 'Jairo',
        contactName: 'Mireya',
        isGroup: false
    });

    assert.equal(result.shouldRunLLM, false);
    assert.equal(result.reason, 'deterministic_relationship_only');
    assert.equal(result.deterministicRelationships.length, 1);
});
