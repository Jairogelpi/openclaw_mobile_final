import 'dotenv/config';
import supabase from './config/supabase.mjs';
import { findEvidence } from './services/evidence_rag.service.mjs';

async function diagnose() {
    console.log("🔍 DIAGNOSTICO: Buscando 'Sara' en la base de datos...");
    
    // 1. Verificar existencia física del nodo
    const { data: nodes, error: nodeError } = await supabase
        .from('knowledge_nodes')
        .select('id, entity_name, description, stability_tier, support_count')
        .ilike('entity_name', '%sara%')
        .limit(10);
        
    if (nodeError) {
        console.error("❌ Error buscando nodos (ILIKE):", nodeError.message);
    } else {
        console.log("📍 Nodos encontrados (ILIKE):", nodes.length);
        nodes.forEach(n => {
            console.log(`  - [${n.stability_tier}] ${n.entity_name}: ${n.description?.substring(0, 50)}... (Support: ${n.support_count})`);
        });
    }

    // 1.1 Probar RPC directamente
    console.log("\n🧪 PROBANDO RPC hybrid_search_memories...");
    const { data: rpcData, error: rpcError } = await supabase.rpc('hybrid_search_memories', {
        p_client_id: 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6',
        query_text: 'Quién es Sara',
        query_embedding: Array(768).fill(0), // Fake embedding to see if FTS works at least
        match_count: 5
    });

    if (rpcError) {
        console.error("❌ Error en RPC hybrid_search_memories:", rpcError.message);
    } else {
        console.log("✅ RPC respondió con:", rpcData?.length || 0, "resultados.");
        rpcData?.forEach(n => console.log(`  - ${n.content.substring(0, 80)}... (Sim: ${n.similarity})`));
    }

    // 2. Probar el RAG pipeline completo
    console.log("\n🧪 PROBANDO RAG: 'Quién es Sara'...");
    try {
        const evidence = await findEvidence('cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6', 'Quién es Sara', { slug: 'jairogelpi-cc2af' });
        
        console.log("\n✅ EVIDENCIA RECUPERADA:");
        console.log(`- Candidatos: ${evidence.candidates?.length || 0}`);
        evidence.candidates?.forEach((c, i) => {
            const text = String(c.evidence_text || c.content || "");
            console.log(`  ${i+1}. [${c.source_kind}] Final Score: ${c.final_score.toFixed(3)} | ${text.substring(0, 80)}...`);
        });

        console.log("\n📖 SEGMENTO DE PROMPT UNIFICADO (Total Length: " + (evidence.cognitiveMap?.unified_prompt?.length || 0) + "):");
        const prompt = evidence.cognitiveMap?.unified_prompt || "";
        console.log(`- ¿Contiene 'Sara'?: ${prompt.includes('Sara') || prompt.includes('sara')}`);
        
        if (prompt.includes('### ENTIDADES RELEVANTES')) {
            const start = prompt.indexOf('### ENTIDADES RELEVANTES');
            console.log("\n📍 SECCIÓN DE ENTIDADES:\n", prompt.substring(start, start + 500));
        } else {
            console.log("\n⚠️ SECCIÓN DE ENTIDADES NO ENCONTRADA EN EL PROMPT.");
        }
    } catch (err) {
        console.error("💥 Error en findEvidence:", err.message);
        console.trace(err);
    }

    process.exit(0);
}

diagnose();
