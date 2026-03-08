import supabase from '../config/supabase.mjs';

/**
 * Dynamic Config Service — Lee umbrales y parámetros desde Supabase
 * en lugar de tenerlos hardcodeados en el código.
 * 
 * Usa un caché en memoria de 60 segundos para no hacer una query
 * por cada mensaje. Así es instantáneo pero se actualiza solo.
 */

let configCache = {};
let lastFetchTime = 0;
const CACHE_TTL_MS = 60_000; // Refresca config cada 60 segundos

// Defaults: Si la tabla no existe o no tiene la key, usamos estos valores
const DEFAULTS = {
    'rag_confidence_threshold': 0.9,
    'rag_mode': 'evidence_first',
    'rag_max_candidates': 24,
    'rag_max_query_variants': 4,
    'rag_query_expansion_enabled': true,
    'rag_semantic_rerank_enabled': true,
    'rag_semantic_rerank_max_candidates': 8,
    'rag_reranker_enabled': true,
    'rag_claim_verifier_enabled': true,
    'rag_allow_graph_hop_answers': false,
    'rag_auto_soul_update_enabled': false,
    'max_investigation_hops': 4,
    'reflection_min_chars': 50,
    'reflection_enabled': true,
    'semantic_cache_enabled': true,
    'noise_filter_min_words': 15,
    'dream_cycle_concurrency': 1,
    'community_detection_enabled': true,
    'entity_disambiguation_enabled': true,
    'anti_hallucination_gate': true,
};

/**
 * Carga TODA la config desde Supabase y la cachea en memoria.
 */
async function refreshConfigCache() {
    try {
        const { data, error } = await supabase
            .from('system_config')
            .select('key, value');

        if (error) {
            console.warn('[Config Service] Error cargando config:', error.message);
            return;
        }

        if (data) {
            for (const row of data) {
                // Intentar parsear como número o booleano
                let val = row.value;
                if (val === 'true') val = true;
                else if (val === 'false') val = false;
                else if (!isNaN(val) && val !== '') val = parseFloat(val);
                configCache[row.key] = val;
            }
        }

        lastFetchTime = Date.now();
        console.log(`⚙️ [Config Service] Config recargada: ${Object.keys(configCache).length} keys.`);
    } catch (e) {
        console.warn('[Config Service] Error no crítico al cargar config:', e.message);
    }
}

export async function preloadConfigCache({ force = false } = {}) {
    if (!force && Date.now() - lastFetchTime <= CACHE_TTL_MS && Object.keys(configCache).length) {
        return { ...DEFAULTS, ...configCache };
    }
    await refreshConfigCache();
    return { ...DEFAULTS, ...configCache };
}

/**
 * Obtiene un valor de configuración. Si el caché ha caducado (60s), lo recarga.
 * Si la key no existe, devuelve el default hardcodeado.
 * 
 * @param {string} key - Nombre del parámetro (ej. 'rag_confidence_threshold')
 * @returns {any} El valor de configuración
 */
export async function getConfig(key) {
    // Si el caché tiene más de 60s, refrescar
    if (Date.now() - lastFetchTime > CACHE_TTL_MS) {
        await refreshConfigCache();
    }

    // Si la key existe en caché, devolver. Sino, devolver default.
    if (key in configCache) return configCache[key];
    return DEFAULTS[key] !== undefined ? DEFAULTS[key] : null;
}

/**
 * Obtiene TODAS las configuraciones actuales (para el dashboard).
 */
export async function getAllConfig() {
    if (Date.now() - lastFetchTime > CACHE_TTL_MS) {
        await refreshConfigCache();
    }
    return { ...DEFAULTS, ...configCache };
}

/**
 * Actualiza un valor de configuración en Supabase (upsert).
 */
export async function setConfig(key, value) {
    const { error } = await supabase
        .from('system_config')
        .upsert({ key, value: String(value) }, { onConflict: 'key' });

    if (error) {
        console.error('[Config Service] Error guardando config:', error.message);
        throw error;
    }

    // Actualizar caché local inmediatamente
    configCache[key] = value;
    console.log(`⚙️ [Config Service] Config actualizada: ${key} = ${value}`);
}
