import 'dotenv/config';
import { repairOwnerIdentity } from '../services/identity.service.mjs';

function getArg(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.find(arg => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

async function main() {
    const clientId = getArg('client') || process.env.CLIENT_ID;
    const preferredName = getArg('preferred-name');

    if (!clientId) {
        throw new Error('Missing client id. Use --client=<uuid> or CLIENT_ID env.');
    }

    const result = await repairOwnerIdentity(clientId, preferredName);
    console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
    console.error('[Owner Identity Repair] Failed:', error.message);
    process.exitCode = 1;
});
