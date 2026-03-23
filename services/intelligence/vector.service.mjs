import { generateEmbedding } from '../local_ai.mjs';
import supabase from '../../config/supabase.mjs';
import { dominantExternalSpeaker } from '../../utils/message_guard.mjs';

export class VectorService {
    /**
     * Generates an embedding and saves a "Holographic Memory" chunk.
     */
    static async saveHolographicMemory(clientId, data) {
        const { 
            text, 
            remoteId, 
            contactName, 
            chunkIndex, 
            startIndex, 
            endIndex, 
            chunkStartAt, 
            chunkEndAt, 
            messageIds,
            userName 
        } = data;

        const header = `[Fragmento Conversacional(Holograma)][Contacto: ${contactName}][ID: ${remoteId}][Fecha: ${chunkStartAt || '?'}]\n`;
        const enrichedText = header + text;
        const embedding = await generateEmbedding(enrichedText);

        const { error } = await supabase.from('user_memories').insert({
            client_id: clientId,
            content: enrichedText,
            sender: dominantExternalSpeaker(data.rawMessages, userName, contactName),
            embedding: embedding,
            metadata: {
                remoteId,
                contactName,
                holographic: true,
                chunkIndex,
                chunkStartIndex: startIndex,
                chunkEndIndex: endIndex,
                chunkMessageCount: data.rawMessages.length,
                chunkStartAt,
                chunkEndAt,
                rawMessageIds: messageIds,
                speakers: data.speakers
            }
        });

        if (error) throw error;
        return { success: true };
    }
}
