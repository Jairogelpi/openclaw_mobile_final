import 'dotenv/config';
import { ExtractionService } from './services/intelligence/extraction.service.mjs';

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6'; // Jairo
const ownerName = 'Jairo';
const contactName = 'Manuel';
const remoteId = 'manuel@s.whatsapp.net';

const conversation = [
    "Manuel: Tío, no puedo más con el TFM. Me siento súper inútil y agobiado.",
    "Jairo: Tranquilo tío, que tú eres un perfeccionista y por eso te agobias. Pero vas a sacarlo, eres de los que no se rinden.",
    "Manuel: Es que la bronquitis me ha dejado sin fuerzas. No tengo energía para nada.",
    "Jairo: Descansa hoy. Lo primero es la salud. El TFM puede esperar un día."
];

async function test() {
    console.log("🧪 Testing Level 5 Hyper-Extraction...");
    const result = await ExtractionService.extractGroundedGraph(clientId, remoteId, ownerName, contactName, conversation, { isGroup: false });
    console.log("📊 Results:", JSON.stringify(result, null, 2));
}

test().catch(console.error);
