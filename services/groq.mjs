import Groq from 'groq-sdk';
import 'dotenv/config';

if (!process.env.GROQ_API_KEY) {
    console.warn('[Groq] Warning: GROQ_API_KEY is missing.');
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
export default groq;
