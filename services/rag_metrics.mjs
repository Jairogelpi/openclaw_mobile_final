import supabase from '../config/supabase.mjs';

/**
 * RAG Quality Metrics Service — Observabilidad Total del Pipeline Cognitivo.
 * 
 * Uso:
 *   const trace = startRagTrace(clientId, 'Hola, ¿qué tal?');
 *   trace.logRetrieval({ hybridCount: 5, graphCount: 3, ... });
 *   trace.logAgentic({ iterations: 2, webSearch: false, ... });
 *   trace.logReflection({ attempts: 1, score: 9, ... });
 *   await trace.finish('Respuesta generada por la IA');
 */

export function startRagTrace(clientId, query) {
    const trace = {
        _startTime: Date.now(),
        client_id: clientId,
        query: (query || '').slice(0, 500),

        // Retrieval Metrics
        hybrid_count: 0,
        graph_count: 0,
        unique_candidates: 0,
        avg_similarity: 0,
        avg_resonance: 0,
        confidence_level: 'NONE',
        top_sources: [],  // Array of { content_preview, score, source_type }

        // Agentic Loop Metrics
        agentic_iterations: 0,
        web_search_used: false,
        youtube_skill_used: false,
        agentic_queries: [],  // The optimized queries generated

        // Cache
        cache_hit: false,

        // Reflection Loop Metrics
        reflection_attempts: 0,
        reflection_score: 0,
        conflict_detected: false,
        conflict_details: null,

        // Context Atomization
        context_chars_before: 0,
        context_chars_after: 0,

        // Cost Tracking
        llm_calls_count: 0,

        // Timing breakdown (ms)
        timing: {
            retrieval: 0,
            agentic: 0,
            atomization: 0,
            reflection: 0,
            total: 0
        },

        /** Log retrieval stage results */
        logRetrieval({ hybridMemories, graphKnowledge, uniqueCandidates, top7, confidenceLevel, avgScore, elapsedMs }) {
            this.hybrid_count = hybridMemories?.length || 0;
            this.graph_count = graphKnowledge?.length || 0;
            this.unique_candidates = uniqueCandidates?.length || 0;
            this.confidence_level = confidenceLevel || 'NONE';
            this.avg_similarity = avgScore || 0;
            this.timing.retrieval = elapsedMs || 0;

            // Capturar resonancia promedio de GraphRAG
            if (graphKnowledge?.length > 0) {
                this.avg_resonance = graphKnowledge.reduce((s, g) => s + (g.similarity || 0), 0) / graphKnowledge.length;
            }

            // Guardar preview de los top candidatos para diagnóstico
            if (top7?.length > 0) {
                this.top_sources = top7.map(k => ({
                    preview: (k.content || '').slice(0, 120),
                    score: k.rerank_score || k.similarity || 0,
                    source: k.source || 'UNKNOWN',
                    hop: k.hop || null,
                    remote_id: k.remote_id || null
                }));
            }
        },

        /** Log agentic loop decisions */
        logAgentic({ iterations, webSearch, youtubeSkill, queries, elapsedMs }) {
            this.agentic_iterations = iterations || 0;
            this.web_search_used = webSearch || false;
            this.youtube_skill_used = youtubeSkill || false;
            this.agentic_queries = queries || [];
            this.timing.agentic = elapsedMs || 0;
        },

        /** Log context atomization */
        logAtomization({ charsBefore, charsAfter, elapsedMs }) {
            this.context_chars_before = charsBefore || 0;
            this.context_chars_after = charsAfter || 0;
            this.timing.atomization = elapsedMs || 0;
        },

        /** Log reflection/audit loop */
        logReflection({ attempts, score, conflictDetected, conflictDetails, elapsedMs }) {
            this.reflection_attempts = attempts || 0;
            this.reflection_score = score || 0;
            this.conflict_detected = conflictDetected || false;
            this.conflict_details = conflictDetails || null;
            this.timing.reflection = elapsedMs || 0;
        },

        /** Increment LLM call counter */
        addLLMCall() {
            this.llm_calls_count++;
        },

        /** Mark as cache hit */
        markCacheHit() {
            this.cache_hit = true;
        },

        /** Finalize and persist the trace to Supabase */
        async finish(response) {
            this.timing.total = Date.now() - this._startTime;

            const row = {
                client_id: this.client_id,
                query: this.query,
                hybrid_count: this.hybrid_count,
                graph_count: this.graph_count,
                unique_candidates: this.unique_candidates,
                avg_similarity: parseFloat(this.avg_similarity.toFixed(4)),
                avg_resonance: parseFloat(this.avg_resonance.toFixed(4)),
                confidence_level: this.confidence_level,
                agentic_iterations: this.agentic_iterations,
                web_search_used: this.web_search_used,
                youtube_skill_used: this.youtube_skill_used,
                cache_hit: this.cache_hit,
                reflection_attempts: this.reflection_attempts,
                reflection_score: parseFloat((this.reflection_score || 0).toFixed(1)),
                conflict_detected: this.conflict_detected,
                total_latency_ms: this.timing.total,
                llm_calls_count: this.llm_calls_count,
                metadata: {
                    top_sources: this.top_sources,
                    agentic_queries: this.agentic_queries,
                    conflict_details: this.conflict_details,
                    context_chars_before: this.context_chars_before,
                    context_chars_after: this.context_chars_after,
                    timing_breakdown: this.timing,
                    response_preview: (response || '').slice(0, 200)
                }
            };

            try {
                const { data, error } = await supabase.from('rag_metrics').insert(row).select();
                if (error) {
                    console.warn(`📊 [RAG Metrics] Error persistiendo métricas:`, error.message);
                } else {
                    console.log(`📊 [RAG Metrics] ✅ Trace guardado: ${this.confidence_level} | ${this.hybrid_count}H+${this.graph_count}G | ${this.timing.total}ms | ${this.llm_calls_count} LLM calls`);
                    return data?.[0] || row;
                }
            } catch (e) {
                console.warn(`📊 [RAG Metrics] Error no crítico:`, e.message);
            }

            return row; // Fallback
        }
    };

    return trace;
}

