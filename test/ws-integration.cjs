/**
 * Integration tests for the realtime auth + sync-replay logic.
 *
 * Spins up the built server (dist/index.js) with a known SOCKET_JWT_SECRET, then drives
 * it with crafted tokens via socket.io-client to verify:
 *   - connections require a valid, unexpired, correctly-signed token
 *   - a token is bound to exactly one room
 *   - live events only flow when the room is sync-eligible (host premium)
 *   - presence identity comes from the token, not the client payload (no impersonation)
 *   - sync-request replays the live position to a (re)joiner, advancing a playing track
 *   - replay is skipped when the client is on a different video
 *
 * Run: npm run build && node test/ws-integration.cjs
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const SECRET = 'test-secret-please-ignore-0123456789abcdef';
const PORT = 4555;
const URL = `http://localhost:${PORT}`;
const SOCKET_PATH = '/api/socket';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const openSockets = [];

function pass(label) { passed++; console.log(`  PASS  ${label}`); }
function fail(label, detail) { failed++; console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`); }

function mint(payload, opts = {}) {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '5m', ...opts });
}

function newSocket(token) {
  const socket = io(URL, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: token ? { token } : {},
    reconnection: false,
    timeout: 4000,
    forceNew: true,
  });
  openSockets.push(socket);
  return socket;
}

// Resolve with the socket on connect; reject on connect_error.
function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = newSocket(token);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

// Resolve with the first event payload, or null after `ms`.
function waitFor(socket, event, ms = 1500) {
  return new Promise((resolve) => {
    const handler = (data) => { clearTimeout(timer); socket.off(event, handler); resolve(data ?? true); };
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
    socket.on(event, handler);
  });
}

async function expectRejected(label, token) {
  try {
    await connect(token);
    fail(label, 'expected connection to be rejected but it succeeded');
  } catch {
    pass(label);
  }
}

function waitHealthy(retries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(`${URL}/healthz`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry(n);
      });
      req.on('error', () => retry(n));
    };
    const retry = (n) => (n <= 0 ? reject(new Error('server never became healthy')) : setTimeout(() => attempt(n - 1), 100));
    attempt(retries);
  });
}

async function run() {
  // ---- Auth gate ----
  await expectRejected('rejects connection with NO token', undefined);
  await expectRejected('rejects connection with a malformed token', 'not-a-jwt');
  await expectRejected('rejects token signed with the WRONG secret', jwt.sign({ sub: 'u', roomId: 'R' }, 'wrong-secret', { algorithm: 'HS256', expiresIn: '5m' }));
  await expectRejected('rejects an EXPIRED token', jwt.sign({ sub: 'u', roomId: 'R', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { algorithm: 'HS256' }));

  try {
    const s = await connect(mint({ sub: 'userValid', roomId: 'Rok', syncEligible: true }));
    pass('accepts a valid token');
    s.close();
  } catch (e) {
    fail('accepts a valid token', e && e.message);
  }

  // ---- Live events flow when sync-eligible (host premium) ----
  {
    const a = await connect(mint({ sub: 'userA', roomId: 'Rbcast', syncEligible: true }));
    const b = await connect(mint({ sub: 'userB', roomId: 'Rbcast', syncEligible: true }));
    a.emit('join-room', 'Rbcast');
    b.emit('join-room', 'Rbcast');
    await sleep(200);
    const got = waitFor(b, 'sync-command');
    a.emit('sync-command', { roomId: 'Rbcast', cmd: 'play', timestamp: Date.now() + 200, seekTime: 5 });
    const res = await got;
    if (res && res.cmd === 'play' && res.seekTime === 5) pass('eligible room: sync-command is broadcast to the other member');
    else fail('eligible room: sync-command is broadcast to the other member', JSON.stringify(res));
    a.close(); b.close();
  }

  // ---- Live events DROPPED when NOT sync-eligible (free host) ----
  {
    const e = await connect(mint({ sub: 'userE', roomId: 'Rfree', syncEligible: false }));
    const f = await connect(mint({ sub: 'userF', roomId: 'Rfree', syncEligible: false }));
    e.emit('join-room', 'Rfree');
    f.emit('join-room', 'Rfree');
    await sleep(200);
    const got = waitFor(f, 'sync-command', 800);
    e.emit('sync-command', { roomId: 'Rfree', cmd: 'play', timestamp: Date.now() + 200, seekTime: 3 });
    const res = await got;
    if (res === null) pass('ineligible room: sync-command is NOT broadcast (paywall enforced server-side)');
    else fail('ineligible room: sync-command is NOT broadcast', JSON.stringify(res));
    e.close(); f.close();
  }

  // ---- Token bound to one room: cannot act in another room ----
  {
    const a = await connect(mint({ sub: 'userA2', roomId: 'Rbind1', syncEligible: true }));
    const c = await connect(mint({ sub: 'userC', roomId: 'Rbind2', syncEligible: true }));
    c.emit('join-room', 'Rbind2');
    a.emit('join-room', 'Rbind2'); // should be rejected: token is for Rbind1
    await sleep(200);
    const got = waitFor(c, 'sync-command', 800);
    a.emit('sync-command', { roomId: 'Rbind2', cmd: 'play', timestamp: Date.now() + 200, seekTime: 9 });
    const res = await got;
    if (res === null) pass('token bound to one room: cannot join/emit into a different room');
    else fail('token bound to one room: cannot join/emit into a different room', JSON.stringify(res));
    a.close(); c.close();
  }

  // ---- Presence identity comes from the token, not the client payload ----
  {
    const a = await connect(mint({ sub: 'userReal', roomId: 'Rimp', syncEligible: true, name: 'Real Name' }));
    const b = await connect(mint({ sub: 'userWatcher', roomId: 'Rimp', syncEligible: true }));
    a.emit('join-room', 'Rimp');
    b.emit('join-room', 'Rimp');
    await sleep(150);
    const got = waitFor(b, 'room-presence');
    // Client tries to impersonate someone else:
    a.emit('presence-join', { roomId: 'Rimp', user: { id: 'HACKER', name: 'Spoofed' } });
    const list = await got;
    const ids = Array.isArray(list) ? list.map((m) => m.id) : [];
    if (ids.includes('userReal') && !ids.includes('HACKER')) pass('presence uses verified token identity (impersonation blocked)');
    else fail('presence uses verified token identity (impersonation blocked)', JSON.stringify(list));
    a.close(); b.close();
  }

  // ---- sync-request replays current state to a (re)joiner, advancing a playing track ----
  {
    const a = await connect(mint({ sub: 'userA3', roomId: 'Rreplay', syncEligible: true }));
    a.emit('join-room', 'Rreplay');
    await sleep(100);
    a.emit('sync-command', { roomId: 'Rreplay', cmd: 'play', timestamp: Date.now() + 200, seekTime: 10 });
    await sleep(500); // let ~0.5s elapse so the replay should advance past 10
    const g = await connect(mint({ sub: 'userG', roomId: 'Rreplay', syncEligible: true }));
    g.emit('join-room', 'Rreplay');
    await sleep(100);
    const got = waitFor(g, 'sync-command');
    g.emit('sync-request', { roomId: 'Rreplay' });
    const res = await got;
    if (res && res.cmd === 'play' && res.seekTime >= 10) pass(`sync-request replays live position, advanced for play (seek=${res.seekTime.toFixed(2)})`);
    else fail('sync-request replays live position', JSON.stringify(res));
    a.close(); g.close();
  }

  // ---- sync-request is skipped when the client is on a different video ----
  {
    const a = await connect(mint({ sub: 'userA4', roomId: 'Rvid', syncEligible: true }));
    a.emit('join-room', 'Rvid');
    await sleep(100);
    a.emit('change-video', { roomId: 'Rvid', newVideoId: 'VID_X' }); // server now tracks VID_X
    await sleep(150);
    const h = await connect(mint({ sub: 'userH', roomId: 'Rvid', syncEligible: true }));
    h.emit('join-room', 'Rvid');
    await sleep(100);

    const gotMismatch = waitFor(h, 'sync-command', 800);
    h.emit('sync-request', { roomId: 'Rvid', videoId: 'VID_Y' }); // wrong video
    const mismatch = await gotMismatch;
    if (mismatch === null) pass('sync-request skipped on video mismatch (no wrong-song seek)');
    else fail('sync-request skipped on video mismatch', JSON.stringify(mismatch));

    const gotMatch = waitFor(h, 'sync-command', 1200);
    h.emit('sync-request', { roomId: 'Rvid', videoId: 'VID_X' }); // correct video
    const match = await gotMatch;
    if (match && match.cmd) pass('sync-request replays when video matches');
    else fail('sync-request replays when video matches', JSON.stringify(match));
    a.close(); h.close();
  }
}

(async () => {
  console.log('Building is assumed done. Starting server on port', PORT, '...');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), SOCKET_JWT_SECRET: SECRET, NODE_ENV: 'test', FRONTEND_URL: 'http://localhost:3000' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  let exitCode = 1;
  try {
    await waitHealthy();
    console.log('Server healthy. Running tests...\n');
    await run();
    console.log(`\n${passed} passed, ${failed} failed`);
    exitCode = failed === 0 ? 0 : 1;
  } catch (err) {
    console.error('Test harness error:', err);
    exitCode = 1;
  } finally {
    for (const s of openSockets) { try { s.close(); } catch {} }
    server.kill();
    setTimeout(() => process.exit(exitCode), 300);
  }
})();
