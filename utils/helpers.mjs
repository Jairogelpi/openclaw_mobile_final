import crypto from 'crypto';

// Helper to generate a readable slug from email (e.g. jairo-gelpi)
export function getClientSlug(email, id) {
    if (!email) return 'anonymous';
    const prefix = email.split('@')[0];
    const baseSlug = prefix.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    // Append a tiny chunk of the user ID (or a random string) to ensure total uniqueness across recreation
    const suffix = id ? id.substring(0, 5) : Math.random().toString(36).substring(2, 7);
    return `${baseSlug}-${suffix}`;
}

// Utility to extract the first valid JSON object from a string using brace matching
export function extractJson(str) {
    const firstBrace = str.indexOf('{');
    if (firstBrace === -1) return null;

    let count = 0;
    let inString = false;
    for (let i = firstBrace; i < str.length; i++) {
        const char = str[i];
        if (char === '"' && str[i - 1] !== '\\') {
            inString = !inString;
        }

        if (!inString) {
            if (char === '{') count++;
            else if (char === '}') count--;

            if (count === 0) {
                return str.substring(firstBrace, i + 1);
            }
        }
    }
    return null;
}
