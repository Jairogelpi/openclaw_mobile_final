const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function filterValidCommunityNodeIds(nodeIds = [], validNodeIds = new Set()) {
    const output = [];
    for (const rawId of (nodeIds || [])) {
        const nodeId = String(rawId || '').trim();
        if (!UUID_PATTERN.test(nodeId)) continue;
        if (validNodeIds.size && !validNodeIds.has(nodeId)) continue;
        if (!output.includes(nodeId)) output.push(nodeId);
    }
    return output;
}
