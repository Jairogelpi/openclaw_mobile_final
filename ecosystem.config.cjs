module.exports = {
    apps: [
        {
            name: "openclaw-gateway",
            script: "./server.mjs",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "production",
            }
        },
        {
            name: "openclaw-brain",
            script: "./brain_worker.mjs",
            instances: 1, // Puedes aumentar esto si quieres escalar la IA (ej: 2, 4, o 'max')
            autorestart: true,
            watch: false,
            max_memory_restart: '4G',
            env: {
                NODE_ENV: "production",
            }
        },
        {
            name: "openclaw-memory",
            script: "./memory_worker.mjs",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "production",
            }
        },
        {
            name: "openclaw-media",
            script: "./media_worker.mjs",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "production",
            }
        }
    ]
};
