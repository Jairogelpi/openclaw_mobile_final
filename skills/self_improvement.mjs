import supabase from '../config/supabase.mjs';

/**
 * Skill: Self Improvement
 * Permite a la IA actualizar su propio "Core" (Axiomas, Directivas, Estilo)
 * basándose en correcciones explícitas del usuario o nuevos aprendizajes.
 */
export default {
    name: 'self_improvement',
    description: 'Use this skill when the user corrects you, gives you a new rule, or you realize you made a mistake. It updates your core identity (Axioms, Directives) so you dont repeat the error.',
    parameters: {
        type: 'object',
        properties: {
            correction_type: {
                type: 'string',
                enum: ['axiom', 'directive', 'style', 'fact'],
                description: 'Tipo de mejora detectada'
            },
            new_info: {
                type: 'string',
                description: 'La nueva regla o corrección detallada'
            },
            reasoning: {
                type: 'string',
                description: 'Por qué es necesario este cambio'
            }
        },
        required: ['correction_type', 'new_info']
    },
    async execute(params, context) {
        const { correction_type, new_info, reasoning } = params;
        const { clientId } = context;

        if (!clientId) return "[Self Improvement] Error: No clientId provided.";

        try {
            console.log(`🧠 [Skill: self_improvement] 🔄 Actualizando Core (${correction_type}): ${new_info}`);

            // 1. Obtener el Soul actual
            const { data: soulData } = await supabase
                .from('user_souls')
                .select('soul_json')
                .eq('client_id', clientId)
                .single();

            if (!soulData) return "[Self Improvement] Error: Soul not found.";

            const soul = soulData.soul_json || {};

            // 2. Aplicar la corrección según el tipo
            if (correction_type === 'axiom') {
                soul.axiomas_filosoficos = soul.axiomas_filosoficos || [];
                soul.axiomas_filosoficos.push(new_info);
            } else if (correction_type === 'directive') {
                soul.personal_directives = soul.personal_directives || [];
                soul.personal_directives.push(new_info);
            } else if (correction_type === 'style') {
                soul.style_profile = soul.style_profile || {};
                soul.style_profile.last_correction = new_info;
            } else if (correction_type === 'fact') {
                soul.key_facts = soul.key_facts || {};
                soul.key_facts[Date.now()] = new_info;
            }

            // 3. Guardar en Supabase
            const { error } = await supabase
                .from('user_souls')
                .update({ soul_json: soul })
                .eq('client_id', clientId);

            if (error) throw error;

            // 4. GRAPH SYNC: Insertar inmediatamente en Knowledge Nodes para el RAG
            try {
                const { generateEmbedding } = await import('../services/local_ai.mjs');
                const nodeType = correction_type === 'fact' ? 'APRENDIZAJE' : 'DIRECTIVA';
                const nodeName = `Mejora_${correction_type}_${Date.now()}`;
                const nodeDesc = `[NUEVA REGLA APRENDIDA DEL USUARIO]: ${new_info}. Razón: ${reasoning || 'Corrección o actualización explícita'}`;

                const vector = await generateEmbedding(`${nodeName} ${nodeDesc}`);
                await supabase.from('knowledge_nodes').upsert({
                    client_id: clientId,
                    entity_name: nodeName,
                    entity_type: nodeType,
                    description: nodeDesc,
                    embedding: vector
                }, { onConflict: 'client_id, entity_name' });
                console.log(`🧠 [Skill: self_improvement] Graph Sync OK: Nodo ${nodeName} inyectado.`);
            } catch (graphErr) {
                console.warn(`⚠️ [Skill: self_improvement] Graph Sync falló:`, graphErr.message);
            }

            return `[Self Improvement] ✅ Core actualizado y Sincronizado con GraphRAG. He integrado esta corrección: "${new_info}". No volveré a cometer este error.`;

        } catch (e) {
            console.error(`[Self Improvement] Error:`, e.message);
            return `[Self Improvement] ❌ Error actualizando el Core: ${e.message}`;
        }
    }
};
