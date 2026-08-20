import assert from 'node:assert/strict';
import test from 'node:test';

import { WecomHarnessBridge } from '../../../src/channels/wecom/wecom-bridge.mjs';

function frame(id = 'msg-1', content = '继续', overrides = {}) {
  return {
    headers: { req_id: `req-${id}` },
    body: {
      msgid: id,
      chattype: 'single',
      from: { userid: 'member-1' },
      msgtype: 'text',
      text: { content },
      ...overrides,
    },
  };
}

function stateFixture(route) {
  const sessions = new Map();
  const routes = route ? new Map([[route.key, route]]) : new Map();
  const seen = new Set();
  return {
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, sessionId) => sessions.set(key, sessionId),
      clearSession: async (key) => {
        sessions.delete(key);
      },
      routeFor: (key) => routes.get(key) ?? null,
      setRoute: async (key, value) => routes.set(key, value),
      removeRoute: async (key) => routes.delete(key),
      routeEntries: () => [...routes.entries()],
    },
  };
}

function questionInteraction({ interactionId = 'q-1', sessionId = 'session-web' } = {}) {
  return {
    kind: 'question',
    interactionId,
    rpcId: interactionId,
    sessionId,
    payload: {
      questions: [{ id: 'answer', question: '请选择继续方式', options: [{ label: '继续' }, { label: '取消' }] }],
    },
    recovered: false,
    respond: async (result) => result,
    reconnect: () => {},
  };
}

test('WeCom /watch adds a forwarding route without rebinding the IM chat session', async () => {
  const sent = [];
  const controller = new AbortController();
  const fixture = stateFixture();
  fixture.state.setSession('direct:member-1', 'session-existing');
  fixture.state.setRoute('direct:member-1', {
    sessionId: 'session-existing',
    actor: 'member-1',
    chatId: 'member-1',
    requiresMention: false,
    updatedAt: 1,
  });

  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async (_frame, _streamId, content, _finish) => sent.push({ chatId: 'member-1', text: content }),
      replyStreamNonBlocking: async () => {},
      sendMessage: async (chatId, body) => sent.push({ chatId, text: body.markdown.content }),
    },
    harness: {
      sessionExists: async () => true,
      watchInteractions: (sessionId, options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    },
    state: fixture.state,
    status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
    signal: controller.signal,
  });

  await bridge.accept(frame('watch-1', '/watch session-web'));

  assert.equal(fixture.state.sessionFor('direct:member-1'), 'session-existing', 'should not rebind the chat');
  assert.equal(fixture.state.routeFor('direct:member-1').sessionId, 'session-web', 'should add forwarding route');
  assert.ok(sent.some(({ text }) => text.includes('已开启转发')), 'should confirm watch mode');
  controller.abort();
});

test('WeCom forwards a bound Web-originated question to the chat and accepts the actor reply', async () => {
  const sent = [];
  const responses = [];
  const controller = new AbortController();
  let watchOptions;

  const route = {
    key: 'direct:member-1',
    sessionId: 'session-web',
    actor: 'member-1',
    chatId: 'member-1',
    requiresMention: false,
    updatedAt: 1,
  };
  const fixture = stateFixture(route);
  const bridge = new WecomHarnessBridge({
    client: {
      replyStream: async () => {},
      replyStreamNonBlocking: async () => {},
      sendMessage: async (chatId, body) => {
        sent.push({ chatId, text: body.markdown.content });
      },
    },
    harness: {
      watchInteractions: (sessionId, options) => {
        watchOptions = options;
        return new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
    state: fixture.state,
    status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
    signal: controller.signal,
  });

  bridge.startForwarding();
  assert.ok(watchOptions, 'forwarder should start a watcher for the bound session');

  const interaction = questionInteraction();
  interaction.respond = async (result) => {
    responses.push(result);
    return { accepted: true };
  };
  await watchOptions.onInteraction(interaction);

  assert.ok(sent.some(({ text }) => text.includes('请选择继续方式')), 'question should be pushed to IM');
  await bridge.accept(frame('msg-1', '继续'));

  assert.equal(responses.length, 1, 'phone answer should be submitted to Harness');
  assert.deepEqual(responses[0]?.value?.answer?.answers, [{
    id: 'answer',
    selected: ['继续'],
  }]);

  controller.abort();
});
