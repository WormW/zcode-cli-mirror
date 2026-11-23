// 从官方完整发行包验证 CLI；不启动 Web，也不发送 prompt 或调用模型。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify, stripVTControlCharacters } from 'node:util';

const exec = promisify(execFile);
const archive = process.argv[2];
assert.ok(archive, 'Usage: node scripts/smoke-cli-distribution.mjs <archive.tar.gz>');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'zcode-cli-smoke-')));
const root = join(directory, 'zcode');
const runner = join(root, 'bin/zcode.mjs');
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', TERM: 'xterm-256color' };
let terminal;
try {
  await exec('tar', ['-xzf', resolve(archive), '-C', directory]);
  await exec(process.execPath, [runner, '--version'], { cwd: directory, env });
  const require = createRequire(join(root, 'package.json'));
  const pty = require('node-pty');
  terminal = pty.spawn(process.execPath, [runner], { cwd: directory, env, cols: 110, rows: 32 });
  let screen = '';
  let terminalExit;
  terminal.onData((data) => { screen += data; });
  const tuiExited = new Promise((done) => terminal.onExit((event) => { terminalExit = event; done(event); }));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const visible = stripVTControlCharacters(screen);
    if (/无法定位|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/.test(visible)) {
      throw new Error(`TUI startup failed:\n${visible}`);
    }
    if (/ZCode/.test(visible) && /(?:登录|\/login|输入提示词|Type a prompt)/i.test(visible)) break;
    if (terminalExit) throw new Error(`TUI exited before initialization:\n${visible}`);
    await setTimeout(200);
  }
  const visible = stripVTControlCharacters(screen);
  assert.match(visible, /ZCode/);
  assert.match(visible, /(?:登录|\/login|输入提示词|Type a prompt)/i);
  terminal.write('\u0003');
  await setTimeout(200);
  if (!terminalExit) terminal.write('\u0003');
  const tuiExit = await Promise.race([
    tuiExited,
    setTimeout(8000).then(() => { throw new Error('TUI keyboard exit timed out'); }),
  ]);
  assert.equal(tuiExit.exitCode, 0, visible);
  terminal = undefined;
  console.log('CLI distribution: --version, real TUI initialization and keyboard exit passed; Web not tested');
} finally {
  terminal?.kill();
  await rm(directory, { recursive: true, force: true });
}
