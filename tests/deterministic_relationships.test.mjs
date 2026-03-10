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

    assert.equal(relationships.length, 1);
    assert.equal(relationships[0].type, '[PAREJA_DE]');
    assert.equal(relationships[0].source, 'Jairo');
    assert.equal(relationships[0].target, 'Mireya');
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

test('does not infer pareja from idioms like peor etapa de mi vida', () => {
    const relationships = extractDeterministicRelationships({
        chunkText: 'Jairo: Pero estoy posiblemente en la peor etapa de mi vida.',
        ownerName: 'Jairo',
        contactName: 'Nerea',
        isGroup: false
    });

    assert.equal(relationships.length, 0);
});

test('does not infer pareja in self-like chats where contact label is the owner name', () => {
    const relationships = extractDeterministicRelationships({
        chunkText: 'Jairo: Mireya te amo.',
        ownerName: 'Jairo',
        contactName: 'Jairo Gelpi',
        isGroup: false
    });

    assert.equal(relationships.length, 0);
});

test('infers directed pareja relation from contact when romantic cue is explicit and addressed', () => {
    const relationships = extractDeterministicRelationships({
        chunkText: 'Mireya: Y te pienso cuidar siempre, mi vida.',
        ownerName: 'Jairo',
        contactName: 'Mireya',
        isGroup: false
    });

    assert.equal(relationships.length, 1);
    assert.equal(relationships[0].source, 'Mireya');
    assert.equal(relationships[0].target, 'Jairo');
    assert.equal(relationships[0].type, '[PAREJA_DE]');
});
