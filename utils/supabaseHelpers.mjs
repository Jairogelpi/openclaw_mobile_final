import supabase from '../config/supabase.mjs';

/**
 * Busca en la base de datos el último puerto asignado y devuelve el siguiente.
 * Empezaremos en el 3001 para no chocar con el bridge (3000).
 */
export async function getNextAvailablePort() {
    const { data, error } = await supabase
        .from('user_souls')
        .select('port')
        .order('port', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error('[Port Manager] Error consultando puertos:', error.message);
        return 3001; // Puerto por defecto si hay error
    }

    // Si no hay registros, empezamos en el 3001. Si hay, sumamos 1.
    return data && data.port ? data.port + 1 : 3001;
}
