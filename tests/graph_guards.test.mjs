import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEntityAdmissibility } from '../utils/graph_admissibility_policy.mjs';
import { deriveEffectiveEntityType, extractDeterministicRelationships, normalizeEntityName, validateGroundedGraph } from '../utils/knowledge_guard.mjs';
import { computeEdgeStability } from '../utils/stable_graph_policy.mjs';

function validateGraph(input) {
    return validateGroundedGraph({
        ownerName: 'Jairo',
        contactName: input.contactName || 'Naiara',
        remoteId: input.remoteId || '34637157985@s.whatsapp.net',
        chunkText: input.chunkText,
        entities: input.entities,
        relationships: input.relationships,
        isGroup: input.isGroup || false,
        speakers: input.speakers || []
    });
}

test('rejects talks-about when the evidence actually means talks with', () => {
    const result = validateGraph({
        chunkText: 'Jairo: Quiero hablar con Victor esta tarde.',
        entities: [
            { name: 'Jairo', type: 'PERSONA', evidence: 'Jairo: Quiero hablar con Victor esta tarde.' },
            { name: 'Victor', type: 'PERSONA', evidence: 'Jairo: Quiero hablar con Victor esta tarde.' }
        ],
        relationships: [
            {
                source: 'Jairo',
                target: 'Victor',
                type: '[HABLA_DE]',
                context: 'Jairo quiere hablar con Victor',
                evidence: 'Jairo: Quiero hablar con Victor esta tarde.'
            }
        ]
    });

    assert.equal(result.relationships.length, 0);
});

test('rejects group talks-about person edges even if the llm uses the group label as source', () => {
    const result = validateGraph({
        contactName: 'Master (3)',
        remoteId: '120363412380291213@g.us',
        isGroup: true,
        speakers: ['Jairo', 'Victor'],
        chunkText: 'Victor: Te respondo sobre el codigo, Jairo.',
        entities: [
            { name: 'Master (3)', type: 'GRUPO', evidence: 'Victor: Te respondo sobre el codigo, Jairo.' },
            { name: 'Jairo', type: 'PERSONA', evidence: 'Victor: Te respondo sobre el codigo, Jairo.' }
        ],
        relationships: [
            {
                source: 'Master (3)',
                target: 'Jairo',
                type: '[HABLA_DE]',
                context: 'respuesta sobre el codigo',
                evidence: 'Victor: Te respondo sobre el codigo, Jairo.'
            }
        ]
    });

    assert.equal(result.relationships.length, 0);
});

test('keeps explicit talks-about when the wording is actually about someone', () => {
    const result = validateGraph({
        chunkText: 'Jairo: Hoy hablaba de Victor y de como le va en el trabajo.',
        entities: [
            { name: 'Jairo', type: 'PERSONA', evidence: 'Jairo: Hoy hablaba de Victor y de como le va en el trabajo.' },
            { name: 'Victor', type: 'PERSONA', evidence: 'Jairo: Hoy hablaba de Victor y de como le va en el trabajo.' }
        ],
        relationships: [
            {
                source: 'Jairo',
                target: 'Victor',
                type: '[HABLA_DE]',
                context: 'habla de Victor',
                evidence: 'Jairo: Hoy hablaba de Victor y de como le va en el trabajo.'
            }
        ]
    });

    assert.equal(result.relationships.length, 1);
    assert.equal(result.relationships[0].type, '[HABLA_DE]');
});

test('keeps generic related-to as candidate when the support is weak', () => {
    const result = computeEdgeStability({
        relationType: '[RELACIONADO_CON]',
        context: 'comparacion',
        supportCount: 1,
        weight: 1,
        sourceTags: ['grounded_extraction'],
        flags: ['grounded']
    });

    assert.equal(result.tier, 'candidate');
    assert.equal(result.promote, false);
});

test('downgrades talks-about with reply-like context to candidate', () => {
    const result = computeEdgeStability({
        relationType: '[HABLA_DE]',
        context: 'respuesta sobre el codigo',
        supportCount: 4,
        weight: 5,
        sourceTags: ['grounded_extraction'],
        flags: ['grounded', 'direct']
    });

    assert.equal(result.tier, 'candidate');
    assert.equal(result.promote, false);
});

test('allows concrete know-person edges to stay promotable', () => {
    const result = computeEdgeStability({
        relationType: '[CONOCE_A]',
        context: 'Jairo conoce a Victor desde hace anos',
        supportCount: 3,
        weight: 7,
        sourceTags: ['grounded_extraction'],
        flags: ['grounded', 'direct']
    });

    assert.notEqual(result.tier, 'candidate');
    assert.equal(result.promote, true);
});

