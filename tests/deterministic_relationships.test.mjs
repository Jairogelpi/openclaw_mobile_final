import test from 'node:test';
import assert from 'node:assert/strict';

import { extractDeterministicRelationships } from '../utils/knowledge_guard.mjs';

test('extracts deterministic pareja relations from explicit romantic cues in private chat', () => {
    const relationships = extractDeterministicRelationships({
        chunkText: 'Mireya: Eres lo mejor que hay ahora mismo en mi vida.\nJairo: Te amo mi vida.',
        ownerName: 'Jairo',
        contactName: 'Mireya',
        isGroup: false
    });

    assert.equal(relationships.length, 2);
    assert.ok(relationships.every(relationship => relationship.type === '[PAREJA_DE]'));
});

test('does not invent deterministic private-pair relations inside groups', () => {
    const relationships = extractDeterministicRelationships({
        chunkText: 'Victor: Te amo bro.',
        ownerName: 'Jairo',
        contactName: 'Master (3)',
        isGroup: true
    });

    assert.equal(relationships.length, 0);
});

test('does not infer pareja from generic affection words without direct romantic cue', () => {
    const relationships = extractDeterministicRelationships({
        chunkText: 'Jairo: Necesitaba sentir que alguien me quiera dar cariño.',
        ownerName: 'Jairo',
        contactName: 'Naiara',
        isGroup: false
    });

    assert.equal(relationships.length, 0);
});
