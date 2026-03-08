import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const redisConnection = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
});

redisConnection.on('error', (err) => {
    console.error('❌ [BullMQ Redis] Error de conexión:', err.message);
});

// Cola de entrada: WhatsApp empuja mensajes aquí, El Cerebro los lee.
export const incomingQueue = new Queue('incomingMessagesQueue', { connection: redisConnection });

// Cola de salida: El Cerebro empuja respuestas aquí, WhatsApp las lee y las envía.
export const outgoingQueue = new Queue('outgoingMessagesQueue', { connection: redisConnection });

// Cola de Medios: El Oído descarga audio/imágenes, extrae texto y empuja al cerebro.
export const mediaQueue = new Queue('mediaProcessingQueue', { connection: redisConnection });

// Cola Admin: probes del terminal/admin van al brain worker, no al proceso gateway.
export const adminNeuralQueue = new Queue('adminNeuralQueue', { connection: redisConnection });

console.log('📦 [Queues] Colas BullMQ inicializadas (incoming, outgoing, media, admin) sobre Redis.');
