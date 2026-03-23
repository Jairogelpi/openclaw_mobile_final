import supabase from './config/supabase.mjs';
import { IdentityService } from './services/intelligence/identity.service.mjs';

async function discoverOwner() {
    console.log("🔍 Starting Behavioral Self-Discovery...");
    
    // 1. Get client ID (default for now)
    const clientId = '34664871032'; // In production this would be dynamic

    // 2. Fetch recent messages
    const { data: messages, error } = await supabase
        .from('raw_messages')
        .select('remote_id, content')
        .order('created_at', { ascending: false })
        .limit(100);

    if (error || !messages.length) {
        console.error("❌ Error fetching messages:", error?.message || "No messages found");
        return;
    }

    // 3. Run Neural Discovery
    const discovery = await IdentityService.discoverOwnerBehavioral(clientId, messages);
    
    if (discovery) {
        console.log("✅ Owner Discovered!");
        console.log(`- ID: ${discovery.ownerRemoteId}`);
        console.log(`- Name: ${discovery.ownerCanonicalName}`);
        console.log(`- Confidence: ${discovery.confidence}`);
        console.log(`- Reasoning: ${discovery.reasoning}`);
    } else {
        console.log("⚠️ Could not definitively identify the owner.");
    }
}

discoverOwner().catch(console.error);
