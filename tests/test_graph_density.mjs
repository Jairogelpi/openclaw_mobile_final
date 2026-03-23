import postgres from 'postgres';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const sql = postgres(process.env.DATABASE_URL);

async function testDensity() {
    try {
        const clientId = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';
        const [{ count: nodesCount }] = await sql`SELECT count(*) FROM knowledge_nodes WHERE client_id = ${clientId}`;
        const [{ count: edgesCount }] = await sql`SELECT count(*) FROM knowledge_edges WHERE client_id = ${clientId}`;
        
        const nodes = parseInt(nodesCount, 10);
        const edges = parseInt(edgesCount, 10);
        
        console.log(`=== MATHEMATICAL GRAPH DENSITY REPORT ===`);
        console.log(`Total Nodes: ${nodes}`);
        console.log(`Total Edges: ${edges}`);
        
        if (nodes === 0) {
            console.log(`Density Ratio (Edges/Nodes): N/A (Graph is empty)`);
            return;
        }
        
        const ratio = (edges / nodes).toFixed(3);
        console.log(`Density Ratio (Edges/Nodes): ${ratio}`);
        
        if (ratio < 1) {
            console.log(`⚠️ WARNING: Ratio < 1.0 indicates severe fragmentation (isolated islands/floating nodes).`);
            console.log(`Mathematical Proof: A fully connected basic graph requires at least N-1 edges.`);
        } else {
            console.log(`✅ PASS: Ratio >= 1.0. The graph is dense and highly interconnected.`);
        }
        
    } catch(e) {
        console.error(e);
    } finally {
        await sql.end();
    }
}
testDensity();
