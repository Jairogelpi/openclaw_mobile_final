import supabase from '../../config/supabase.mjs';
import { LLMProviderService } from './llm_provider.service.mjs';

export class DBAgentService {
    /**
     * Executes analytical intent by generating and running SQL.
     */
    static async executeQuery(clientId, sqlIntent, context = {}) {
        const schema = `
        Table: user_memories
        - id: uuid
        - client_id: uuid
        - content: text (mensaje o recuerdo)
        - sender: text
        - metadata: jsonb (incluye date, remoteId, etc)
        - created_at: timestamptz
        `;

        const systemPrompt = `Eres un experto en SQL para PostgreSQL/Supabase.
Genera una consulta SQL segura para el esquema proveido.
- Solo SELECT.
- Siempre filtra por client_id = '${clientId}'.
- Si piden "cuantas veces", usa COUNT(*).
- Si piden "ultimos", usa ORDER BY created_at DESC.
- Usa ILIKE para búsquedas de texto en "content".

Devuelve SOLO la cadena SQL.`;

        const sql = await LLMProviderService.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Intención: ${sqlIntent}\nContexto: ${JSON.stringify(context)}` }
        ], { model: 'llama-3.1-8b-instant', temperature: 0 });

        console.log(`[DBAgent] Generated SQL: ${sql}`);

        try {
            // WARNING: In a real production system, you'd use a more restricted interface
            // or a whitelist of queries. Here we assume an internal agentic environment.
            const { data, error } = await supabase.rpc('execute_read_only_sql', { sql_query: sql });
            if (error) throw error;
            return data;
        } catch (err) {
            console.error(`[DBAgent] SQL Execution failed: ${err.message}`);
            return null;
        }
    }
}
