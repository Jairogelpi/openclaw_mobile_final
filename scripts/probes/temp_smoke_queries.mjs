const token = 'Gusano2001@.';
const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';
const remoteId = '34660386701@s.whatsapp.net';

const queries = [
    'Quien es Mireya?',
    'Quien es Mireya y que hice con ella el fin de semana?',
    'Que hice con Mireya el sabado 7 y domingo 8 de marzo de 2026?',
    'Que recuerdas de Mireya?'
];

for (const text of queries) {
    const response = await fetch(`http://127.0.0.1:3001/admin/api/neural_chat?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, text, remoteId })
    });

    const payload = await response.json();
    console.log(JSON.stringify({
        query: text,
        status: response.status,
        reply: payload.reply,
        plan: payload.trace?.metadata?.query_plan || null,
        verdict: payload.trace?.metadata?.answer_verdict || null,
        top_sources: payload.trace?.metadata?.top_sources?.slice(0, 3) || []
    }, null, 2));
    console.log('---');
}

