import supabase from '../config/supabase.mjs';

function sanitizeString(value) {
    const raw = String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
    const safe = Array.from(raw)
        .filter(char => {
            const code = char.codePointAt(0);
            return !(code >= 0xD800 && code <= 0xDFFF);
        })
        .join('');
    return safe.trim();
}

function sanitizeJsonKey(key) {
    const cleaned = sanitizeString(key).replace(/[^\w.-]/g, '_').slice(0, 80);
    return cleaned || 'unknown_key';
}

function sanitizeJsonValue(value, depth = 0) {
    if (depth > 6) return null;
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return sanitizeString(value);
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value
            .map(item => sanitizeJsonValue(item, depth + 1))
            .filter(item => item !== undefined);
    }
    if (typeof value === 'object') {
        const next = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            const sanitized = sanitizeJsonValue(nestedValue, depth + 1);
            if (sanitized !== undefined) next[sanitizeJsonKey(key)] = sanitized;
        }
        return next;
    }
    return sanitizeString(value);
}

function toTransportSafeJson(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (error) {
        return JSON.parse(JSON.stringify(sanitizeJsonValue(value)));
    }
}

async function tryDiagnosticInsert(row) {
    const { data, error } = await supabase
        .from('rag_metrics')
        .insert([row])
        .select('id')
        .limit(1);

    if (error) return { ok: false, error: error.message };

    const insertedId = data?.[0]?.id || null;
    if (insertedId) {
        await supabase.from('rag_metrics').delete().eq('id', insertedId);
    }

    return { ok: true };
}

async function diagnoseInvalidJsonRow(row) {
    try {
        const baseProbe = await tryDiagnosticInsert({
            ...row,
            metadata: null
        });

        if (!baseProbe.ok) {
            console.warn(`[RAG Metrics] Diagnóstico: el payload falla incluso sin metadata (${baseProbe.error}).`);
            return;
        }

        const metadata = row.metadata || {};
        const failingKeys = [];

        for (const [key, value] of Object.entries(metadata)) {
            const probe = await tryDiagnosticInsert({
                ...row,
                metadata: { [key]: value }
            });

            if (!probe.ok) {
                failingKeys.push(`metadata.${key} (${probe.error})`);
            }
        }

        if (failingKeys.length) {
            console.warn(`[RAG Metrics] Diagnóstico: campos conflictivos detectados -> ${failingKeys.join(', ')}`);
            return;
        }

        console.warn('[RAG Metrics] Diagnóstico: ningún campo individual falla; el problema parece estar en una combinación de metadata.');
    } catch (error) {
        console.warn('[RAG Metrics] Diagnóstico no crítico:', error.message);
    }
}

