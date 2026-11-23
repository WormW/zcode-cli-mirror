// 从真实 npm 全局安装目录验证 TUI，避免只检查 --version 漏掉运行时资源。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/verify-installed-tui.mjs /path/to/zcode');
const require = createRequire(new URL('../package.json', import.meta.url));
const pty = require('node-pty');
const terminal = pty.spawn(executable, [], {
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', NODE_PATH: '', NODE_OPTIONS: '' },
  cols: 110,
  rows: 32,
});
let screen = '';
let exited = false;
terminal.onData((data) => { screen += data; });
const exit = new Promise((resolve) => terminal.onExit((event) => { exited = true; resolve(event); }));
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const visible = stripVTControlCharacters(screen);
    if (/无法定位|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/.test(visible)) {
      throw new Error(`TUI startup failed:\n${visible}`);
    }
    if (/ZCode/.test(visible) && /(?:登录|\/login|输入提示词|Type a prompt)/i.test(visible)) break;
    if (exited) throw new Error(`TUI exited before initialization:\n${visible}`);
    await delay(200);
  }
  const visible = stripVTControlCharacters(screen);
  if (!/ZCode/.test(visible) || !/(?:登录|\/login|输入提示词|Type a prompt)/i.test(visible)) {
    throw new Error(`TUI initialization timed out:\n${visible}`);
  }
  terminal.write('\u0003');
  await delay(200);
  if (!exited) terminal.write('\u0003');
  const result = await Promise.race([exit, delay(8000).then(() => { throw new Error('TUI exit timed out'); })]);
  if (result.exitCode !== 0) throw new Error(`TUI exit code ${result.exitCode}:\n${stripVTControlCharacters(screen)}`);
  console.log('npm-installed TUI initialized and exited successfully');
} finally {
  if (!exited) terminal.kill();
}
