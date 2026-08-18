import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApprovalGate,
  approvalOutcomeFromText,
  approvalPromptText,
  detectMessageLanguage,
  isApprovalReplyText,
} from '../../../src/channels/shared/approval-gate.mjs';

test('approval reply recognition covers Chinese and English generic answers', () => {
  for (const approve of ['同意', '批准', '允许', '确认', '是', '好的', '可以', '行', 'ok', 'OK', 'yes', 'Yes', 'y', 'approve', 'sure']) {
    assert.equal(approvalOutcomeFromText(approve), 'allowed-once', approve);
  }
  for (const reject of ['拒绝', '不同意', '取消', '否', '不行', '不要', '不可以', 'no', 'No', 'n', 'deny', 'reject', 'cancel']) {
    assert.equal(approvalOutcomeFromText(reject), 'rejected', reject);
  }
  for (const notAnswer of ['你好', '继续', '请发送', 'maybe', 'agree to all', '']) {
    assert.equal(approvalOutcomeFromText(notAnswer), null, notAnswer);
  }
  assert.equal(isApprovalReplyText('同意'), true);
  assert.equal(isApprovalReplyText('继续'), false);
});

test('language detection switches approval prompts between Chinese and English', () => {
  assert.equal(detectMessageLanguage('帮我发一条消息'), 'zh');
  assert.equal(detectMessageLanguage('Send a message'), 'en');
  assert.equal(detectMessageLanguage(''), 'en');

  const zh = approvalPromptText({ language: 'zh', approval: { reason: '会发送消息', toolName: 'send_msg' } });
  assert.match(zh, /需要你审批/);
  assert.match(zh, /原因：会发送消息/);
  assert.match(zh, /同意/);
  assert.match(zh, /拒绝/);

  const en = approvalPromptText({ language: 'en', approval: { reason: 'sends a message', toolName: 'send_msg' } });
  assert.match(en, /Approval required/);
  assert.match(en, /Reason: sends a message/);
  assert.match(en, /yes/);
  assert.match(en, /no/);
});

test('ApprovalGate relays an approval prompt and resolves an approve reply', async () => {
  const gate = new ApprovalGate({ logger: { error() {} } });
  const sent = [];
  const pending = gate.request({
    key: 'direct:user',
    approval: { reason: 'This control can send a message.' },
    language: 'zh',
    sendPrompt: async (prompt) => sent.push(prompt),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /需要你审批/);

  const consumed = gate.tryResolve({ key: 'direct:user', text: '同意' });
  assert.equal(consumed, true);
  assert.equal(await pending, 'allowed-once');
});

test('ApprovalGate resolves a reject reply without matching ordinary chat', async () => {
  const gate = new ApprovalGate({ logger: { error() {} } });
  const pending = gate.request({
    key: 'group:g',
    approval: { reason: 'delete files' },
    sendPrompt: async () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(gate.tryResolve({ key: 'group:g', text: '继续' }), false);
  assert.equal(gate.tryResolve({ key: 'group:g', text: '拒绝' }), true);
  assert.equal(await pending, 'rejected');
});

test('ApprovalGate cancels on abort and on send failure', async () => {
  const controller = new AbortController();
  const gate = new ApprovalGate({ logger: { error() {} } });
  const pending = gate.request({
    key: 'direct:u',
    approval: { signal: controller.signal, reason: 'risky' },
    sendPrompt: async () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  assert.equal(await pending, 'cancelled');
  assert.equal(gate.tryResolve({ key: 'direct:u', text: '同意' }), false);

  const failed = gate.request({
    key: 'direct:v',
    approval: { reason: 'risky' },
    sendPrompt: async () => { throw new Error('network down'); },
  });
  assert.equal(await failed, 'cancelled');
});

test('ApprovalGate marks the approval reply as seen and ignores late replies after cancel', async () => {
  const gate = new ApprovalGate({ logger: { error() {} } });
  const seen = [];
  const pending = gate.request({
    key: 'direct:x',
    approval: { reason: 'risky' },
    sendPrompt: async () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  gate.cancelFor('direct:x');
  assert.equal(await pending, 'cancelled');
  assert.equal(gate.tryResolve({
    key: 'direct:x',
    text: '同意',
    messageId: 'late-reply',
    markSeen: async (id) => seen.push(id),
  }), false);
  assert.deepEqual(seen, []);

  const seenAgain = [];
  const second = gate.request({
    key: 'direct:y',
    approval: { reason: 'risky' },
    sendPrompt: async () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gate.tryResolve({
    key: 'direct:y',
    text: 'no',
    messageId: 'reply-2',
    markSeen: async (id) => seenAgain.push(id),
  }), true);
  assert.equal(await second, 'rejected');
  assert.deepEqual(seenAgain, ['reply-2']);
});