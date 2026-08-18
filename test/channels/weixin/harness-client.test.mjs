import assert from 'node:assert/strict';
import test from 'node:test';

import { HarnessClient, HarnessReplyTracker } from '../../../src/channels/weixin/harness-client.mjs';

test('HarnessClient lists only absolute workspace paths', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  const options = { rpcId: 'weixin-workspace-list' };
  const calls = [];
  let response = {
    items: [
      {
        workspaceId: 'workspace-one',
        path: '/tmp/workspace-one',
        title: 'private title',
        sessionIds: ['private-session'],
      },
      { workspaceId: 'relative', path: 'relative/workspace' },
      null,
      { workspaceId: 'workspace-two', path: '/tmp/workspace two' },
    ],
    archivedSessionIds: ['private-archive'],
  };
  client.ensureRunning = async () => { calls.push({ method: 'ensureRunning' }); };
  client.rpc = async (method, payload, timeoutMs, rpcOptions) => {
    calls.push({ method, payload, timeoutMs, options: rpcOptions });
    return response;
  };

  assert.deepEqual(await client.listWorkspaces(options), [
    '/tmp/workspace-one',
    '/tmp/workspace two',
  ]);
  assert.deepEqual(calls, [
    { method: 'ensureRunning' },
    { method: 'workspace.list', payload: {}, timeoutMs: 30_000, options },
  ]);

  response = { items: 'invalid' };
  assert.deepEqual(await client.listWorkspaces(), []);
});

test('HarnessClient lists sessions by workspace accounting in its stored order', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  const options = { rpcId: 'weixin-session-list' };
  const calls = [];
  let invalidWorkspaceResponse = false;
  let invalidSessionResponse = false;
  client.ensureRunning = async () => { calls.push({ method: 'ensureRunning' }); };
  client.rpc = async (method, payload, timeoutMs, rpcOptions) => {
    calls.push({ method, payload, timeoutMs, options: rpcOptions });
    if (method === 'workspace.list') {
      if (invalidWorkspaceResponse) return null;
      return {
        items: [
          {
            workspaceId: 'target',
            path: '/tmp/target',
            sessionIds: ['session-two', 'session-missing', 'session-one'],
          },
          { workspaceId: 'other', path: '/tmp/other', sessionIds: ['cwd-only'] },
        ],
        archivedSessionIds: ['session-missing', 'session-one'],
      };
    }
    assert.equal(method, 'session.list');
    if (invalidSessionResponse) return null;
    return {
      items: [
        {
          sessionId: 'session-one',
          blank: false,
          cwd: '/tmp/target',
          projections: { values: { title: null } },
        },
        {
          sessionId: 'session-two',
          blank: true,
          origin: 'subagent',
          cwd: '/tmp/different',
          projections: { values: { title: 'Second session' } },
        },
        {
          sessionId: 'cwd-only',
          blank: false,
          cwd: '/tmp/target',
          projections: { values: { title: 'Must not leak into target' } },
        },
      ],
    };
  };

  assert.deepEqual(await client.listWorkspaceSessions('/tmp/target', options), {
    workspace: '/tmp/target',
    sessions: [
      {
        sessionId: 'session-two',
        title: 'Second session',
        archived: false,
        blank: true,
        origin: 'subagent',
        summaryAvailable: true,
      },
      {
        sessionId: 'session-missing',
        title: null,
        archived: true,
        blank: false,
        origin: null,
        summaryAvailable: false,
      },
      {
        sessionId: 'session-one',
        title: null,
        archived: true,
        blank: false,
        origin: null,
        summaryAvailable: true,
      },
    ],
  });
  assert.deepEqual(calls, [
    { method: 'ensureRunning' },
    { method: 'workspace.list', payload: {}, timeoutMs: 30_000, options },
    { method: 'session.list', payload: {}, timeoutMs: 30_000, options },
  ]);

  calls.length = 0;
  assert.deepEqual(await client.listWorkspaceSessions('/tmp/unregistered'), {
    workspace: '/tmp/unregistered',
    sessions: [],
  });
  assert.deepEqual(calls, [
    { method: 'ensureRunning' },
    { method: 'workspace.list', payload: {}, timeoutMs: 30_000, options: {} },
  ]);

  invalidWorkspaceResponse = true;
  await assert.rejects(
    client.listWorkspaceSessions('/tmp/target'),
    /invalid response for workspace\.list/,
  );
  invalidWorkspaceResponse = false;
  invalidSessionResponse = true;
  await assert.rejects(
    client.listWorkspaceSessions('/tmp/target'),
    /invalid response for session\.list/,
  );
});

