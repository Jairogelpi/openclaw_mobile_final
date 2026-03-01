import axios from 'axios';
import 'dotenv/config';

// OpenRouter client (OpenAI-compatible, used for onboarding with Gemini Flash)
export async function openrouterChat(model, messages, options = {}) {
    const body = {
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 2048,
    };
    if (options.response_format) body.response_format = options.response_format;

    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', body, {
        headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://openclaw.app',
            'X-Title': 'OpenClaw Onboarding',
            'Content-Type': 'application/json'
        }
    });
    return response.data.choices[0].message.content;
}
