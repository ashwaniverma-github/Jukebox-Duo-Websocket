const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RoomStore } = require('../dist/services/roomStore');

test('full local store evicts oldest writes and keeps new-room playback working', async () => {
  const store = new RoomStore();
  const command = { cmd: 'play', seekTime: 0, timestamp: 1 };
  const old = await store.playback('old', command);
  for (let i = 0; i < 9999; i++) await store.set(String(i), 'theme', 'default');
  await store.set('0', 'theme', 'love'); // Refresh an existing entry at capacity.
  await store.playback('new', command);
  assert.equal(await store.get('old', 'playback'), undefined);
  assert.equal((await store.get('new', 'playback')).cmd, 'play');
  const restored = await store.playback('old', command);
  assert.equal(restored.revision, 1);
  assert.notEqual(restored.generation, old.generation);
  assert.equal(await store.get('1', 'theme'), undefined);
  assert.equal(await store.get('0', 'theme'), 'love');
  assert.equal(store.local.size, 10000);
});