test('HarnessClient adopts one registered ordinary session without changing its preset', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    agentPreset: 'custom-preset',
  });
  const options = {
    signal: new AbortController().signal,
    rpcId: 'weixin-session-adopt',
  };
  const calls = [];
  client.ensureRunning = async (received) => {
    calls.push({ method: 'ensureRunning', options: received });
  };
  client.rpc = async (method, payload, timeoutMs, rpcOptions) => {
    calls.push({ method, payload, timeoutMs, options: rpcOptions });
    if (method === 'workspace.list') {
      return {
        items: [
          {
            workspaceId: 'workspace-target',
            path: '/tmp/target',
            sessionIds: ['session-other', 'session-target'],
          },
          { workspaceId: 'workspace-unsafe', path: '/tmp/unsafe\u202e', sessionIds: [] },
          { workspaceId: 'workspace-other', path: '/tmp/other', sessionIds: [] },
        ],
        archivedSessionIds: ['session-target'],
      };
    }
    if (method === 'session.list') {
      return {
        items: [{
          sessionId: 'session-target',
          projections: { values: { title: 'Existing conversation' } },
        }],
      };
    }
    assert.equal(method, 'session.create');
    return { sessionId: 'session-target', agentPreset: 'persisted-preset' };
  };

  assert.deepEqual(await client.adoptWorkspaceSession('session-target', options), {
    sessionId: 'session-target',
    workspace: '/tmp/target',
    title: 'Existing conversation',
    archived: true,
  });
  assert.deepEqual(calls, [
    { method: 'ensureRunning', options },
    { method: 'workspace.list', payload: {}, timeoutMs: 30_000, options },
    { method: 'session.list', payload: {}, timeoutMs: 30_000, options },
    {
      method: 'session.create',
      payload: { workspaceId: 'workspace-target', sessionId: 'session-target' },
      timeoutMs: 30_000,
      options,
    },
  ]);
});

test('HarnessClient safely rejects invalid, unregistered, ambiguous, and subagent adoption', async () => {
  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
  });
  let mode = 'unregistered';
  let createCalls = 0;
  client.ensureRunning = async () => undefined;
  client.rpc = async (method) => {
    if (method === 'workspace.list') {
      if (mode === 'invalid-workspaces') return { items: null, archivedSessionIds: [] };
      if (mode === 'unregistered') {
        return {
          items: [{ workspaceId: 'workspace', path: '/tmp/workspace', sessionIds: [] }],
          archivedSessionIds: [],
        };
      }
      return {
        items: [
          {
            workspaceId: 'workspace-one',
            path: '/tmp/one',
            sessionIds: ['session-target'],
          },
          ...(mode === 'ambiguous' ? [{
            workspaceId: 'workspace-two',
            path: '/tmp/two',
            sessionIds: ['session-target'],
          }] : []),
        ],
        archivedSessionIds: [],
      };
    }
    if (method === 'session.list') {
      if (mode === 'summary-missing') return { items: [] };
      return {
        items: [{
          sessionId: 'session-target',
          ...(mode === 'subagent' ? { origin: 'subagent' } : {}),
        }],
      };
    }
    createCalls += 1;
    return mode === 'bad-create'
      ? { sessionId: 'different-session' }
      : { sessionId: 'session-target' };
  };

  for (const invalid of [
    undefined,
    '',
    '   ',
    'session target',
    'session\u0000target',
    's'.repeat(257),
  ]) {
    await assert.rejects(
      client.adoptWorkspaceSession(invalid),
      (error) => error?.code === 'session-id-invalid',
    );
  }
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    (error) => error?.code === 'session-not-registered',
  );
  mode = 'ambiguous';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    (error) => error?.code === 'session-workspace-ambiguous',
  );
  mode = 'summary-missing';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    (error) => error?.code === 'session-summary-unavailable',
  );
  mode = 'subagent';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    (error) => error?.code === 'session-subagent-unsupported',
  );
  assert.equal(createCalls, 0);

  mode = 'invalid-workspaces';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    /invalid response for workspace\.list/,
  );
  mode = 'bad-create';
  await assert.rejects(
    client.adoptWorkspaceSession('session-target'),
    /invalid response for session\.create/,
  );
  assert.equal(createCalls, 1);
});

