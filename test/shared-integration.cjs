const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { io } = require('socket.io-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const commands = new Set();
function exec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    commands.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { commands.delete(child); reject(error); });
    child.once('close', code => {
      commands.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${file} exited with ${code}`));
    });
  });
}
const secret = 'isolated-realtime-regression-secret';
const name = `jukebox-redis-test-${process.pid}-${Date.now()}`;
const processes = [], sockets = [];
let redis, cleaning;
function cleanup() {
  return cleaning ??= (async () => {
    sockets.forEach(socket => socket.close());
    // Stop active Docker/test commands as well as workers BEFORE removing Redis.
    const children = [...processes, ...commands];
    const signal = (child, sig) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (commands.has(child) && process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already exited */ }
    };
    children.forEach(child => signal(child, 'SIGTERM'));
    const killTimer = setTimeout(() => children.forEach(child => {
      if (child.exitCode === null && child.signalCode === null) signal(child, 'SIGKILL');
    }), 5000);
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve))));
    clearTimeout(killTimer);
    redis?.disconnect();
    await exec('docker', ['rm', '-f', name]).catch(() => {});
  })();
}
process.once('SIGTERM', () => { void cleanup().then(() => process.exit(143)); });
process.once('SIGINT', () => { void cleanup().then(() => process.exit(130)); });
async function worker(url) {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '../dist/index.js')], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', SOCKET_JWT_SECRET: secret, REALTIME_SHARED_ENABLED: 'true', SOCKET_REDIS_URL: url, REDIS_URL: '', FRONTEND_URL: 'http://localhost:3000' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  processes.push(child);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Worker exited before readiness');
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.ok).catch(() => false)) return port;
    await sleep(100);
  }
  throw new Error('Worker not ready');
}
function token(user, isHost = false) {
  return jwt.sign({ sub: user, roomId: 'room', syncEligible: true, isHost, issuedAt: Date.now() }, secret, { expiresIn: 300 });
}
function connect(port, auth) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, { path: '/api/socket', transports: ['websocket'], auth: { token: auth }, reconnection: false, timeout: 3000 });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket)); socket.once('connect_error', reject);
  });
}
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, onEvent); reject(new Error(`Missing ${name}`)); }, 4000);
    const onEvent = data => { clearTimeout(timer); resolve(data); };
    socket.once(name, onEvent);
  });
}
(async () => {
  try {
    await exec('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::6379', 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
    const mapping = (await exec('docker', ['port', name, '6379'])).stdout;
    const port = mapping.match(/127\.0\.0\.1:(\d+)/)?.[1]; assert.ok(port);
    const url = `redis://127.0.0.1:${port}`;
    redis = new Redis(url); await redis.ping();
    const [p1, p2] = await Promise.all([worker(url), worker(url)]);
    const oldToken = token('host', true);
    const a = await connect(p1, oldToken), b = await connect(p2, token('guest'));
    a.emit('join-room', 'room'); b.emit('join-room', 'room'); await sleep(150);
    const command = event(b, 'sync-command');
    a.emit('sync-command', { roomId: 'room', videoId: 'VIDEO', queueItemId: 'Q1', cmd: 'play', seekTime: 20, timestamp: Date.now() });
    const sent = await command; assert.equal(sent.queueItemId, 'Q1'); assert.equal(sent.revision, 1);
    console.log('PASS cross-worker playback broadcast');
    const replay = event(b, 'sync-command'); b.emit('sync-request', { roomId: 'room', videoId: 'VIDEO', queueItemId: 'Q1' });
    assert.equal((await replay).revision, sent.revision); console.log('PASS shared playback replay');
    const presence = event(b, 'room-presence'); a.emit('presence-join', { roomId: 'room', user: { id: 'spoofed' } });
    const members = await presence;
    assert.ok(members.some(m => m.id === 'host')); assert.ok(members.some(m => m.id === 'guest'));
    console.log('PASS cross-worker verified presence');
    const shuffle = event(b, 'shuffle-changed'); a.emit('shuffle-changed', { roomId: 'room', shuffle: true }); assert.equal(await shuffle, true);
    const replayShuffle = event(b, 'shuffle-changed'); b.emit('presence-join', { roomId: 'room', user: { id: 'guest' } }); assert.equal(await replayShuffle, true);
    console.log('PASS shared host settings');
    const invalidated = [event(a, 'queue-invalidated'), event(b, 'queue-invalidated')];
    await redis.publish('jukebox:events', JSON.stringify({ roomId: 'room' })); await Promise.all(invalidated);
    console.log('PASS backend invalidation reaches both workers');
    const { RoomStore } = require('../dist/services/roomStore');
    const stores = [new RoomStore(redis), new RoomStore(redis)];
    const writes = await Promise.all(Array.from({ length: 30 }, (_, i) => stores[i % 2].playback('race', { cmd: 'play', seekTime: i, timestamp: Date.now() })));
    assert.equal(new Set(writes.map(w => w.revision)).size, 30);
    assert.equal((await stores[0].get('race', 'playback')).revision, 30);
    assert.ok(await redis.ttl('jukebox:room:race:playback') > 0);
    const previousGeneration = (await stores[0].get('race', 'playback')).generation;
    await redis.del('jukebox:room:race:playback');
    const restarted = await stores[1].playback('race', { cmd: 'pause', seekTime: 0, timestamp: Date.now() });
    assert.notEqual(restarted.generation, previousGeneration); assert.equal(restarted.revision, 1);
    console.log('PASS atomic shared sequencing, expiry, and generation recovery');
    const disconnected = event(a, 'disconnect');
    await redis.set('jukebox:revoked:user:host', String(Date.now()), 'EX', 305);
    await redis.publish('jukebox:events', JSON.stringify({ userId: 'host', revoke: true }));
    assert.equal(await disconnected, 'io server disconnect'); await assert.rejects(connect(p2, oldToken)); assert.equal(b.connected, true);
    await sleep(10); (await connect(p2, token('host', true))).close();
    console.log('PASS targeted revocation rejects old tokens and accepts freshly authorized tokens');
    console.log('7 shared integration checks passed');
    const frontend = path.resolve(__dirname, '../../music-duo');
    const limits = await exec(process.execPath, [path.join(frontend, 'node_modules/tsx/dist/cli.mjs'), '--test', path.join(frontend, 'test/request-limit.test.ts')], {
      cwd: frontend, env: { ...process.env, TEST_REDIS_URL: url, REDIS_URL: url, REALTIME_SHARED_ENABLED: 'false' },
    });
    process.stdout.write(limits.stdout);
  } finally { await cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
