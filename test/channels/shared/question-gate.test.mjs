import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QuestionGate,
  answersFromReply,
  questionPromptText,
} from '../../../src/channels/shared/question-gate.mjs';

const optioned = [{ id: 'mode', question: '选择运行模式', options: [{ label: '快速' }, { label: '详细' }] }];

test('answersFromReply maps option numbers and labels to option labels', () => {
  assert.deepEqual(answersFromReply(optioned, '2'), { answers: [{ id: 'mode', selected: ['详细'] }] });
  assert.deepEqual(answersFromReply(optioned, '详细'), { answers: [{ id: 'mode', selected: ['详细'] }] });
  assert.equal(
    answersFromReply(
      [{ id: 'a', question: 'a', options: [{ label: 'A' }, { label: 'B' }] }, { id: 'b', question: 'b', options: [{ label: 'C' }, { label: 'D' }] }],
      'X',
    ),
    null,
  );
});

test('answersFromReply honors free text as a custom answer while a single optioned question is pending', () => {
  assert.deepEqual(
    answersFromReply(optioned, '我自己想回复的内容'),
    { answers: [{ id: 'mode', selected: [], custom: '我自己想回复的内容' }] },
  );
  assert.equal(answersFromReply([...optioned, { id: 'other', question: '第二个' }], '自定义文本'), null);
});

test('answersFromReply supports multi-select and open questions', () => {
  const multi = [{ id: 'tags', question: '选择标签', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }];
  assert.deepEqual(answersFromReply(multi, '1,3'), { answers: [{ id: 'tags', selected: ['A', 'C'] }] });
  assert.equal(answersFromReply(multi, '1,1'), null);

  const open = [{ id: 'path', question: '输入绝对路径' }];
  assert.deepEqual(answersFromReply(open, '/tmp/demo'), { answers: [{ id: 'path', selected: [], custom: '/tmp/demo' }] });
  assert.equal(answersFromReply([...optioned, { id: 'path', question: '输入路径' }], '/tmp/demo'), null);
});

test('answersFromReply cancels on dismiss words', () => {
  for (const text of ['取消', 'cancel']) {
    assert.deepEqual(answersFromReply(optioned, text), { cancelled: true }, text);
  }
});

test('QuestionGate relays a numbered prompt and resolves an option-number reply', async () => {
  const gate = new QuestionGate({ logger: { error() {} } });
  const sent = [];
  const pending = gate.request({
    key: 'p2p:user',
    questions: optioned,
    language: 'zh',
    sendPrompt: async (prompt) => sent.push(prompt),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /选择运行模式/);
  assert.match(sent[0], /1\. 快速/);
  assert.match(sent[0], /2\. 详细/);
  assert.match(sent[0], /取消/);

  const consumed = gate.tryResolve({ key: 'p2p:user', text: '2' });
  assert.equal(consumed, true);
  assert.deepEqual(await pending, { answers: [{ id: 'mode', selected: ['详细'] }] });
});

test('QuestionGate resolves an open question with free text and dismisses with cancel', async () => {
  const gate = new QuestionGate({ logger: { error() {} } });
  const sent = [];
  const pending = gate.request({
    key: 'p2p:user',
    questions: [{ id: 'path', question: '输入绝对路径' }],
    language: 'zh',
    sendPrompt: async (prompt) => sent.push(prompt),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(sent[0], /请直接回复你的答案/);

  assert.equal(gate.tryResolve({ key: 'p2p:user', text: '/tmp/demo' }), true);
  assert.deepEqual(await pending, { answers: [{ id: 'path', selected: [], custom: '/tmp/demo' }] });

  const cancelled = gate.request({
    key: 'p2p:user',
    questions: optioned,
    language: 'zh',
    sendPrompt: async () => {},
  });
  assert.equal(gate.tryResolve({ key: 'p2p:user', text: '取消' }), true);
  assert.deepEqual(await cancelled, { cancelled: true });
});

test('QuestionGate aborts a pending question when its signal fires', async () => {
  const gate = new QuestionGate({ logger: { error() {} } });
  const controller = new AbortController();
  const pending = gate.request({
    key: 'p2p:user',
    questions: optioned,
    language: 'zh',
    signal: controller.signal,
    sendPrompt: async () => {},
  });
  controller.abort();
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(gate.tryResolve({ key: 'p2p:user', text: '1' }), false);
});