test('reply tracker associates only the Harness turn created by the Weixin prompt RPC', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'weixin-prompt', afterSeq: 2 });
  const first = tracker.consume([
    { event: { seq: 3, type: 'turn/start', data: { turn: 9 } } },
    { event: {
      seq: 4,
      type: 'user/message',
      data: { turn: 9, source: { rpcId: 'weixin-prompt' } },
    } },
    { event: {
      seq: 5,
      type: 'assistant/chunk',
      data: { turn: 9, step: 0, chunk: { type: 'text-delta', index: 0, text: '微信' } },
    } },
  ]);
  assert.deepEqual(first, { type: 'text', text: '微信', source: 'delta' });
  tracker.consume([
    { event: {
      seq: 6,
      type: 'assistant/message',
      data: { turn: 9, message: { content: [{ type: 'text', text: '微信回复完成' }] } },
    } },
    { event: { seq: 7, type: 'turn/end', data: { turn: 9, reason: 'completed' } } },
  ]);
  assert.equal(tracker.finished, true);
  assert.equal(tracker.answer, '微信回复完成');
});

test('reply tracker surfaces completed text blocks and tool status', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'weixin-prompt', afterSeq: 2 });
  const first = tracker.consume([
    { event: { seq: 3, type: 'turn/start', data: { turn: 4 } } },
    { event: {
      seq: 4,
      type: 'user/message',
      data: { turn: 4, source: { rpcId: 'weixin-prompt' } },
    } },
    { event: {
      seq: 5,
      type: 'assistant/chunk',
      data: {
        turn: 4,
        step: 0,
        chunk: { type: 'block-end', index: 1, block: { type: 'text', text: '先查一下本地文件。' } },
      },
    } },
  ]);
  assert.deepEqual(first, { type: 'text', text: '先查一下本地文件。', source: 'message' });
  const second = tracker.consume([
    { event: { seq: 6, type: 'tool/call', data: { turn: 4, step: 0, name: 'bash' } } },
    { event: { seq: 7, type: 'assistant/chunk', data: {
      turn: 4,
      step: 0,
      chunk: { type: 'block-end', index: 2, block: { type: 'reasoning', text: 'hidden thinking' } },
    } } },
    { event: { seq: 8, type: 'tool/result', data: { turn: 4, step: 0 } } },
  ]);
  assert.deepEqual(second, { type: 'status', text: '正在整理结果…' });
  const third = tracker.consume([
    { event: {
      seq: 9,
      type: 'assistant/chunk',
      data: { turn: 4, step: 0, chunk: { type: 'block-end', index: 3, block: { type: 'text', text: '查清楚了！' } } },
    } },
    { event: { seq: 10, type: 'turn/end', data: { turn: 4, reason: 'completed' } } },
  ]);
  assert.deepEqual(third, { type: 'text', text: '查清楚了！', source: 'message' });
  assert.equal(tracker.finished, true);
  assert.equal(tracker.answer, '查清楚了！');
});

