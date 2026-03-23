import { validateGroundedGraph } from '../utils/knowledge_guard.mjs';

function runCase(name, input, expectedCount, predicate = null) {
    const result = validateGroundedGraph(input);
    const relationships = result.relationships || [];
    const countMatches = relationships.length === expectedCount;
    const predicateMatches = predicate ? predicate(relationships) : true;

    return {
        name,
        passed: countMatches && predicateMatches,
        expected_count: expectedCount,
        actual_count: relationships.length,
        relationships
    };
}

const baseCases = [
    runCase(
        'reject_generic_friendliness',
        {
            entities: [
                { name: 'Jairo', type: 'PERSONA', desc: 'titular', evidence: 'Jairo: Si quieres pa las 5 o 6 vente mañana' },
                { name: 'Andrea', type: 'PERSONA', desc: 'contacto', evidence: 'Andrea: vale' }
            ],
            relationships: [
                {
                    source: 'Jairo',
                    target: 'Andrea',
                    type: '[AMISTAD]',
                    weight: 8,
                    context: 'Amigos que se divierten',
                    evidence: 'Jairo: Si quieres pa las 5 o 6 vente mañana'
                }
            ],
            chunkText: 'Jairo: Si quieres pa las 5 o 6 vente mañana\nAndrea: vale',
            ownerName: 'Jairo',
            contactName: 'Andrea',
            remoteId: '34636314284@s.whatsapp.net',
            isGroup: false,
            speakers: ['Jairo', 'Andrea']
        },
        0
    ),
    runCase(
        'reject_missing_target_preference',
        {
            entities: [
                { name: 'Naiara', type: 'PERSONA', desc: 'contacto', evidence: 'Naiara: Siii de verdad que me gustan mucho' },
                { name: 'Jairo', type: 'PERSONA', desc: 'titular', evidence: 'Jairo: ok' }
            ],
            relationships: [
                {
                    source: 'Naiara',
                    target: 'Jairo',
                    type: '[PREFIERE]',
                    weight: 7,
                    context: 'Naiara prefiere hablar con Jairo',
                    evidence: 'Naiara: Siii de verdad que me gustan mucho'
                }
            ],
            chunkText: 'Naiara: Siii de verdad que me gustan mucho\nJairo: ok',
            ownerName: 'Jairo',
            contactName: 'Naiara',
            remoteId: '34637157985@s.whatsapp.net',
            isGroup: false,
            speakers: ['Naiara', 'Jairo']
        },
        0
    ),
    runCase(
        'allow_private_meeting_intent',
        {
            entities: [
                { name: 'Jairo', type: 'PERSONA', desc: 'titular', evidence: 'Jairo: Tengo ganas de conocernos en persona la verdad' },
                { name: 'Lydia Insta', type: 'PERSONA', desc: 'contacto', evidence: 'Lydia Insta: jaja' }
            ],
            relationships: [
                {
                    source: 'Jairo',
                    target: 'Lydia Insta',
                    type: '[CONOCE_A]',
                    weight: 7,
                    context: 'conversacion en un chat privado',
                    evidence: 'Jairo: Tengo ganas de conocernos en persona la verdad'
                }
            ],
            chunkText: 'Jairo: Tengo ganas de conocernos en persona la verdad\nLydia Insta: jaja',
            ownerName: 'Jairo',
            contactName: 'Lydia Insta',
            remoteId: '34607687246@s.whatsapp.net',
            isGroup: false,
            speakers: ['Jairo', 'Lydia Insta']
        },
        1,
        relationships => relationships[0]?.type === '[CONOCE_A]'
    ),
    runCase(
        'dedupe_symmetric_friendship',
        {
            entities: [
                { name: 'Andrea', type: 'PERSONA', desc: 'contacto', evidence: 'Andrea: eres mi amiga' },
                { name: 'Jairo', type: 'PERSONA', desc: 'titular', evidence: 'Jairo: amiga total' }
            ],
            relationships: [
                {
                    source: 'Jairo',
                    target: 'Andrea',
                    type: '[AMISTAD]',
                    weight: 8,
                    context: 'Jairo y Andrea son amigos',
                    evidence: 'Jairo: Andrea eres mi amiga'
                },
                {
                    source: 'Andrea',
                    target: 'Jairo',
                    type: '[AMISTAD]',
                    weight: 8,
                    context: 'Andrea y Jairo son amigos',
                    evidence: 'Andrea: Jairo eres mi amigo'
                }
            ],
            chunkText: 'Jairo: Andrea eres mi amiga\nAndrea: Jairo eres mi amigo',
            ownerName: 'Jairo',
            contactName: 'Andrea',
            remoteId: '34636314284@s.whatsapp.net',
            isGroup: false,
            speakers: ['Jairo', 'Andrea']
        },
        1
    )
];

const passed = baseCases.filter(item => item.passed).length;
const summary = {
    total_cases: baseCases.length,
    passed_cases: passed,
    pass_rate: baseCases.length ? Number((passed / baseCases.length).toFixed(4)) : 0,
    failures: baseCases.filter(item => !item.passed)
};

console.log(JSON.stringify(summary, null, 2));
