import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const ecosystemPath = path.join(projectRoot, 'ecosystem.config.cjs');
const require = createRequire(import.meta.url);

if (!existsSync(ecosystemPath)) {
    console.error(`No existe ${ecosystemPath}`);
    process.exit(1);
}

const ecosystem = require(ecosystemPath);
const expectedApps = Array.isArray(ecosystem?.apps) ? ecosystem.apps : [];
const expectedNames = expectedApps.map(app => app.name).filter(Boolean);
const expectedExecPaths = new Map(
    expectedApps
        .filter(app => app?.name && app?.script)
        .map(app => [app.name, path.resolve(projectRoot, app.script)])
);

function runPm2(args, { capture = false } = {}) {
    return execFileSync('pm2', args, {
        cwd: projectRoot,
        encoding: capture ? 'utf8' : undefined,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
}

function readPm2List() {
    const raw = runPm2(['jlist'], { capture: true });
    return JSON.parse(raw || '[]');
}

function describeMismatch(proc) {
    const expectedExecPath = expectedExecPaths.get(proc.name);
    if (!expectedExecPath) {
        return 'fuera de ecosystem.config.cjs';
    }

    const currentExecPath = path.resolve(String(proc?.pm2_env?.pm_exec_path || ''));
    if (currentExecPath !== expectedExecPath) {
        return `script mismatch (${currentExecPath} != ${expectedExecPath})`;
    }

    const currentCwd = path.resolve(String(proc?.pm2_env?.pm_cwd || ''));
    if (currentCwd !== projectRoot) {
        return `cwd mismatch (${currentCwd} != ${projectRoot})`;
    }

    return null;
}

function deleteProcessByName(name) {
    try {
        runPm2(['delete', name]);
    } catch (error) {
        console.warn(`[PM2-Reconcile] No se pudo borrar ${name}: ${error.message}`);
    }
}

async function main() {
    if (expectedNames.length === 0) {
        throw new Error('ecosystem.config.cjs no define apps.');
    }

    const current = readPm2List();
    const openclawProcesses = current.filter(proc => String(proc?.name || '').startsWith('openclaw-'));
    const namesToDelete = new Set(expectedNames);

    for (const proc of openclawProcesses) {
        const mismatch = describeMismatch(proc);
        if (mismatch) {
            console.log(`[PM2-Reconcile] Stale: ${proc.name} -> ${mismatch}`);
        } else {
            console.log(`[PM2-Reconcile] Refresh programado para ${proc.name}.`);
        }

        if (!expectedNames.includes(proc.name)) {
            namesToDelete.add(proc.name);
        }
    }

    for (const name of namesToDelete) {
        deleteProcessByName(name);
    }

    runPm2(['start', ecosystemPath, '--update-env']);
    runPm2(['save']);

    const after = readPm2List();
    for (const expectedName of expectedNames) {
        const proc = after.find(item => item?.name === expectedName);
        if (!proc) {
            throw new Error(`PM2 no recreo ${expectedName}.`);
        }

        const mismatch = describeMismatch(proc);
        if (mismatch) {
            throw new Error(`${expectedName} sigue inconsistente: ${mismatch}`);
        }

        if (proc?.pm2_env?.status !== 'online') {
            throw new Error(`${expectedName} no quedo online (status=${proc?.pm2_env?.status || 'unknown'}).`);
        }

        console.log(`[PM2-Reconcile] OK ${expectedName} -> ${proc.pm2_env.pm_exec_path}`);
    }

    console.log('[PM2-Reconcile] Estado guardado con pm2 save.');
}

main().catch(error => {
    console.error(`[PM2-Reconcile] FAIL: ${error.message}`);
    process.exit(1);
});
