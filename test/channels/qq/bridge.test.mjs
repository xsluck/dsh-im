import assert from 'node:assert/strict';
import test from 'node:test';

import { QqHarnessBridge } from '../../../src/channels/qq/qq-bridge.mjs';

function message(overrides = {}) {
  return {
    kind: 'c2c',
    rawEventType: 'C2C_MESSAGE_CREATE',
    senderId: 'owner-openid',
    senderIsBot: false,
    content: '请回答',
    messageId: 'msg-1',
    replyTarget: { scope: 'c2c', targetId: 'owner-openid', msgId: 'msg-1' },
    ...overrides,
  };
}

test('QQ private messages stream Harness snapshots and finalize once', async () => {
  const frames = [];
  const sent = [];
  const seen = new Set();
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => sent.push(text),
      openStream: () => ({
        update: async (text) => frames.push(text),
        complete: async () => frames.push('DONE'),
        cancel() {},
      }),
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-new',
      ensureRunning: async () => true,
      ask: async (_session, _text, { onUpdate }) => {
        await onUpdate({ type: 'text', text: '回答中' });
        return '最终回答';
      },
    },
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: () => 'session-existing',
      setSession: async () => {},
      clearSession: async () => {},
    },
  });

  await bridge.accept(message());
  assert.deepEqual(frames, ['回答中', '最终回答', 'DONE']);
  assert.deepEqual(sent, []);
  assert.equal(seen.has('msg-1'), true);
  assert.equal(bridge.status.messagesReplied, 1);
});

test('QQ bridge accepts only the scanner and requires an at-message event in groups', async () => {
  let asks = 0;
  const state = {
    hasSeen: () => false,
    markSeen: async () => {},
    sessionFor: () => 'session',
    sessionExists: async () => true,
    setSession: async () => {},
    clearSession: async () => {},
  };
  const bridge = new QqHarnessBridge({
    bot: { sendText: async () => {} },
    ownerUserOpenid: 'owner-openid',
    harness: { sessionExists: async () => true, ask: async () => { asks += 1; return 'ok'; } },
    state,
  });
  await bridge.accept(message({ messageId: 'other', senderId: 'other-openid' }));
  await bridge.accept(message({
    messageId: 'group', kind: 'group', groupOpenid: 'group-1', rawEventType: 'GROUP_MESSAGE_CREATE',
    replyTarget: { scope: 'group', targetId: 'group-1', msgId: 'group' },
  }));
  assert.equal(asks, 0);
  assert.equal(bridge.status.messagesRejected, 1);
});

test('QQ credential-bound bots accept senders within the platform visibility scope', async () => {
  let asks = 0;
  const bridge = new QqHarnessBridge({
    bot: { sendText: async () => {} },
    ownerUserOpenid: '*',
    harness: {
      sessionExists: async () => true,
      ask: async () => { asks += 1; return 'ok'; },
    },
    state: {
      hasSeen: () => false,
      markSeen: async () => {},
      sessionFor: () => 'session',
      setSession: async () => {},
      clearSession: async () => {},
    },
  });
  await bridge.accept(message({ messageId: 'visible', senderId: 'visible-user' }));
  assert.equal(asks, 1);
  assert.equal(bridge.status.messagesRejected, 0);
});

test('QQ relays Harness approval to the conversation and accepts the user reply', async () => {
  const frames = [];
  const sent = [];
  const seen = new Set();
  let askCount = 0;
  const bridge = new QqHarnessBridge({
    bot: {
      sendText: async (_target, text) => sent.push(text),
      openStream: () => ({
        update: async (text) => frames.push(text),
        complete: async () => frames.push('DONE'),
        cancel() {},
      }),
    },
    ownerUserOpenid: 'owner-openid',
    harness: {
      sessionExists: async () => true,
      ensureRunning: async () => true,
      ask: async (_session, _text, options = {}) => {
        askCount += 1;
        await options.onApproval?.({ reason: 'This control can send a message.' });
        return '已发送';
      },
    },
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: () => 'session-existing',
      setSession: async () => {},
      clearSession: async () => {},
    },
    logger: { error() {} },
  });

  const first = bridge.accept(message());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.some((text) => text.includes('需要你审批')), true);

  await bridge.accept(message({ messageId: 'msg-2', content: '同意' }));
  await first;

  assert.equal(askCount, 1);
  assert.equal(seen.has('msg-2'), true);
  assert.equal(frames.includes('已发送'), true);
});
