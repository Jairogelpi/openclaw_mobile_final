import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRawMessageRecord, normalizeUuid } from '../services/raw_message_ingest.service.mjs';

const VALID_CLIENT_ID = 'cc2afceb-4db2-4c1e-81e3-9adf8d6eaad6';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('normalizeUuid keeps valid UUIDs and rejects blanks', () => {
    assert.equal(normalizeUuid(VALID_CLIENT_ID), VALID_CLIENT_ID);
    assert.equal(normalizeUuid('   '), null);
    assert.equal(normalizeUuid('not-a-uuid'), null);
});

test('buildRawMessageRecord preserves a valid client UUID', () => {
    const record = buildRawMessageRecord({
        clientId: VALID_CLIENT_ID,
        senderRole: 'Test',
        content: 'hola'
    });

    assert.equal(record.client_id, VALID_CLIENT_ID);
});

test('buildRawMessageRecord never emits an empty-string client_id', () => {
    const record = buildRawMessageRecord({
        clientId: '',
        senderRole: 'Test',
        content: 'hola'
    });

    assert.equal(record.client_id, null);
});

test('buildRawMessageRecord regenerates invalid raw IDs as UUIDs', () => {
    const record = buildRawMessageRecord({
        id: 'broken-id',
        clientId: VALID_CLIENT_ID,
        senderRole: 'Test',
        content: 'hola'
    });

    assert.match(record.id, UUID_REGEX);
});
