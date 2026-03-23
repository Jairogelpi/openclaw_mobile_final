import { EventEmitter } from 'events';
import redisClient from '../config/redis.mjs';

/**
 * Global Event Bus - Handles real-time events across the system.
 */
class EventBus extends EventEmitter {
    constructor() {
        super();
        this.prefix = 'openclaw:event:';
    }

    /**
     * Publishes an event locally and optionally globally via Redis.
     */
    async publish(event, data, global = true) {
        this.emit(event, data);
        
        if (global && redisClient) {
            try {
                await redisClient.publish(this.prefix + event, JSON.stringify(data));
            } catch (err) {
                console.warn(`[EventBus] Global publish failed for ${event}:`, err.message);
            }
        }
    }

    /**
     * Subscribes to global events via Redis.
     */
    async subscribeGlobal(event, callback) {
        if (!redisClient) return;
        
        const sub = redisClient.duplicate();
        await sub.connect();
        await sub.subscribe(this.prefix + event, (message) => {
            try {
                callback(JSON.parse(message));
            } catch (e) {
                console.error(`[EventBus] Error processing global event ${event}:`, e.message);
            }
        });
    }
}

export const eventBus = new EventBus();
export default eventBus;
