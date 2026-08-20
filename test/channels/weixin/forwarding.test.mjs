import assert from 'node:assert/strict';
import test from 'node:test';

import { createWeixinBridgeStatus, WeixinHarnessBridge } from '../../../src/channels/weixin/weixin-bridge.mjs';

function message(id, text) {
  return {
    message_id: id,
    message_type: 1,
    from_user_id: 'owner-user',
    context_token: `context-${id}`,
    item_list: [{ type: 1, text_item: { text } }],
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

test('Weixin /watch adds a forwarding route without rebinding the IM chat session', async () => {
  const sent = [];
  const controller = new AbortController();
  const fixture = stateFixture();
  fixture.state.setSession('p2p:owner-user', 'session-existing');
  fixture.state.setRoute('p2p:owner-user', {
    sessionId: 'session-existing',
    actor: 'owner-user',
    contextToken: 'old-context',
    runId: 'old-run',
    updatedAt: 1,
  });

  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => {
        sent.push({ text: request.text });
        return true;
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      sessionExists: async () => true,
      watchInteractions: (sessionId, options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    },
    state: fixture.state,
    status: createWeixinBridgeStatus(),
    signal: controller.signal,
  });

  await bridge.accept(message('watch-1', '/watch session-web'));

  assert.equal(fixture.state.sessionFor('p2p:owner-user'), 'session-existing', 'should not rebind the chat');
  assert.equal(fixture.state.routeFor('p2p:owner-user').sessionId, 'session-web', 'should add forwarding route');
  assert.ok(sent.some(({ text }) => text.includes('已开启转发')), 'should confirm watch mode');
  controller.abort();
});

test('Weixin /watch * defaults future web sessions to this IM chat without rebinding', async () => {
  const sent = [];
  const responses = [];
  const controller = new AbortController();
  let watchAllOptions;
  const fixture = stateFixture();
  fixture.state.setSession('p2p:owner-user', 'session-existing');

  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => {
        sent.push({ toUserId: request.toUserId, text: request.text });
        return true;
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      watchInteractions: (sessionId, options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
      watchAllInteractions: (options) => {
        watchAllOptions = options;
        return new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
    state: fixture.state,
    status: createWeixinBridgeStatus(),
    signal: controller.signal,
  });

  await bridge.accept(message('watch-all-1', '/watch *'));

  assert.equal(fixture.state.sessionFor('p2p:owner-user'), 'session-existing', 'should not rebind the chat');
  assert.equal(fixture.state.routeFor('p2p:owner-user').sessionId, '*', 'should store default route');
  assert.ok(sent.some(({ text }) => text.includes('默认转发')), 'should confirm default watch mode');
  assert.ok(watchAllOptions, 'should start a global interaction watcher');

  await watchAllOptions.onInteraction({
    kind: 'question',
    interactionId: 'q-new',
    rpcId: 'q-new',
    sessionId: 'session-brand-new',
    payload: {
      questions: [{ id: 'answer', question: '新会话需要你确认吗？', options: [{ label: '是' }, { label: '否' }] }],
    },
    recovered: false,
    respond: async (result) => {
      responses.push(result);
      return { accepted: true };
    },
  });

  assert.ok(sent.some(({ text }) => text.includes('新会话需要你确认吗')), 'new session question should be forwarded');
  assert.equal(responses.length, 0, 'default route only forwards, answer still belongs to the original web asker');
  controller.abort();
});

test('Weixin /new keeps forwarding and /unwatch removes it without touching the session binding', async () => {
  const sent = [];
  const controller = new AbortController();
  const fixture = stateFixture();
  fixture.state.setSession('p2p:owner-user', 'session-existing');
  fixture.state.setRoute('p2p:owner-user', {
    sessionId: '*',
    actor: 'owner-user',
    contextToken: 'ctx',
    runId: 'run',
    updatedAt: 1,
  });

  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => {
        sent.push({ text: request.text });
        return true;
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {},
    state: fixture.state,
    status: createWeixinBridgeStatus(),
    signal: controller.signal,
  });

  await bridge.accept(message('new-1', '/new'));
  assert.equal(fixture.state.sessionFor('p2p:owner-user'), null, '/new should clear the chat session');
  assert.equal(fixture.state.routeFor('p2p:owner-user').sessionId, '*', '/new should keep forwarding');

  sent.length = 0;
  await bridge.accept(message('unwatch-1', '/unwatch'));
  assert.equal(fixture.state.routeFor('p2p:owner-user'), null, '/unwatch should remove forwarding');
  assert.ok(sent.some(({ text }) => text.includes('已关闭当前聊天的转发设置')), 'should confirm unwatch');
  controller.abort();
});

test('Weixin forwards a bound Web-originated question to the owner and accepts the owner reply', async () => {
  const sent = [];
  const responses = [];
  const controller = new AbortController();
  let watchOptions;

  const route = {
    key: 'p2p:owner-user',
    sessionId: 'session-web',
    actor: 'owner-user',
    contextToken: 'stored-context',
    runId: 'stored-run',
    updatedAt: 1,
  };
  const fixture = stateFixture(route);
  const bridge = new WeixinHarnessBridge({
    api: {
      sendText: async (request) => {
        sent.push({ toUserId: request.toUserId, text: request.text, contextToken: request.contextToken });
        return true;
      },
    },
    baseUrl: 'https://ilinkai.weixin.qq.com/',
    token: 'host-token',
    ownerUserId: 'owner-user',
    harness: {
      watchInteractions: (sessionId, options) => {
        watchOptions = options;
        return new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
    state: fixture.state,
    status: createWeixinBridgeStatus(),
    signal: controller.signal,
  });

  bridge.startForwarding();
  assert.ok(watchOptions, 'forwarder should start a watcher for the bound session');

  await watchOptions.onInteraction({
    kind: 'question',
    interactionId: 'q-1',
    rpcId: 'q-1',
    sessionId: 'session-web',
    payload: {
      questions: [{ id: 'answer', question: '请选择继续方式', options: [{ label: '继续' }, { label: '取消' }] }],
    },
    recovered: false,
    respond: async (result) => {
      responses.push(result);
      return { accepted: true };
    },
  });

  assert.ok(sent.some(({ text }) => text.includes('请选择继续方式')), 'question should be pushed to IM');
  await bridge.accept(message('msg-1', '继续'));

  assert.equal(responses.length, 1, 'phone answer should be submitted to Harness');
  assert.deepEqual(responses[0]?.value?.answer?.answers, [{
    id: 'answer',
    selected: ['继续'],
  }]);

  controller.abort();
});
