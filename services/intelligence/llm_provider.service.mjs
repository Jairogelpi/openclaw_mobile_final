import groq from '../groq.mjs';
import { openRouterChat, hasOpenRouterReasoning } from '../openrouter.mjs';

export class LLMProviderService {
    /**
     * Unified chat interface with automatic routing and fallback.
     */
    static async chat(messages, options = {}) {
        const {
            model = 'llama-3.1-8b-instant',
            temperature = 0,
            json = false,
            timeoutMs = 12000,
            useReasoning = false,
            maxTokens = null
        } = options;

        // 1. Try OpenRouter Reasoning (DeepSeek-R1) if requested and available
        if (useReasoning && hasOpenRouterReasoning()) {
            try {
                return await openRouterChat(messages, {
                    model: 'deepseek/deepseek-r1',
                    temperature,
                    timeoutMs: Math.max(timeoutMs, 20000),
                    responseFormat: json ? { type: 'json_object' } : null
                });
            } catch (err) {
                console.warn(`[LLMProvider] OpenRouter reasoning failed, falling back to Groq: ${err.message}`);
            }
        }

        // 2. Standard Groq Path
        try {
            const completionOptions = {
                model,
                messages,
                temperature,
                response_format: json ? { type: 'json_object' } : null,
                max_tokens: maxTokens || (json ? 4096 : undefined)
            };

            const response = await Promise.race([
                groq.chat.completions.create(completionOptions),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Groq timeout after ${timeoutMs}ms`)), timeoutMs))
            ]);

            return response.choices[0].message.content;
        } catch (err) {
            console.error(`[LLMProvider] Groq call failed: ${err.message}`);
            throw err;
        }
    }

    /**
     * Specialized helper for JSON extraction tasks.
     */
    static async extractJson(systemPrompt, userPrompt, options = {}) {
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const raw = await this.chat(messages, { ...options, json: true });
        return this.parseJson(raw);
    }

    static parseJson(text, fallback = null) {
        try {
            const cleaned = String(text || '').replace(/```json|```/g, '').trim();
            return JSON.parse(cleaned);
        } catch (error) {
            return fallback;
        }
    }
}
