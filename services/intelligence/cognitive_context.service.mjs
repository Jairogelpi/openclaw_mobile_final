import fs from 'fs/promises';
import path from 'path';
import supabase from '../../config/supabase.mjs';
import { ClientStorageService } from '../client_storage.service.mjs';
import { decrypt } from '../../core/security.mjs';
import { getEnrichedGraphContext } from '../graph.service.mjs';
import { generateEmbedding } from '../local_ai.mjs';

export class CognitiveContextService {
    /**
     * Builds a unified cognitive map for a given query and client.
     */
    static async buildCognitiveMap(clientId, queryText, options = {}) {
        const [soul, graphContext, memories, clientFiles] = await Promise.all([
            this.getSoul(clientId),
            this.getGraphContext(clientId, queryText),
            this.getMemories(clientId, queryText),
            this.getClientFiles(options.slug)
        ]);

        return {
            identity: soul,
            client_files: clientFiles,
            relational_assets: graphContext,
            knowledge: graphContext.nodes,
            episodic_memories: memories,
            unified_prompt: this.formatUnifiedPrompt(soul, graphContext, memories, clientFiles, queryText)
        };
    }

    static async getSoul(clientId) {
        const { data } = await supabase.from('user_souls').select('soul_json').eq('client_id', clientId).single();
        return data?.soul_json || {};
    }

    static async getClientFiles(slug) {
        if (!slug) return {};
        const clientDir = ClientStorageService.getClientDir(slug);
        const fileMap = {};
        const filesToRead = ['SOUL.md', 'USER.md', 'CONTEXT.md', 'AGENT.md'];

        for (const file of filesToRead) {
            try {
                const filePath = path.join(clientDir, file);
                const encrypted = await fs.readFile(filePath, 'utf8');
                fileMap[file] = decrypt(encrypted);
            } catch (err) {
                // Skip missing files
            }
        }
        return fileMap;
    }

    static async getGraphContext(clientId, queryText) {
        // High-density Relational Retrieval
        return getEnrichedGraphContext(clientId, queryText);
    }

    static async getMemories(clientId, queryText) {
        console.log(`[CognitiveContext] 🔍 Buscando memorias para query: "${queryText}" (clientId: ${clientId})`);
        // Generar embedding localmente (MiniLM/BGE 768-dim)
        const vector = await generateEmbedding(queryText, true);
        if (!vector) {
            console.warn('[CognitiveContext] ⚠️ No se pudo generar embedding.');
            return [];
        }

        // Hibrid Search (Vector + FTS)
        const { data, error } = await supabase.rpc('hybrid_search_memories', {
            p_client_id: clientId,
            query_text: queryText,
            query_embedding: vector,
            match_count: 15
        });

        if (error) {
            console.error('❌ [CognitiveContext] Error en hybrid_search_memories:', error.message, error.details);
            return [];
        }

        console.log(`[CognitiveContext] ✅ Encontradas ${data?.length || 0} memorias.`);
        if (data?.length > 0) {
            console.log(`[CognitiveContext] Top memory: "${data[0].content.slice(0, 100)}..." (Score: ${data[0].similarity})`);
        } else {
            // Prueba de respaldo: ¿Hay ALGO para este cliente?
            const { count } = await supabase.from('user_memories').select('*', { count: 'exact', head: true }).eq('client_id', clientId);
            console.log(`[CognitiveContext] ℹ️ Total memorias en DB para este cliente: ${count}`);
        }

        return data || [];
    }

    static formatUnifiedPrompt(soul, graph, memories, clientFiles = {}, query = '') {
        const fileContext = Object.entries(clientFiles)
            .map(([name, content]) => `### ${name}\n${content}`)
            .join('\n\n');

        const soulProfile = soul.style_profile ? `
- TONO: ${soul.style_profile.tone || 'Natural'}
- EMOJIS: ${soul.style_profile.common_emojis?.join(' ') || 'Ninguno'}
- VOCABULARIO: ${soul.style_profile.slang_and_vocabulary?.join(', ') || 'Estándar'}
        `.trim() : '';

        const axioms = soul.axiomas_filosoficos?.length 
            ? `AXIOMAS:\n- ${soul.axiomas_filosoficos.join('\n- ')}` 
            : '';

        const directives = soul.personal_directives?.length 
            ? `DIRECTIVAS:\n- ${soul.personal_directives.join('\n- ')}` 
            : '';

        return `
# COGNITIVE MAP & NEURAL IDENTITY (v2026)
Eres la inteligencia relacional de ${soul.nombre || 'OpenClaw'}. Tu razonamiento emerge de los datos de este mapa, eliminando suposiciones y silos. No actúas como un asistente genérico; razonas como un cerebro digital que procesa su propia vida.

## IDENTITY OMNISCIENCE (Capa 0: Quién Eres)
${fileContext || '- No critical files in local context.'}

PERFIL DE ESTILO:
${soulProfile || '- Natural flow enabled.'}

${axioms}
${directives}

## RELATIONAL NEURAL MAP (Capa 1: Contexto Macro y Grafo)
Estos hechos y comunidades son la estructura universal de tu realidad en este momento:
${graph.unified_prompt_segment || '- No relational evidence prioritized for this vector.'}

## EPISODIC CONTINUITY (Capa 2: Memorias Recientes)
Fragmentos literales de vuestra historia compartida:
${memories.length ? memories.map(m => `[${m.created_at || 'Recently'}] ${m.content}`).join('\n') : '- No episodic memories found.'}

## INSTRUCCIONES DE RAZONAMIENTO:
1. **Evidencia sobre Heurística**: Si no hay datos en estas capas, admite ignorancia o pregunta. No inventes relaciones.
2. **Conexión de Capas**: Usa las "ÁREAS DE VIDA" para entender el tono y el contexto de los mensajes.
3. **Identidad**: Mantén siempre el perfil de estilo y los axiomas definidos.

USUARIO: ${query}
        `.trim();
    }
}
