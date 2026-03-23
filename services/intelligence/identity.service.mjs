import supabase from '../../config/supabase.mjs';
import { LLMProviderService } from './llm_provider.service.mjs';
import { normalizeComparableText } from '../../utils/message_guard.mjs';

/**
 * Service to resolve and stabilize identities using LLM reasoning.
 * Moves away from hardcoded heuristics in identity_policy.mjs.
 */
export class IdentityService {
    static async resolveIdentityNeural(clientId, remoteId, conversationLines = [], metadata = {}) {
        // 1. Check Cache (Contact Identities table)
        const { data: existing } = await supabase
            .from('contact_identities')
            .select('*')
            .eq('client_id', clientId)
            .eq('remote_id', remoteId)
            .maybeSingle();

        // If we have a stable identity with high confidence, return it
        if (existing && existing.confidence > 0.9 && existing.canonical_name && !['Yo', 'Participante', 'Desconocido'].includes(existing.canonical_name)) {
            return {
                name: existing.canonical_name,
                confidence: existing.confidence,
                source: 'cached_neural'
            };
        }

        // 2. LLM Resolution
        const context = conversationLines.slice(-20).join('\n');
        const prompt = `Analiza el siguiente fragmento de chat de WhatsApp y determina la IDENTIDAD REAL del contacto "${remoteId}".
        
        SITUACIÓN:
        - Meta-datos Sugeridos: ${JSON.stringify(metadata)}
        - Fragmento de Chat:
        ${context}

        REGLAS:
        - Si el usuario dice "Juan", la identidad es "Juan".
        - Si el usuario lo llama "Tío" o "Bro", busca el nombre real en el histórico. 
        - Si no hay nombre real pero hay un rol (ej: "Mi Madre"), usa "Madre de [Titular]".
        - Evita nombres genéricos como "Participante" o "Yo".
        - Responde SOLO en JSON: { "canonicalName": "...", "confidence": 0.0, "reasoning": "..." }`;

        try {
            const response = await LLMProviderService.chat([
                { role: 'system', content: prompt }
            ], { model: 'llama-3.1-8b-instant', json: true });

            const resolution = LLMProviderService.parseJson(response);
            if (resolution?.canonicalName && resolution.confidence > 0.5) {
                // 3. Update Cache silently
                await this.updateIdentityCache(clientId, remoteId, resolution);
                return {
                    name: resolution.canonicalName,
                    confidence: resolution.confidence,
                    source: 'llm_resolved'
                };
            }
        } catch (err) {
            console.warn(`[IdentityService] Neural resolution failed for ${remoteId}: ${err.message}`);
        }

        return null; // Fallback to heuristics
    }

    /**
     * Level 6: Behavioral Self-Discovery
     * Analyzes a batch of messages to identify the "User" (Owner) of the account.
     */
    static async discoverOwnerBehavioral(clientId, messages = []) {
        if (!messages.length) return null;

        const sample = messages.slice(0, 50).map(m => `[${m.remote_id}] ${m.content}`).join('\n');
        const prompt = `Analiza este historial de chat y determina qué ID pertenece al DUEÑO del dispositivo (el "Yo").
        
        PISTAS:
        - El dueño suele ser el que envía más mensajes de sistema o comandos si los hay.
        - El dueño es referido como "tú" por los demás.
        - Busca mensajes donde alguien diga "Hola [Nombre]" dirigido al dueño.
        
        HISTORIAL:
        ${sample}

        Responde SOLO en JSON: { "ownerRemoteId": "...", "ownerCanonicalName": "...", "confidence": 0.0, "reasoning": "..." }`;

        try {
            const response = await LLMProviderService.chat([
                { role: 'system', content: prompt }
            ], { model: 'llama-3.3-70b-versatile', json: true });

            const discovery = LLMProviderService.parseJson(response);
            if (discovery?.ownerRemoteId && discovery.confidence > 0.6) {
                // Persist owner link in client settings or a dedicated table
                await supabase.from('client_config').upsert({
                    client_id: clientId,
                    key: 'owner_identity',
                    value: discovery
                });
                return discovery;
            }
        } catch (err) {
            console.error(`[IdentityService] Self-discovery failed: ${err.message}`);
        }
        return null;
    }

    static async updateIdentityCache(clientId, remoteId, resolution) {
        await supabase.from('contact_identities').upsert({
            client_id: clientId,
            remote_id: remoteId,
            canonical_name: resolution.canonicalName,
            confidence: resolution.confidence,
            source_details: { 
                neural_reasoning: resolution.reasoning,
                last_resolved_at: new Date().toISOString()
            }
        }, { onConflict: 'client_id, remote_id' });
    }

    static async getOwner(clientId) {
        const { data } = await supabase
            .from('client_config')
            .select('value')
            .eq('client_id', clientId)
            .eq('key', 'owner_identity')
            .maybeSingle();
        
        return data?.value || null;
    }
}