test('rejects role-like person mentions without a real anchor', () => {
    const result = evaluateEntityAdmissibility({
        name: 'su hermana',
        type: 'PERSONA',
        desc: 'Hermana de Lydia Insta',
        evidence: 'Lydia hablaba de su hermana.',
        knownNames: new Set(),
        remoteId: null,
        isGroup: false,
        chunkText: 'Lydia hablaba de su hermana.',
        groundedBySpeaker: false,
        groundedByEvidence: false,
        groundedByMention: true
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'role_mention_person');
});

test('downgrades friendship edges with generic reference context', () => {
    const result = computeEdgeStability({
        relationType: '[AMISTAD]',
        context: 'referencia a una persona',
        supportCount: 1,
        weight: 5,
        sourceTags: ['grounded_extraction'],
        flags: ['grounded']
    });

    assert.equal(result.tier, 'candidate');
    assert.equal(result.promote, false);
});

test('downgrades friendship edges with message-exchange context', () => {
    const result = computeEdgeStability({
        relationType: '[AMISTAD]',
        context: 'intercambio de mensajes',
        supportCount: 3,
        weight: 7,
        sourceTags: ['grounded_extraction'],
        flags: ['grounded', 'direct']
    });

    assert.equal(result.tier, 'candidate');
    assert.equal(result.promote, false);
});

test('rejects friendship edges without explicit friendship wording', () => {
    const result = validateGraph({
        chunkText: 'Jairo: Estuve hablando con Naiara un rato.',
        entities: [
            { name: 'Jairo', type: 'PERSONA', evidence: 'Jairo: Estuve hablando con Naiara un rato.' },
            { name: 'Naiara', type: 'PERSONA', evidence: 'Jairo: Estuve hablando con Naiara un rato.' }
        ],
        relationships: [
            {
                source: 'Jairo',
                target: 'Naiara',
                type: '[AMISTAD]',
                context: 'intercambio de mensajes',
                evidence: 'Jairo: Estuve hablando con Naiara un rato.'
            }
        ]
    });

    assert.equal(result.relationships.length, 0);
});

test('keeps friendship edges when the wording is explicitly about friendship', () => {
    const result = validateGraph({
        chunkText: 'Jairo: Naiara es mi amiga desde hace anos.',
        entities: [
            { name: 'Jairo', type: 'PERSONA', evidence: 'Jairo: Naiara es mi amiga desde hace anos.' },
            { name: 'Naiara', type: 'PERSONA', evidence: 'Jairo: Naiara es mi amiga desde hace anos.' }
        ],
        relationships: [
            {
                source: 'Jairo',
                target: 'Naiara',
                type: '[AMISTAD]',
                context: 'Naiara es mi amiga desde hace anos',
                evidence: 'Jairo: Naiara es mi amiga desde hace anos.'
            }
        ]
    });

    assert.equal(result.relationships.length, 1);
    assert.equal(result.relationships[0].type, '[AMISTAD]');
});

test('rejects inverted pareja direction when the speaker is explicitly the target side', () => {
    const result = validateGraph({
        contactName: 'Mireya',
        chunkText: 'Mireya: Te amo mi vida gracias por verme tan por dentro y todo.',
        entities: [
            { name: 'Jairo', type: 'PERSONA', evidence: 'Mireya: Te amo mi vida gracias por verme tan por dentro y todo.' },
            { name: 'Mireya', type: 'PERSONA', evidence: 'Mireya: Te amo mi vida gracias por verme tan por dentro y todo.' }
        ],
        relationships: [
            {
                source: 'Jairo',
                target: 'Mireya',
                type: '[PAREJA_DE]',
                context: 'cue:te amo | Mireya: Te amo mi vida gracias por verme tan por dentro y todo',
                evidence: 'Mireya: Te amo mi vida gracias por verme tan por dentro y todo.'
            }
        ]
    });

    assert.equal(result.relationships.length, 0);
});

test('quarantines contextual person labels like otro con el que trabajo', () => {
    const result = evaluateEntityAdmissibility({
        name: 'otro con el que trabajo',
        type: 'PERSONA',
        desc: 'Colaborador de Jairo',
        evidence: 'Jairo hablaba de otro con el que trabajo.',
        knownNames: new Set(),
        remoteId: null,
        isGroup: false,
        chunkText: 'Jairo hablaba de otro con el que trabajo.',
        groundedBySpeaker: false,
        groundedByEvidence: false,
        groundedByMention: true
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'role_mention_person');
});

test('retypes group-like person labels to GRUPO and blocks role mentions as PERSONA', () => {
    assert.equal(deriveEffectiveEntityType('Máster INESDI', 'PERSONA'), 'GRUPO');
    assert.equal(deriveEffectiveEntityType('mi colega', 'PERSONA'), null);
});

test('normalizes spaced or decorated entity names before graph insertion', () => {
    assert.equal(normalizeEntityName('y o', 'Jairo'), 'Jairo');
    assert.equal(normalizeEntityName('𝑇𝑒𝑗𝑒𝑟𝑜'), 'Tejero');
    assert.equal(normalizeEntityName('mi clon (yo)', 'Jairo'), 'Jairo');
});
