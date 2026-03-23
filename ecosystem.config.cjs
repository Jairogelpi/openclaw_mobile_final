module.exports = {
    apps: [
        {
            name: "openclaw-gateway",
            script: "./server.mjs",
            instances: 1,
            autorestart: true,
            watch: false,
            restart_delay: 5000,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "production",
                OPENCLAW_GATEWAY_MEMORY_WARN_MB: "650",
                OPENCLAW_GATEWAY_MEMORY_HARD_MB: "900",
                OPENCLAW_GATEWAY_MEMORY_CHECK_MS: "60000",
            }
        },
        {
            name: "openclaw-brain",
            script: "./workers/brain_worker.mjs",
            instances: 1, // Puedes aumentar esto si quieres escalar la IA (ej: 2, 4, o 'max')
            autorestart: true,
            watch: false,
            restart_delay: 5000,
            max_memory_restart: '1800M',
            env: {
                NODE_ENV: "production",
                OPENCLAW_EMBEDDER_KEEP_WARM: "true",
                OPENCLAW_EMBEDDER_TTL_MS: "3600000",
                OPENCLAW_BRAIN_ADMIN_PORT: "3001",
                OPENCLAW_BRAIN_MEMORY_WARN_MB: "1100",
                OPENCLAW_BRAIN_MEMORY_HARD_MB: "1450",
                OPENCLAW_BRAIN_MEMORY_CHECK_MS: "60000",
            }
        },
        {
            name: "openclaw-memory",
            script: "./workers/memory_worker.mjs",
            instances: 1,
            autorestart: true,
            watch: false,
            restart_delay: 5000,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "production",
                OPENCLAW_EMBEDDER_KEEP_WARM: "true",
                OPENCLAW_EMBEDDER_TTL_MS: "3600000",
            }
        },
        {
            name: "openclaw-media",
            script: "./workers/media_worker.mjs",
            instances: 1,
            autorestart: true,
            watch: false,
            restart_delay: 5000,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "production",
            }
        }
    ]
};