test('reply tracker keeps narration text when tool events land in the same window', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'weixin-prompt', afterSeq: 2 });
  const update = tracker.consume([
    { event: { seq: 3, type: 'turn/start', data: { turn: 4 } } },
    { event: {
      seq: 4,
      type: 'user/message',
      data: { turn: 4, source: { rpcId: 'weixin-prompt' } },
    } },
    { event: {
      seq: 5,
      type: 'assistant/chunk',
      data: {
        turn: 4,
        step: 0,
        chunk: { type: 'block-end', index: 1, block: { type: 'text', text: '先查一下本地文件。' } },
      },
    } },
    { event: { seq: 6, type: 'tool/call', data: { turn: 4, step: 0, name: 'bash' } } },
    { event: { seq: 7, type: 'tool/result', data: { turn: 4, step: 0 } } },
  ]);
  assert.deepEqual(update, { type: 'text', text: '先查一下本地文件。', source: 'message' });
  assert.equal(tracker.answer, '先查一下本地文件。');
});

test('reply tracker ignores interleaved turns and older events', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: 'target', afterSeq: 10 });
  tracker.consume([
    { event: { seq: 9, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 11, type: 'turn/start', data: { turn: 2 } } },
    { event: { seq: 12, type: 'user/message', data: { turn: 2, source: { rpcId: 'other' } } } },
    { event: {
      seq: 13,
      type: 'assistant/message',
      data: { turn: 2, message: { content: [{ type: 'text', text: 'wrong' }] } },
    } },
  ]);
  assert.equal(tracker.answer, '');
  assert.equal(tracker.finished, false);
});
test('HarnessClient relays an approval/requested mux WebSocket frame and responds with the user outcome', async () => {
  const instances = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }

    emit(type, event = {}) {
      for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close');
    }
  }

  const envelope = (rpcId, session, approvalId) => JSON.stringify({
    type: 'server-request',
    rpcId,
    method: 'events.mux',
    payload: {
      type: 'approval/requested',
      sessionId: session,
      approvalId,
      toolName: 'phone_act',
      reason: 'Send message',
    },
  });

  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    webSocketImpl: FakeWebSocket,
  });
  client.ensureRunning = async () => {};
  let promptRpcId = null;
  let historyCalls = 0;
  client.rpc = async (method, payload, _timeoutMs, options = {}) => {
    if (method === 'session.history') {
      historyCalls += 1;
      if (historyCalls === 1) return { events: [] };
      return {
        events: [
          { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
          {
            event: {
              seq: 2,
              type: 'user/message',
              data: { turn: 1, source: { rpcId: promptRpcId } },
            },
          },
          {
            event: {
              seq: 3,
              type: 'assistant/message',
              data: { turn: 1, message: { content: [{ type: 'text', text: '完成' }] } },
            },
          },
          { event: { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
        ],
      };
    }
    if (method === 'session.prompt') {
      promptRpcId = options.rpcId;
      return {};
    }
    throw new Error(`unexpected rpc ${method}`);
  };
  const responses = [];
  client.respond = async (message) => {
    responses.push(message);
    return { accepted: true };
  };

  const approvals = [];
  const pending = client.ask('session-1', '请发送', {
    onApproval: async (approval) => {
      approvals.push(approval);
      return 'allowed-once';
    },
  });

  const deadline = Date.now() + 2_000;
  while (instances.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(instances.length, 1);
  const socket = instances[0];
  assert.equal(socket.url, 'ws://127.0.0.1:3080/api/events.mux');

  socket.emit('open');
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.emit('message', { data: envelope('approval-rpc-other', 'session-other', 'approval-other') });
  socket.emit('message', { data: envelope('approval-rpc-1', 'session-1', 'approval-1') });
  await pending;

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].approvalId, 'approval-1');
  assert.equal(approvals[0].rpcId, 'approval-rpc-1');
  assert.deepEqual(responses, [{
    type: 'client-response',
    rpcId: 'approval-rpc-1',
    result: {
      ok: true,
      value: {
        sessionId: 'session-1',
        approvalId: 'approval-1',
        outcome: 'allowed-once',
      },
    },
  }]);
});

