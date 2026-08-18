import assert from 'node:assert/strict';
import test from 'node:test';

import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';

function message(id, content, overrides = {}) {
  return {
    messageId: id,
    senderId: 'sender',
    conversationId: 'conversation',
    kind: 'direct',
    content,
    replyTarget: 'target',
    ...overrides,
  };
}

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessions,
    seen,
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, sessionId) => sessions.set(key, sessionId),
      clearSession: async (key) => sessions.delete(key),
    },
  };
}

test('shared text bridge relays Harness approval to the conversation and accepts the user reply', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('direct:conversation', 'session-1');
  const sent = [];
  let askCount = 0;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { async sendText(_target, text) { sent.push(text); } },
    harness: {
      sessionExists: async () => true,
      createSession: async () => { throw new Error('should reuse the bound session'); },
      ask: async (_sessionId, _text, options = {}) => {
        askCount += 1;
        await options.onApproval?.({ reason: 'This control can send a message.' });
        return '已发送';
      },
    },
    state: fixture.state,
    logger: { error() {} },
  });

  const first = bridge.accept(message('1', '请发送'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.some((text) => text.includes('需要你审批')), true);

  const second = bridge.accept(message('2', '同意'));
  await second;
  await first;

  assert.equal(askCount, 1);
  assert.equal(fixture.seen.has('2'), true);
  assert.equal(sent.at(-1), '已发送');
});

test('shared text bridge sends an English approval prompt when the user writes in English', async () => {
  const fixture = stateFixture();
  fixture.sessions.set('direct:conversation', 'session-1');
  const sent = [];
  let askCount = 0;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'test', label: 'Test' },
    bot: { async sendText(_target, text) { sent.push(text); } },
    harness: {
      sessionExists: async () => true,
      createSession: async () => { throw new Error('should reuse the bound session'); },
      ask: async (_sessionId, _text, options = {}) => {
        askCount += 1;
        await options.onApproval?.({ reason: 'sends a message' });
        return 'done';
      },
    },
    state: fixture.state,
    logger: { error() {} },
  });

  const first = bridge.accept(message('1', 'Please send a message'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.some((text) => text.includes('Approval required')), true);

  const second = bridge.accept(message('2', 'yes'));
  await second;
  await first;

  assert.equal(askCount, 1);
  assert.equal(fixture.seen.has('2'), true);
  assert.equal(sent.at(-1), 'done');
});