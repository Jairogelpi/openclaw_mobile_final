import supabase from '../config/supabase.mjs';
import groq from '../services/groq.mjs';

/**
 * Skill: Brain SQL (Meticulous Retrieval)
 * Permite a la IA realizar consultas analíticas exactas sobre los mensajes.
 */
export default {
    name: 'brain_sql',
    description: 'Use this skill for meticulous counting, date finding, or frequency analysis (e.g., "how many times did I say X", "when was the last time we talked about Y"). It runs a direct SQL query on raw_messages.',
    parameters: {
        type: 'object',
        properties: {
            analysis_intent: {
                type: 'string',
                description: 'What you want to count or find (e.g., "count mentions of bitcoin in march")'
            },
            remoteJid: {
                type: 'string',
                description: 'Optional: Filter by a specific contact JID'
            }
        },
        required: ['analysis_intent']
    },
    async execute(params, context) {
        const { analysis_intent, remoteJid } = params;
        const { clientId } = context;

        if (!clientId) return "[Brain SQL] Error: No clientId provided.";

        try {
            console.log(`📊 [Skill: brain_sql] 🔍 Analizando intención: ${analysis_intent}`);

            // 1. Traducir intención a SQL
            const prompt = `Translate this natural language intent into a PostgreSQL SELECT query for the 'raw_messages' table.
            TABLE: raw_messages (id, client_id, remote_id, sender_role, content, created_at, metadata)
            RULES:
            - ONLY SELECT. Filter by client_id = '${clientId}'.
            ${remoteJid ? `- Filter by remote_id = '${remoteJid}'.` : ''}
            - ILIKE for text. Use count(*) for frequency.
            INTENT: "${analysis_intent}"
            Return ONLY the SQL string.`;

            const sqlGen = await groq.chat.completions.create({
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0
            });

            const sql = sqlGen.choices[0].message.content.trim().replace(/`/g, '').replace(/;/g, '');
            if (!sql.toLowerCase().startsWith('select')) return "[Brain SQL] Error: Query no permitida.";

            console.log(`🚀 [Brain SQL] Query Generada: ${sql}`);

            // 2. Ejecutar via psql directamente
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execPromise = promisify(exec);

            const dbUrl = process.env.DATABASE_URL;
            if (!dbUrl) return "[Brain SQL] Error: DATABASE_URL no configurada.";

            // Wrap query for JSON output
            const wrappedSql = `SELECT json_agg(t) FROM (${sql}) t;`;
            const cmd = `psql "${dbUrl}" -t -c "${wrappedSql}"`;

            const { stdout, stderr } = await execPromise(cmd);

            if (stderr) console.warn(`[Brain SQL] Stderr: ${stderr}`);
            return `[Resultado Analítico SQL]: ${stdout.trim() || 'Sin resultados'}`;

        } catch (e) {
            return `[Brain SQL Error] ${e.message}`;
        }
    }
};
