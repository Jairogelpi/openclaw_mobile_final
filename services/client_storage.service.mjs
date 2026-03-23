import path from 'path';

/**
 * Service to manage client-specific storage paths and naming conventions.
 */
export class ClientStorageService {
    static BASE_CLIENTS_DIR = './clients';

    /**
     * Replaces the old getClientSlug helper.
     */
    static getSlug(email, id) {
        if (!email) return `client_${id?.slice(0, 8) || 'unknown'}`;
        const cleanEmail = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        return `${cleanEmail}_${id?.slice(0, 4) || '0000'}`;
    }

    static getClientDir(slug) {
        return path.join(this.BASE_CLIENTS_DIR, slug);
    }

    static getStateDir(slug) {
        return path.join(this.getClientDir(slug), 'state');
    }

    static getAuthDir(slug) {
        return path.join(this.getClientDir(slug), 'baileys_auth_info');
    }

    /**
     * Ensures all basic directories for a client exist.
     */
    static async ensureDirs(slug) {
        const fs = await import('fs/promises');
        await fs.mkdir(this.getStateDir(slug), { recursive: true });
        await fs.mkdir(this.getAuthDir(slug), { recursive: true });
    }
}
