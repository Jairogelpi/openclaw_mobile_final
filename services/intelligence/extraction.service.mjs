import { LLMProviderService } from './llm_provider.service.mjs';
import { upsertKnowledgeNode, upsertKnowledgeEdge } from '../graph.service.mjs';
import { validateGroundedGraph } from '../../utils/knowledge_guard.mjs';

export class ExtractionService {
    /**
     * Extracts a grounded graph from a conversation chunk.
     */
    static async extractGroundedGraph(clientId, remoteId, userName, contactName, lines, options = {}) {
        const chunkText = (lines || []).join('\n');
        if (!chunkText) return;

        // Level 6: Model Tiering for Speed & Cost
        const isComplex = chunkText.length > 800 || (lines || []).length > 10;
        const model = isComplex ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';

        const prompt = this.buildGroundedExtractionPrompt(userName, contactName, remoteId, options);
        const responseText = await LLMProviderService.chat([
            { role: 'system', content: prompt },
            { role: 'user', content: chunkText }
        ], {
            model,
            json: true,
            temperature: 0.1
        });

        const extractedGraph = LLMProviderService.parseJson(responseText);
        if (!extractedGraph) return null;

        const groundedGraph = validateGroundedGraph({
            entities: extractedGraph.entities,
            relationships: extractedGraph.relationships,
            chunkText,
            ownerName: userName,
            contactName,
            remoteId,
            isGroup: options.isGroup,
            speakers: options.speakers
        });

        return this.saveGraph(clientId, remoteId, groundedGraph, options);
    }

    /**
     * Extracts Soul updates (Self-reported facts).
     */
    static async extractSoulDelta(ownerName, messages, currentSoul = {}) {
        const conversationText = messages.map(m => m.content).join('\n');
        const soulSnapshot = JSON.stringify(currentSoul).slice(0, 3500);

        const responseText = await LLMProviderService.chat([{
            role: 'system',
            content: `Eres un analista de Identidad Digital. Tu objetivo es actualizar el "Soul JSON" del usuario basándote ÚNICAMENTE en hechos explícitos auto-reportados por "${ownerName}" en los nuevos mensajes.
            
REGLAS:
1. Solo extrae información que "${ownerName}" haya dicho sobre sí mismo (gustos, planes, identidad, datos personales).
2. Ignora lo que digan otros.
3. Devuelve únicamente un objeto JSON con los campos que han CAMBIADO o son NUEVOS.
4. Si no hay cambios claros, devuelve un objeto vacío {}.
5. Mantén un tono analítico y preciso.

SOUL ACTUAL (Snapshot):
${soulSnapshot}

NUEVOS MENSAJES DE "${ownerName}":
${conversationText}`
        }], {
            model: 'llama-3.1-8b-instant',
            json: true,
            maxTokens: 2048,
            temperature: 0.1
        });

        return LLMProviderService.parseJson(responseText);
    }

    static async saveGraph(clientId, remoteId, graph, options) {
        let entityCount = 0;
        let relationshipCount = 0;

        for (const entity of graph.entities) {
            await upsertKnowledgeNode(clientId, entity.name, entity.type || 'ENTITY', entity.desc || '', {
                source: 'grounded_extraction',
                remoteId,
                metadata: {
                    evidence: entity.evidence || null,
                    is_group_chat: Boolean(options.isGroup)
                }
            });
            entityCount++;
        }

        for (const rel of graph.relationships) {
            await upsertKnowledgeEdge(clientId, rel.source, rel.target, rel.type, rel.weight, rel.context, ['grounded', 'direct'], {
                source: 'grounded_extraction',
                metadata: {
                    remoteId,
                    evidence: rel.evidence || null,
                    sentiment: rel.sentiment || 0,
                    is_group_chat: Boolean(options.isGroup)
                }
            });
            relationshipCount++;
        }

        return { entities: entityCount, relations: relationshipCount };
    }

    static buildGroundedExtractionPrompt(userName, contactName, remoteId, { isGroup = false, speakers = [] } = {}) {
        const scope = isGroup
            ? `Chat grupal "${contactName}" con participantes: ${speakers.join(', ') || userName}.`
            : `Chat privado entre "${userName}" y "${contactName}".`;

        return `Eres un analista de Inteligencia Relacional y Cognitiva Profunda (Nivel 5 - HyperExtraction).
Tu objetivo es mapear no solo los hechos, sino la ARQUITECTURA PSICOLÓGICA y el SUBTEXTO de la conversación.

CONTEXTO:
- Ámbito: ${scope}
- Titular: "${userName}"
- Contacto: "${contactName}"

INSTRUCCIONES DE EXTRACCIÓN (JSON):
1. **Detección de Entidades**:
   - PERSONA|ORGANIZACION|CONCEPTO|EVENTO|LUGAR: Nodos estándar.
   - RASGO_PERSONALIDAD: Extrae atributos latentes (ej: "Perfeccionista", "Ansioso", "Leal").
   - VALOR_CENTRAL: Ideas motoras (ej: "Libertad", "Justicia", "Crecimiento").
   - IMPORTANTE: Para rasgos y valores, la descripción DEBE explicar el porqué basándose en el comportamiento en el chat.

2. **Mapeo de Relaciones**:
   - Usa los tipos estándar ([FAMILIA_DE], [PAREJA_DE], [TRABAJA_EN], etc.).
   - [SIENTE]: Para estados emocionales hacia sujetos u objetos (ej: Jairo -> [SIENTE] -> "Agobio").
   - [PLANEA]: Para intenciones futuras.
   - METADATA DE RELACIÓN: Incluye "sentiment" (-1.0 a 1.0) y "context" con matices cualitativos.

3. **Capa Transversal (Cross-Modal)**:
   - Si el texto menciona archivos multimedia analizados (ej: "[Imagen Analizada: ...]"), vincula los objetos/personas de la descripción a nodos del grafo.

FORMATO DE SALIDA:
{
  "entities": [{ 
    "name": "Nombre normalizado",
    "type": "PERSONA|ORGANIZACION|CONCEPTO|EVENTO|LUGAR|RASGO_PERSONALIDAD|VALOR_CENTRAL",
    "desc": "Descripción densa y analítica",
    "evidence": "Cita textual exacta"
  }],
  "relationships": [{
    "source": "Sujeto",
    "target": "Objeto o Sentimiento",
    "type": "CONECTA_CON|FAMILIA_DE|TRABAJA_EN|OPINA_QUE|CONTEXTO_DE|USA|SIENTE|PLANEA",
    "weight": 1.0,
    "sentiment": 0.0,
    "context": "Matiz cualitativo profundo",
    "evidence": "Cita textual"
  }]
}

REGLAS DE ORO:
- No extraigas "ruido". Cada nodo debe aportar valor al mapa cognitivo del Titular.
- La "desc" de una persona debe evolucionar con sus acciones: "X parece estar bajo mucha presión laboral según [cita]".
- Normaliza nombres. Si alguien dice "mi madre", mapea "Madre de [Nombre]".`;
    }
}
