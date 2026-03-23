import 'dotenv/config';
import supabase from '../config/supabase.mjs';
import { findEvidence } from '../services/evidence_rag.service.mjs';
import { LLMProviderService } from '../services/intelligence/llm_provider.service.mjs';
import { buildRawMessageRecord } from '../services/raw_message_ingest.service.mjs';

/**
 * Sanitizes input text for security.
 */
const sanitizeInput = (text, maxLength = 2000) => {
    if (typeof text !== 'string') return '';
    return text.replace(/[<>{}\\^\`]/g, '').substring(0, maxLength).trim();
};

/**
 * Persists assistant responses to the database.
 */
async function persistAssistantReply({ clientId, senderId, channel, content, metadata = {} }) {
    if (!content) return;
    const record = buildRawMessageRecord({
        clientId,
        senderRole: 'assistant',
        content,
        remoteId: senderId,
        processed: true,
        channel: channel || 'whatsapp',
        canonicalSenderName: 'assistant',
        conversationName: metadata?.conversationName || null,
        deliveryStatus: 'sent',
        excludeFromMemory: true,
        generatedBy: 'core_engine',
        metadata
    });
    if (!record.client_id) return;
    await supabase.from('raw_messages').insert([record]);
}

/**
 * Main AI Orchestrator (2026 Neural-Native Edition).
 * Eliminates heuristics in favor of a unified cognitive context.
 */
export async function processMessage(incomingEvent) {
    const { clientId, clientSlug, senderId, channel, text } = incomingEvent;
    
    console.log(`🧠 [NeuralCore] Message from ${clientSlug}: "${String(text).substring(0, 50)}..."`);

    try {
        const safeText = sanitizeInput(text);
        
        // 1. Unified Mathematical Retrieval
        // findEvidence uses CognitiveContextService to build the unified prompt.
        const evidence = await findEvidence(clientId, safeText, { slug: clientSlug });
        
        // 2. Pure Neural Reasoning
        // The LLM reasons directly over the unified cognitive context.
        const messages = [
            { role: 'system', content: (evidence.system_instructions || "") + "\n\n" + (evidence.cognitiveMap?.unified_prompt || "") },
            { role: 'user', content: safeText }
        ];

        const aiResponse = await LLMProviderService.chat(messages, {
            model: 'llama-3.3-70b-versatile',
            temperature: 0.3
        });

        if (!aiResponse) throw new Error("Empty response from LLM");

        // 3. Persistence & Memory
        await persistAssistantReply({
            clientId,
            senderId,
            channel,
            content: aiResponse,
            metadata: {
                rag_mode: 'neural_unified',
                evidence_count: evidence.candidates?.length || 0,
                cognitive_v: '2026.pure_math'
            }
        });

        return aiResponse;

    } catch (error) {
        console.error(`❌ [NeuralCore] Failure:`, error.message);
        return "Mi sistema neuro-cognitivo está operando fuera de parámetros. Reintenta en unos instantes.";
    }
}
