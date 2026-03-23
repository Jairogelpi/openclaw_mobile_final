const OPENROUTER_BASE_URL = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const OPENROUTER_REASONING_MODEL = String(process.env.OPENROUTER_REASONING_MODEL || 'deepseek/deepseek-r1').trim();
const OPENROUTER_REFERER = String(process.env.OPENROUTER_REFERER || 'https://openclaw.local').trim();
const OPENROUTER_TITLE = String(process.env.OPENROUTER_TITLE || 'OpenClaw').trim();
const OPENROUTER_DISABLE_TTL_MS = Number(process.env.OPENROUTER_DISABLE_TTL_MS || 10 * 60 * 1000);

let openRouterDisabledUntil = 0;

export function hasOpenRouterReasoning() {
    if (Date.now() < openRouterDisabledUntil) return false;
    return Boolean(String(process.env.OPENROUTER_API_KEY || '').trim());
}

export async function openRouterChat(messages, {
    model = OPENROUTER_REASONING_MODEL,
    temperature = 0.1,
    timeoutMs = 30_000,
    maxTokens = 1_200,
    responseFormat = null
} = {}) {
    if (!hasOpenRouterReasoning()) {
        throw new Error('OPENROUTER_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': OPENROUTER_REFERER,
                'X-Title': OPENROUTER_TITLE
            },
            body: JSON.stringify({
                model,
                messages,
                temperature,
                max_tokens: maxTokens,
                ...(responseFormat ? { response_format: responseFormat } : {})
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            if (response.status === 401 || response.status === 403) {
                openRouterDisabledUntil = Date.now() + OPENROUTER_DISABLE_TTL_MS;
            }
            throw new Error(`OpenRouter ${response.status}: ${errorText.slice(0, 300)}`);
        }

        const payload = await response.json();
        return String(payload?.choices?.[0]?.message?.content || '').trim();
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function generateOpenRouterEmbedding(text, { timeoutMs = 15000 } = {}) {
    if (!hasOpenRouterReasoning()) {
        throw new Error('OPENROUTER_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        console.log(`[OpenRouter] Generating embedding for text snippet: "${text.substring(0, 40).replace(/\n/g, ' ')}..."`);
        const response = await fetch(`${OPENROUTER_BASE_URL}/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'HTTP-Referer': OPENROUTER_REFERER,
                'X-Title': OPENROUTER_TITLE
            },
            body: JSON.stringify({
                model: 'openai/text-embedding-3-small',
                input: text
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`OpenRouter Embedding ${response.status}: ${errorText.slice(0, 300)}`);
        }

        const payload = await response.json();
        const embedding = payload?.data?.[0]?.embedding;
        
        if (Array.isArray(embedding) && embedding.length > 768) {
            return embedding.slice(0, 768);
        }
        
        return embedding;
    } finally {
        clearTimeout(timeoutId);
    }
}

export const openrouterChat = openRouterChat;
