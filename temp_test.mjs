import { generateEmbedding, cosineSimilarity } from './services/local_ai.mjs';
import * as core from './core_engine.mjs';
import * as graph from './services/graph.service.mjs';

async function test() {
    console.log('🧪 Starting Integration Test...');

    try {
        console.log('1. Testing local_ai.mjs...');
        const vec = await generateEmbedding('test text');
        console.log(`   - Embedding generated (length: ${vec.length})`);
        const sim = cosineSimilarity(vec, vec);
        console.log(`   - Cosine Similarity: ${sim}`);

        console.log('2. Checking core_engine.mjs exports...');
        if (typeof core.processMessage === 'function') {
            console.log('   - core_engine.mjs processMessage exported');
        } else {
            throw new Error('processMessage NOT exported from core_engine.mjs');
        }

        console.log('3. Checking graph.service.mjs exports...');
        if (typeof graph.traverseGraph === 'function') {
            console.log('   - graph.service.mjs traverseGraph exported');
        } else {
            throw new Error('traverseGraph NOT exported from graph.service.mjs');
        }

        console.log('✅ INTEGRATION TEST PASSED');
    } catch (err) {
        console.error('❌ INTEGRATION TEST FAILED:', err);
        process.exit(1);
    }
}

test();
