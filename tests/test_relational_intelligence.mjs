import fs from 'fs/promises';
import supabase from '../config/supabase.mjs';
import { getEnrichedGraphContext } from '../services/graph.service.mjs';

async function testRelationalIntelligence() {
    const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6'; // Valid clientId from database
    const query = 'Háblame de mi trabajo y las empresas con las que trato';
    
    console.log('--- TESTING DEEP RELATIONAL INTELLIGENCE ---');
    console.log(`Query: ${query}`);
    
    try {
        const context = await getEnrichedGraphContext(clientId, query);
        console.log('\n[SUCCESS] Enriched Graph Context retrieved:');
        console.log('Nodes found:', context.nodes.length);
        console.log('Edges found:', context.edges.length);
        console.log('Communities found:', context.communities.length);
        console.log('Facts found:', context.facts.length);
        
        console.log('\n--- UNIFIED PROMPT SEGMENT ---');
        console.log(context.unified_prompt_segment);
        
    } catch (error) {
        console.error('\n[ERROR] Test failed:', error);
    }
}

testRelationalIntelligence();
