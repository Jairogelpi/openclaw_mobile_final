import { IdentityService } from './services/intelligence/identity.service.mjs';

async function testResolution() {
    console.log("🧪 Testing Neural Identity Resolution...");
    
    const clientId = 'test-client';
    const remoteId = '34600000000@s.whatsapp.net';
    
    const conversation = [
        "Jairo: Oye, ¿quién es el que viene hoy?",
        "34600000000: Soy yo, Manuel, el de la mudanza.",
        "Jairo: Ah vale Manuel, perdona que no te tenía guardado."
    ];

    console.log("Scenario 1: Explicit self-identification from number");
    const result = await IdentityService.resolveIdentityNeural(clientId, remoteId, conversation, { pushName: 'M.' });
    console.log("Result:", result);

    const scenario2 = [
        "Jairo: No sé si llamarle.",
        "34600000000: Llámale, a mi madre le cae bien.",
        "Jairo: ¿A tu madre?"
    ];

    console.log("\nScenario 2: Relationship-based identity (should fail or give low confidence name)");
    const result2 = await IdentityService.resolveIdentityNeural(clientId, remoteId, scenario2, { pushName: 'M.' });
    console.log("Result:", result2);
}

testResolution().catch(console.error);
