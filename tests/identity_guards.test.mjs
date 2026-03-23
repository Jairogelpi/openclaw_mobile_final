import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildRawIdentitySignal,
    classifyIdentityLikeName,
    isLikelyGroupConversation,
    isLikelyGroupLabel,
    normalizeIdentityName,
    sanitizeIdentityRow
} from '../utils/identity_policy.mjs';

test('normalizeIdentityName strips decorative noise but keeps a human name', () => {
    const result = normalizeIdentityName('  Jairo Gelpi  ');
    assert.deepEqual(result, {
        canonical: 'Jairo Gelpi',
        normalized: 'jairo gelpi'
    });
});

test('buildRawIdentitySignal ignores group rows without a participant identity', () => {
    const result = buildRawIdentitySignal({
        remote_id: '120363412380291213@g.us',
        sender_role: 'Victor',
        metadata: {
            canonicalSenderName: 'Victor',
            pushName: 'Victor'
        }
    });

    assert.equal(result, null);
});

test('buildRawIdentitySignal keeps direct contact aliases but not group-like conversation labels', () => {
    const result = buildRawIdentitySignal({
        remote_id: '34637157985@s.whatsapp.net',
        sender_role: 'Mireya',
        metadata: {
            canonicalSenderName: 'Mireya',
            pushName: 'Mireya',
            conversationName: 'Casa'
        }
    });

    assert.equal(result.remoteId, '34637157985@s.whatsapp.net');
    assert.deepEqual(result.aliases, ['Mireya', 'Mireya', 'Mireya']);
});

test('sanitizeIdentityRow reduces owner aliases to the canonical owner name only', () => {
    const row = sanitizeIdentityRow({
        remote_id: '178322881437941@lid',
        canonical_name: 'Jairo Gelpi',
        aliases: ['Jairo Gelpi', 'user sent', 'Casa', '123456789'],
        source_details: {
            owner_identity: true,
            owner_preferred_name: 'Jairo Gelpi'
        }
    });

    assert.deepEqual(row.aliases, ['Jairo Gelpi']);
    assert.equal(row.source_details.owner_identity, true);
});

test('sanitizeIdentityRow strips person aliases from group identities', () => {
    const row = sanitizeIdentityRow({
        remote_id: '120363412380291213@g.us',
        canonical_name: 'Casa',
        aliases: ['Casa', 'Jairo', 'user sent'],
        source_details: {}
    });

    assert.equal(isLikelyGroupConversation(row.remote_id), true);
    assert.deepEqual(row.aliases, ['Casa']);
});

test('sanitizeIdentityRow strips group-like aliases from personal identities', () => {
    const row = sanitizeIdentityRow({
        remote_id: '34637157985@s.whatsapp.net',
        canonical_name: 'Mireya',
        aliases: ['Mireya', 'Casa', 'Controles y radares'],
        source_details: {}
    });

    assert.equal(isLikelyGroupLabel('Casa'), true);
    assert.deepEqual(row.aliases, ['Mireya']);
});

test('classifyIdentityLikeName separates role mention, group label and human alias', () => {
    assert.equal(classifyIdentityLikeName('mi colega'), 'role_mention');
    assert.equal(classifyIdentityLikeName('Máster INESDI'), 'group_label');
    assert.equal(classifyIdentityLikeName('Ares G Smoke'), 'human_alias');
    assert.equal(classifyIdentityLikeName('Francisco Jose Sanchez'), 'human_alias');
    assert.equal(classifyIdentityLikeName('Julio Ojeda'), 'human_alias');
    assert.equal(classifyIdentityLikeName('padrastro de Lydia Insta'), 'role_mention');
});