/**
 * Obtener métricas agregadas para el dashboard admin.
 */
export async function getAggregatedMetrics(clientId, days = 7) {
    try {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        let query = supabase
            .from('rag_metrics')
            .select('*')
            .gte('created_at', cutoff)
            .order('created_at', { ascending: false })
            .limit(200);

        if (clientId) {
            query = query.eq('client_id', clientId);
        }

        const { data: metrics, error } = await query;

        if (error || !metrics?.length) {
            return { total_queries: 0, message: 'No hay métricas disponibles.' };
        }

        // Aggregate
        const total = metrics.length;
        const avgLatency = metrics.reduce((s, m) => s + m.total_latency_ms, 0) / total;
        const avgSimilarity = metrics.reduce((s, m) => s + (m.avg_similarity || 0), 0) / total;
        const avgResonance = metrics.reduce((s, m) => s + (m.avg_resonance || 0), 0) / total;
        const avgReflectionScore = metrics.reduce((s, m) => s + (m.reflection_score || 0), 0) / total;
        const avgLLMCalls = metrics.reduce((s, m) => s + m.llm_calls_count, 0) / total;

        const confidenceBreakdown = {
            HIGH: metrics.filter(m => m.confidence_level === 'HIGH').length,
            LOW: metrics.filter(m => m.confidence_level === 'LOW').length,
            NONE: metrics.filter(m => m.confidence_level === 'NONE').length
        };

        const cacheHitRate = metrics.filter(m => m.cache_hit).length / total;
        const webSearchRate = metrics.filter(m => m.web_search_used).length / total;
        const conflictRate = metrics.filter(m => m.conflict_detected).length / total;

        const sourceBreakdown = {
            avg_hybrid: (metrics.reduce((s, m) => s + m.hybrid_count, 0) / total).toFixed(1),
            avg_graph: (metrics.reduce((s, m) => s + m.graph_count, 0) / total).toFixed(1),
            avg_unique: (metrics.reduce((s, m) => s + m.unique_candidates, 0) / total).toFixed(1)
        };

        // Worst queries (lowest confidence + highest latency)
        const worstQueries = metrics
            .filter(m => m.confidence_level === 'NONE' || m.avg_similarity < 0.1)
            .slice(0, 5)
            .map(m => ({
                query: m.query,
                confidence: m.confidence_level,
                latency_ms: m.total_latency_ms,
                candidates: m.unique_candidates
            }));

        return {
            total_queries: total,
            period_days: days,
            avg_latency_ms: Math.round(avgLatency),
            avg_similarity_score: parseFloat(avgSimilarity.toFixed(3)),
            avg_graph_resonance: parseFloat(avgResonance.toFixed(3)),
            avg_reflection_score: parseFloat(avgReflectionScore.toFixed(1)),
            avg_llm_calls_per_query: parseFloat(avgLLMCalls.toFixed(1)),
            confidence_breakdown: confidenceBreakdown,
            confidence_hit_rate: parseFloat(((confidenceBreakdown.HIGH / total) * 100).toFixed(1)),
            cache_hit_rate: parseFloat((cacheHitRate * 100).toFixed(1)),
            web_search_rate: parseFloat((webSearchRate * 100).toFixed(1)),
            conflict_rate: parseFloat((conflictRate * 100).toFixed(1)),
            source_breakdown: sourceBreakdown,
            worst_queries: worstQueries,
            recent_traces: metrics.slice(0, 10).map(m => ({
                query: m.query,
                confidence: m.confidence_level,
                latency_ms: m.total_latency_ms,
                hybrid: m.hybrid_count,
                graph: m.graph_count,
                reflection_score: m.reflection_score,
                cache_hit: m.cache_hit,
                created_at: m.created_at
            }))
        };
    } catch (e) {
        console.error('[RAG Metrics] Error aggregating:', e.message);
        return { total_queries: 0, error: e.message };
    }
}
