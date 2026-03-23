import process from 'node:process';

function toMb(value = 0) {
    return Number((Number(value || 0) / 1024 / 1024).toFixed(1));
}

export function getProcessMemorySnapshot() {
    const memory = process.memoryUsage();
    return {
        rss_mb: toMb(memory.rss),
        heap_used_mb: toMb(memory.heapUsed),
        heap_total_mb: toMb(memory.heapTotal),
        external_mb: toMb(memory.external),
        uptime_seconds: Math.round(process.uptime())
    };
}

export function formatProcessMemorySnapshot(snapshot = getProcessMemorySnapshot()) {
    return `rss=${snapshot.rss_mb}MB heap=${snapshot.heap_used_mb}/${snapshot.heap_total_mb}MB external=${snapshot.external_mb}MB uptime=${snapshot.uptime_seconds}s`;
}

export function startProcessMemoryGuard({
    label = 'Runtime',
    warnRssMb = 1024,
    hardRssMb = 1536,
    intervalMs = 60_000,
    onWarn = null,
    onHard = null
} = {}) {
    const warnThreshold = Number(warnRssMb || 0);
    const hardThreshold = Number(hardRssMb || 0);
    const cadence = Math.max(15_000, Number(intervalMs || 60_000));

    let lastLevel = 'normal';
    let lastLogAt = 0;

    const tick = async () => {
        const snapshot = getProcessMemorySnapshot();
        const now = Date.now();

        if (hardThreshold > 0 && snapshot.rss_mb >= hardThreshold) {
            if (lastLevel !== 'hard' || (now - lastLogAt) >= cadence) {
                console.warn(`[${label}] RSS alto: ${formatProcessMemorySnapshot(snapshot)} (hard=${hardThreshold}MB)`);
                lastLogAt = now;
            }
            lastLevel = 'hard';
            if (typeof onHard === 'function') {
                await onHard(snapshot);
            }
            return;
        }

        if (warnThreshold > 0 && snapshot.rss_mb >= warnThreshold) {
            if (lastLevel !== 'warn' || (now - lastLogAt) >= cadence) {
                console.warn(`[${label}] RSS elevado: ${formatProcessMemorySnapshot(snapshot)} (warn=${warnThreshold}MB)`);
                lastLogAt = now;
            }
            lastLevel = 'warn';
            if (typeof onWarn === 'function') {
                await onWarn(snapshot);
            }
            return;
        }

        lastLevel = 'normal';
    };

    const interval = setInterval(() => {
        Promise.resolve()
            .then(tick)
            .catch(error => {
                console.warn(`[${label}] Memory guard tick failed: ${error.message}`);
            });
    }, cadence);

    if (typeof interval.unref === 'function') {
        interval.unref();
    }

    Promise.resolve()
        .then(tick)
        .catch(error => {
            console.warn(`[${label}] Memory guard bootstrap failed: ${error.message}`);
        });

    return () => clearInterval(interval);
}
