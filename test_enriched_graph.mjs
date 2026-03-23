import { getEnrichedGraphContext } from './services/graph.service.mjs';

const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6'; 
const query = 'quien es victor y que relacion tiene con sara';

async function testEnriched() {
    console.log(`\n--- Testing getEnrichedGraphContext with query: "${query}" ---`);
    const result = await getEnrichedGraphContext(clientId, query);
    
    console.log(`Nodes found: ${result.nodes.length}`);
    result.nodes.forEach(n => console.log(`- ${n.entity_name}`));
    
    console.log(`Edges found: ${result.edges.length}`);
    result.edges.forEach(e => console.log(`- ${e.source_node} -> ${e.target_node}`));
    
    console.log(`Facts found: ${result.facts.length}`);
    result.facts.forEach(f => console.log(`- ${f.evidence_text}`));

    console.log('\nUnified Prompt Segment:');
    console.log(result.unified_prompt_segment);
}

(async () => {
    await testEnriched();
})();