test('HarnessClient relays a question/requested mux frame and responds with the parsed answers', async () => {
  const instances = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }

    emit(type, event = {}) {
      for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close');
    }
  }

  const envelope = (rpcId, session) => JSON.stringify({
    type: 'server-request',
    rpcId,
    method: 'events.mux',
    payload: {
      type: 'question/requested',
      sessionId: session,
      questions: [
        { id: 'mode', question: '选择运行模式', options: [{ label: '快速' }, { label: '详细' }] },
      ],
    },
  });

  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    webSocketImpl: FakeWebSocket,
  });
  client.ensureRunning = async () => {};
  let promptRpcId = null;
  let historyCalls = 0;
  client.rpc = async (method, payload, _timeoutMs, options = {}) => {
    if (method === 'session.history') {
      historyCalls += 1;
      if (historyCalls === 1) return { events: [] };
      return {
        events: [
          { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
          {
            event: {
              seq: 2,
              type: 'user/message',
              data: { turn: 1, source: { rpcId: promptRpcId } },
            },
          },
          {
            event: {
              seq: 3,
              type: 'assistant/message',
              data: { turn: 1, message: { content: [{ type: 'text', text: '已确认' }] } },
            },
          },
          { event: { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
        ],
      };
    }
    if (method === 'session.prompt') {
      promptRpcId = options.rpcId;
      return {};
    }
    throw new Error(`unexpected rpc ${method}`);
  };
  const responses = [];
  client.respond = async (message) => {
    responses.push(message);
    return { accepted: true };
  };

  const questions = [];
  const pending = client.ask('session-1', '请选择', {
    onQuestion: async ({ questions: asked }) => {
      questions.push(asked);
      return { answers: [{ id: 'mode', selected: ['详细'] }] };
    },
  });

  const deadline = Date.now() + 2_000;
  while (instances.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(instances.length, 1);
  const socket = instances[0];

  socket.emit('open');
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.emit('message', { data: envelope('question-rpc-other', 'session-other') });
  socket.emit('message', { data: envelope('question-rpc-1', 'session-1') });
  await pending;

  assert.equal(questions.length, 1);
  assert.equal(questions[0][0].id, 'mode');
  assert.deepEqual(responses, [{
    type: 'client-response',
    rpcId: 'question-rpc-1',
    result: {
      ok: true,
      value: {
        sessionId: 'session-1',
        answer: { answers: [{ id: 'mode', selected: ['详细'] }] },
      },
    },
  }]);
});

test('HarnessClient responds to a question with a cancelled error when the user dismisses it', async () => {
  const instances = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }

    emit(type, event = {}) {
      for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close');
    }
  }

  const client = new HarnessClient({
    baseUrl: 'http://127.0.0.1:3080',
    workspace: '/tmp/default-workspace',
    webSocketImpl: FakeWebSocket,
  });
  client.ensureRunning = async () => {};
  let promptRpcId = null;
  let historyCalls = 0;
  client.rpc = async (method, payload, _timeoutMs, options = {}) => {
    if (method === 'session.history') {
      historyCalls += 1;
      if (historyCalls === 1) return { events: [] };
      return {
        events: [
          { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
          {
            event: {
              seq: 2,
              type: 'user/message',
              data: { turn: 1, source: { rpcId: promptRpcId } },
            },
          },
          {
            event: {
              seq: 3,
              type: 'assistant/message',
              data: { turn: 1, message: { content: [{ type: 'text', text: '已取消' }] } },
            },
          },
          { event: { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
        ],
      };
    }
    if (method === 'session.prompt') {
      promptRpcId = options.rpcId;
      return {};
    }
    throw new Error(`unexpected rpc ${method}`);
  };
  const responses = [];
  client.respond = async (message) => {
    responses.push(message);
    return { accepted: true };
  };

  const pending = client.ask('session-1', '请选择', {
    onQuestion: async () => ({ cancelled: true }),
  });

  const deadline = Date.now() + 2_000;
  while (instances.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(instances.length, 1);
  const socket = instances[0];

  socket.emit('open');
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.emit('message', {
    data: JSON.stringify({
      type: 'server-request',
      rpcId: 'question-rpc-2',
      method: 'events.mux',
      payload: {
        type: 'question/requested',
        sessionId: 'session-1',
        questions: [{ id: 'confirm', question: '确认继续？' }],
      },
    }),
  });
  await pending;

  assert.deepEqual(responses, [{
    type: 'client-response',
    rpcId: 'question-rpc-2',
    result: { ok: false, error: { code: 'cancelled' } },
  }]);
});