export function startRagTrace(clientId, query) {
    const trace = {
        _startTime: Date.now(),
        client_id: clientId,
        query: sanitizeString(query).slice(0, 500),
        mode: 'legacy',

        hybrid_count: 0,
        graph_count: 0,
        unique_candidates: 0,
        avg_similarity: 0,
        avg_resonance: 0,
        confidence_level: 'NONE',
        top_sources: [],

        agentic_iterations: 0,
        web_search_used: false,
        youtube_skill_used: false,
        agentic_queries: [],

        cache_hit: false,

        query_plan: null,
        candidate_summary: null,
        citation_coverage: 0,
        answer_verdict: null,
        supported_claims: [],
        query_style: null,
        retrieval_profile: {},

        reflection_attempts: 0,
        reflection_score: 0,
        conflict_detected: false,
        conflict_details: null,

        context_chars_before: 0,
        context_chars_after: 0,
        llm_calls_count: 0,

        timing: {
            retrieval: 0,
            agentic: 0,
            atomization: 0,
            reflection: 0,
            total: 0
        },

        logRetrieval({ hybridMemories, graphKnowledge, uniqueCandidates, top7, confidenceLevel, avgScore, elapsedMs }) {
            this.hybrid_count = hybridMemories?.length || 0;
            this.graph_count = graphKnowledge?.length || 0;
            this.unique_candidates = uniqueCandidates?.length || 0;
            this.confidence_level = confidenceLevel || 'NONE';
            this.avg_similarity = Number(avgScore || 0);
            this.timing.retrieval = Number(elapsedMs || 0);

            if (graphKnowledge?.length > 0) {
                this.avg_resonance = graphKnowledge.reduce((sum, item) => sum + Number(item.similarity || 0), 0) / graphKnowledge.length;
            }

            if (top7?.length > 0) {
                this.top_sources = top7.map(item => ({
                    preview: sanitizeString(item.evidence_text || item.content || '').slice(0, 120),
                    score: Number(item.final_score || item.recall_score || item.rerank_score || item.similarity || 0),
                    source: item.source || 'UNKNOWN',
                    hop: item.hop || null,
                    remote_id: item.remote_id || null
                }));
            }
        },

        logAgentic({ iterations, webSearch, youtubeSkill, queries, elapsedMs }) {
            this.agentic_iterations = Number(iterations || 0);
            this.web_search_used = Boolean(webSearch);
            this.youtube_skill_used = Boolean(youtubeSkill);
            this.agentic_queries = Array.isArray(queries) ? queries : [];
            this.timing.agentic = Number(elapsedMs || 0);
        },

        logAtomization({ charsBefore, charsAfter, elapsedMs }) {
            this.context_chars_before = Number(charsBefore || 0);
            this.context_chars_after = Number(charsAfter || 0);
            this.timing.atomization = Number(elapsedMs || 0);
        },

        logReflection({ attempts, score, conflictDetected, conflictDetails, elapsedMs }) {
            this.reflection_attempts = Number(attempts || 0);
            this.reflection_score = Number(score || 0);
            this.conflict_detected = Boolean(conflictDetected);
            this.conflict_details = conflictDetails || null;
            this.timing.reflection = Number(elapsedMs || 0);
        },

        addLLMCall() {
            this.llm_calls_count += 1;
        },

        markCacheHit() {
            this.cache_hit = true;
        },

        setMode(mode) {
            this.mode = mode || 'legacy';
        },

        setQueryPlan(plan) {
            this.query_plan = plan || null;
        },

        setCandidateSummary(summary) {
            this.candidate_summary = summary || null;
        },

        setAnswerVerdict(verdict) {
            this.answer_verdict = verdict?.verdict || null;
            this.citation_coverage = Number(verdict?.citationCoverage || 0);
            this.supported_claims = Array.isArray(verdict?.supportedClaims)
                ? verdict.supportedClaims.slice(0, 8)
                : [];
        },

        setQueryStyle(style) {
            this.query_style = style || null;
        },

        setRetrievalProfile(profile) {
            this.retrieval_profile = profile || {};
        },

        async finish(response) {
            this.timing.total = Date.now() - this._startTime;

            const row = toTransportSafeJson(sanitizeJsonValue({
                client_id: this.client_id,
                query: this.query,
                mode: this.mode,
                hybrid_count: Number(this.hybrid_count || 0),
                graph_count: Number(this.graph_count || 0),
                unique_candidates: Number(this.unique_candidates || 0),
                avg_similarity: parseFloat(Number(this.avg_similarity || 0).toFixed(4)),
                avg_resonance: parseFloat(Number(this.avg_resonance || 0).toFixed(4)),
                confidence_level: this.confidence_level,
                agentic_iterations: Number(this.agentic_iterations || 0),
                web_search_used: Boolean(this.web_search_used),
                youtube_skill_used: Boolean(this.youtube_skill_used),
                cache_hit: Boolean(this.cache_hit),
                reflection_attempts: Number(this.reflection_attempts || 0),
                reflection_score: parseFloat(Number(this.reflection_score || 0).toFixed(1)),
                conflict_detected: Boolean(this.conflict_detected),
                total_latency_ms: Number(this.timing.total || 0),
                llm_calls_count: Number(this.llm_calls_count || 0),
                query_style: this.query_style,
                retrieval_profile: this.retrieval_profile,
                metadata: {
                    mode: this.mode,
                    query_plan: this.query_plan,
                    candidate_summary: this.candidate_summary,
                    citation_coverage: Number(this.citation_coverage || 0),
                    answer_verdict: this.answer_verdict,
                    supported_claims: this.supported_claims,
                    top_sources: this.top_sources,
                    agentic_queries: this.agentic_queries,
                    conflict_details: this.conflict_details,
                    context_chars_before: Number(this.context_chars_before || 0),
                    context_chars_after: Number(this.context_chars_after || 0),
                    timing_breakdown: this.timing,
                    response_preview: sanitizeString(response).slice(0, 200)
                }
            }));

            try {
                const { data, error } = await supabase.from('rag_metrics').insert([row]).select();
                if (!error) {
                    console.log(`[RAG Metrics] Trace guardado: ${this.confidence_level} | ${this.hybrid_count}H+${this.graph_count}G | ${this.timing.total}ms | ${this.llm_calls_count} LLM calls`);
                    return data?.[0] || row;
                }

                console.warn('[RAG Metrics] Error persistiendo metricas:', error.message);
                await diagnoseInvalidJsonRow(row);
            } catch (error) {
                console.warn('[RAG Metrics] Error no critico:', error.message);
            }

            return row;
        }
    };

    return trace;
}

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
            return { total_queries: 0, message: 'No hay metricas disponibles.' };
        }

        const total = metrics.length;
        const avgLatency = metrics.reduce((sum, item) => sum + Number(item.total_latency_ms || 0), 0) / total;
        const avgSimilarity = metrics.reduce((sum, item) => sum + Number(item.avg_similarity || 0), 0) / total;
        const avgResonance = metrics.reduce((sum, item) => sum + Number(item.avg_resonance || 0), 0) / total;
        const avgReflectionScore = metrics.reduce((sum, item) => sum + Number(item.reflection_score || 0), 0) / total;
        const avgLLMCalls = metrics.reduce((sum, item) => sum + Number(item.llm_calls_count || 0), 0) / total;

        const confidenceBreakdown = {
            HIGH: metrics.filter(item => item.confidence_level === 'HIGH').length,
            LOW: metrics.filter(item => item.confidence_level === 'LOW').length,
            NONE: metrics.filter(item => item.confidence_level === 'NONE').length
        };

        const cacheHitRate = metrics.filter(item => item.cache_hit).length / total;
        const webSearchRate = metrics.filter(item => item.web_search_used).length / total;
        const conflictRate = metrics.filter(item => item.conflict_detected).length / total;

        const sourceBreakdown = {
            avg_hybrid: (metrics.reduce((sum, item) => sum + Number(item.hybrid_count || 0), 0) / total).toFixed(1),
            avg_graph: (metrics.reduce((sum, item) => sum + Number(item.graph_count || 0), 0) / total).toFixed(1),
            avg_unique: (metrics.reduce((sum, item) => sum + Number(item.unique_candidates || 0), 0) / total).toFixed(1)
        };

        const worstQueries = metrics
            .filter(item => item.confidence_level === 'NONE' || Number(item.avg_similarity || 0) < 0.1)
            .slice(0, 5)
            .map(item => ({
                query: item.query,
                confidence: item.confidence_level,
                latency_ms: item.total_latency_ms,
                candidates: item.unique_candidates
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
            recent_traces: metrics.slice(0, 10).map(item => ({
                query: item.query,
                confidence: item.confidence_level,
                latency_ms: item.total_latency_ms,
                hybrid: item.hybrid_count,
                graph: item.graph_count,
                reflection_score: item.reflection_score,
                cache_hit: item.cache_hit,
                created_at: item.created_at
            }))
        };
    } catch (error) {
        console.error('[RAG Metrics] Error aggregating:', error.message);
        return { total_queries: 0, error: error.message };
    }
}
