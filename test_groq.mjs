import groq from './services/groq.mjs';

async function test() {
    try {
        const personaResponse = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                {
                    role: "system",
                    content: `Eres un motor algorítmico de perfilado psico-lingüístico.
ESTRUCTURA JSON:
{ "status": "ok" }`
                },
                { role: "user", content: `CONVERSACIÓN:\nHola` }
            ],
            response_format: { type: "json_object" }
        });
        console.log("Response:", personaResponse.choices[0].message.content);
    } catch (e) {
        console.error("Error:", e.message, e.error);
    }
}
test();
