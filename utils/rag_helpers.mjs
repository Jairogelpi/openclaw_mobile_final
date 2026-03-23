import { normalizeComparableText } from './message_guard.mjs';

export function addDays(date, days) {
    const next = new Date(date);
    next.setDate(date.getDate() + days);
    return next;
}

export function toIso(date, bound) {
    const v = new Date(date);
    if (bound === 'start') v.setHours(0, 0, 0, 0);
    if (bound === 'end') v.setHours(23, 59, 59, 999);
    return v.toISOString();
}

export function parseDialogEntries(content) {
    const lines = String(content || '').split('\n');
    const entries = [];
    for (const line of lines) {
        const match = line.match(/^([^:]{2,32}):\s*(.*)$/);
        if (match) {
            entries.push({ speaker: match[1].trim(), text: match[2].trim() });
        }
    }
    return entries;
}

export function cleanCapturedEntity(entity) {
    if (!entity) return '';
    return entity
        .replace(/\b(el|la|los|las|de|sobre|con)\b/gi, '')
        .replace(/[?¿!¡.]/g, '')
        .trim();
}

export function assignCitationLabels(candidates) {
    return (candidates || []).map((candidate, index) => ({
        ...candidate,
        citation_label: `E${index + 1}`
    }));
}
