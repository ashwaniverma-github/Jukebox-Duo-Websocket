const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

test('shared packet bursts are throttled before Redis without per-packet revocation reads', async t => {
  let reads = 0, writes = 0, now = 1000;
  class Redis extends EventEmitter {
    status = 'ready';
    duplicate() { return new Redis(); }
    async connect() {}
    async subscribe() {}
    async mget() { reads++; return [null, null]; }
    async eval() { writes++; return 1; }
  }
  const output = {};
  // Exercise the actual compiled middleware with in-memory dependencies only.
  runInNewContext(readFileSync(require.resolve('../dist/services/sharedBackend'), 'utf8'), {
    exports: output,
    require: name => name === 'ioredis' ? Redis : name === '@socket.io/redis-adapter'
      ? { createAdapter: () => ({}) } : require('../dist/services/roomStore'),
    process: { env: { REALTIME_SHARED_ENABLED: 'true', SOCKET_REDIS_URL: 'redis://test' } },
    Date: { now: () => now }, setInterval, clearInterval,
  });
  let handshake, packet;
  const io = { adapter() {}, use(fn) { handshake = fn; } };
  await output.sharedBackend(io);
  const socket = new EventEmitter();
  socket.data = { userId: 'user', roomId: 'room', issuedAt: 1 };
  socket.use = fn => { packet = fn; };
  socket.disconnect = () => socket.emit('disconnect');
  t.after(() => socket.emit('disconnect'));
  await handshake(socket, error => assert.ifError(error));
  let delivered = 0;
  await Promise.all(Array.from({ length: 3000 }, () => packet([], () => delivered++)));
  assert.equal(reads, 1); // Handshake revocation check only.
  assert.equal(writes, 60);
  assert.equal(delivered, 60);
  now += 1000;
  await Promise.all(Array.from({ length: 100 }, () => packet([], () => delivered++)));
  assert.equal(writes, 80);
  assert.equal(delivered, 80);
  assert.equal(reads, 1);
});
