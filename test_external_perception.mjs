import 'dotenv/config';
import groq from './services/groq.mjs';

async function testExternalPerception() {
    console.log('🧪 [Test] Simulando extracción de Percepción Externa (Lo que otros dicen de ti)...');

    const conversationSnippet = [
        "Contacto (Jefe): Oye, me gusta que siempre eres muy puntual con los reportes.",
        "Usuario: Gracias, trato de mantener el orden.",
        "Contacto (Jefe): Se nota. Además, tu estilo de redacción es muy técnico, eso nos ayuda mucho."
    ].join('\n');

    try {
        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            response_format: { type: 'json_object' },
            messages: [{
                role: 'system',
                content: `Eres un extractor de GraphRAG. 
Extrae hechos sobre el "Usuario" basándote en lo que dice el "Contacto".
REGLA: Si el hecho es sobre el dueño de la cuenta, el sujeto DEBE ser "Usuario".

Responde JSON: { "triplets": [{ "source": "Usuario", "relation": "...", "target": "...", "context": "..." }] }`
            }, {
                role: 'user',
                content: conversationSnippet
            }]
        });

        const result = JSON.parse(response.choices[0].message.content);
        console.log('\n🔍 [Resultado de Extracción]:');
        console.dir(result, { depth: null });

        const isSuccess = result.triplets.some(t => t.source === 'Usuario');
        if (isSuccess) {
            console.log('\n✅ ÉXITO: El sistema ha identificado hechos sobre TI a partir de lo que dijo el contacto.');
        } else {
            console.log('\n❌ FALLO: No se detectaron hechos sobre el usuario.');
        }

    } catch (e) {
        console.error('❌ Error en el test:', e.message);
    }
}

testExternalPerception();
