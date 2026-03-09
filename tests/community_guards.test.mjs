import test from 'node:test';
import assert from 'node:assert/strict';

import { filterValidCommunityNodeIds } from '../utils/community_guard.mjs';

test('filterValidCommunityNodeIds keeps only valid UUIDs present in the selected node set', () => {
    const validA = 'ddd690de-e652-44a7-bf87-ff87e6a98150';
    const validB = 'a1b2c3d4-e652-44a7-bf87-ff87e6a98150';
    const result = filterValidCommunityNodeIds(
        [
            validA,
            'ddd690d-e652-44a7-bf87-ff87e6a98150',
            validB,
            validA,
            'not-a-uuid'
        ],
        new Set([validA])
    );

    assert.deepEqual(result, [validA]);
});
