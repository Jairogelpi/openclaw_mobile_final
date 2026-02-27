import { createClient as createRedisClient } from 'redis';

let redisClient;
try {
    redisClient = createRedisClient();
    redisClient.on('error', (err) => console.warn('[Redis] Connection error:', err.message));
    // El await de la conexión inicial no se puede hacer en el root level de forma confiable sin top-level await que pueda retrasar todo
    // Por simplicidad en commonjs / esm mixto, invocamos el connect, pero devolvemos la promesa.
    await redisClient.connect();
    console.log('[Redis] ✅ Conectado para temporizadores de memoria.');
} catch (e) {
    console.warn('[Redis] ⚠️ No disponible. Temporizadores de memoria desactivados.');
    redisClient = null;
}

export default redisClient;
