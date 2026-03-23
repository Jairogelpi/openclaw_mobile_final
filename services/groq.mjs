import Groq from 'groq-sdk';
import 'dotenv/config';

if (!process.env.GROQ_API_KEY) {
    console.warn('[Groq] Warning: GROQ_API_KEY is missing.');
}

const rawGroq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function retryWithBackoff(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e) {
            if (e.status === 429 || e.status >= 500) {
                console.warn(`[Groq] API Error ${e.status}. Retrying in ${Math.pow(2, i)}s...`);
                await sleep(Math.pow(2, i) * 1000);
            } else {
                throw e; // Bad request, etc
            }
        }
    }
    throw new Error('Groq API failed after max retries.');
}

const groq = {
    chat: {
        completions: {
            create: async (args) => {
                return retryWithBackoff(() => rawGroq.chat.completions.create(args));
            }
        }
    },
    audio: {
        transcriptions: {
            create: async (args) => {
                return retryWithBackoff(() => rawGroq.audio.transcriptions.create(args));
            }
        }
    }
};

export default groq;
