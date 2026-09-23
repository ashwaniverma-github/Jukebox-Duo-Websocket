const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
test('interrupting Redis setup stops its active command before cleanup', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-shared-runner-'));
  const log = path.join(dir, 'events'); fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(dir, 'docker'), `#!/usr/bin/env node
    const fs = require('node:fs');
    const log = value => fs.appendFileSync(process.env.SHARED_RUNNER_LOG, value + String.fromCharCode(10));
    if (process.argv[2] === 'run') {
      process.on('SIGTERM', () => { log('command-stopped'); process.exit(0); });
      log('command-started'); setInterval(() => {}, 1000);
    } else if (process.argv[2] === 'rm') log('container-cleanup');
  `, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(__dirname, 'shared-integration.cjs')], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, SHARED_RUNNER_LOG: log }, stdio: 'ignore',
  });
  const done = new Promise(resolve => child.once('close', resolve));
  try {
    for (let i = 0; i < 100 && !fs.readFileSync(log, 'utf8').includes('command-started'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(fs.readFileSync(log, 'utf8'), /command-started/);
    child.kill('SIGTERM');
    assert.equal(await done, 143);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(events, ['command-started', 'command-stopped', 'container-cleanup']);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});
