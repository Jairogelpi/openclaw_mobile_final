import 'dotenv/config';
import { processMessage } from '../core/core_engine.mjs';

async function runTests() {
    const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6'; // Using the active test client ID

    console.log("==========================================");
    console.log("🧪 TEST 1: KNOWLEDGE GRAPH (Local/Private)");
    console.log("Query: 'Quién es mi novia?'");
    console.log("Expected: Web Search MUST be skipped.");
    console.log("==========================================");

    const reply1 = await processMessage({
        clientId: clientId,
        clientSlug: 'jairogelpi-cc2af',
        channel: 'whatsapp',
        senderId: 'SYSTEM_TEST',
        text: '¿Quién es mi novia?',
        isSentByMe: false
    });

    console.log("\n[RESPUESTA TEST STR]: ", reply1 ? reply1.substring(0, 100) : null);

    console.log("\n==========================================");
    console.log("🧪 TEST 2: TAVILY WEB SEARCH (External/Public)");
    console.log("Query: 'Quién ganó el mundial de futbol en 2022 o 2026?'");
    console.log("Expected: Web Search MUST be triggered.");
    console.log("==========================================");

    const reply2 = await processMessage({
        clientId: clientId,
        clientSlug: 'jairogelpi-cc2af',
        channel: 'whatsapp',
        senderId: 'SYSTEM_TEST',
        text: '¿Quién ganó el mundial de futbol en 2022?', // simplified just for pure fact search
        isSentByMe: false
    });

    console.log("\n[RESPUESTA TEST STR]: ", reply2 ? reply2.substring(0, 100) : null);

    console.log("\n✅ PRUEBAS FINALIZADAS.");
    process.exit(0);
}

runTests();
