import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WecomStateStore } from '../../../src/channels/wecom/state-store.mjs';

test('Enterprise WeChat state store persists interaction routes; clearSession keeps routes, clearSessions clears them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wecom-routes-'));
  const path = join(root, 'account', 'state.json');
  const state = await new WecomStateStore(path).load();
  await state.setSession('direct:user', 'session-1');
  await state.setRoute('direct:user', {
    sessionId: 'session-1',
    actor: 'user',
    chatId: 'user',
    requiresMention: false,
    updatedAt: 20,
  });

  const restored = await new WecomStateStore(path).load();
  assert.deepEqual(restored.routeFor('direct:user'), {
    sessionId: 'session-1',
    actor: 'user',
    chatId: 'user',
    requiresMention: false,
    updatedAt: 20,
  });

  await restored.clearSession('direct:user');
  assert.equal(restored.sessionFor('direct:user'), null);
  assert.equal(restored.routeFor('direct:user')?.sessionId, 'session-1', '/new should not remove forwarding routes');

  await restored.clearSessions();
  assert.equal(restored.routeFor('direct:user'), null, 'workspace-wide clearing should remove routes');
});
