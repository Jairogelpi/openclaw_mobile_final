import recallMediaSkill from './skills/recall_media.mjs';

async function testSkill() {
    console.log('Testing recall_media skill explicitly...');
    // Simulated skill params and context
    const params = {
        remoteJid: '34660386701@s.whatsapp.net',
        messageId: '3A48C8F7E8D82A2B3D'
    };
    const context = {
        clientId: 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6', // My test user client ID
        clientSlug: 'jairogelpi-cc2af'
    };

    const result = await recallMediaSkill.execute(params, context);
    console.log('--- SKILL RESULT ---');
    console.log(result);
    process.exit(0);
}

testSkill();
