// 从真实安装入口验证版本和 TUI；PTY 依赖由独立验证环境提供，不属于发布产物。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);

export async function verifyInstalledTui(
  executable,
  { expectedVersion = process.env.ZCODE_CLI_EXPECTED_VERSION, verificationRoot } = {},
) {
  executable = resolve(executable);
  const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", TERM: "xterm-256color" };
  const version = await exec(executable, ["--version"], { env, timeout: 15000 });
  if (expectedVersion) {
    assert.equal(
      version.stdout.trim(),
      expectedVersion,
      `Installed CLI version does not match ${expectedVersion}`,
    );
  }

  const dependencyRoot = verificationRoot ?? process.env.ZCODE_CLI_VERIFY_ROOT;
  assert.ok(dependencyRoot, "Set ZCODE_CLI_VERIFY_ROOT to the isolated node-pty installation");
  const require = createRequire(join(dependencyRoot, "package.json"));
  const pty = require("node-pty");
  if (process.platform === "darwin") {
    // Bug 原因：npm prebuild 中的 spawn-helper 可能为 0644，macOS posix_spawnp 必须执行它；只修验证依赖，不改发布包。
    await chmod(
      join(
        dirname(require.resolve("node-pty/package.json")),
        "prebuilds",
        `darwin-${process.arch}`,
        "spawn-helper",
      ),
      0o755,
    );
  }
  const realExecutable = await realpath(executable);
  // Unix 直接执行 npm bin 会经过符号链接和 shebang；版本检查已验证该入口，PTY 用同一 JS 文件排除平台进程差异。
  const useNode = process.platform !== "win32";
  const terminal = pty.spawn(
    useNode ? process.execPath : executable,
    useNode ? [realExecutable] : [],
    {
      cwd: dependencyRoot,
      env,
      cols: 110,
      rows: 32,
    },
  );
  let screen = "";
  let exited = false;
  terminal.onData((data) => {
    screen += data;
  });
  const exit = new Promise((done) =>
    terminal.onExit((event) => {
      exited = true;
      done(event);
    }),
  );
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const visible = stripVTControlCharacters(screen);
      if (/无法定位|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/.test(visible)) {
        throw new Error(`TUI startup failed:\n${visible}`);
      }
      if (/ZCode/.test(visible) && /(?:登录|\/login|输入提示词|Type a prompt)/i.test(visible)) {
        break;
      }
      if (exited) throw new Error(`TUI exited before initialization:\n${visible}`);
      await delay(200);
    }
    const visible = stripVTControlCharacters(screen);
    assert.match(visible, /ZCode/);
    assert.match(visible, /(?:登录|\/login|输入提示词|Type a prompt)/i);
    assert.match(
      screen,
      /\x1b\]7501;state=(?:idle|blocked:kind=auth):app=[^\x1b\x07]+(?:\x1b\\|\x07)/,
      "Installed TUI did not emit initial OSC 7501 status",
    );
    terminal.write("\u0003");
    await delay(200);
    if (!exited) terminal.write("\u0003");
    const result = await Promise.race([
      exit,
      delay(8000).then(() => {
        throw new Error("TUI keyboard exit timed out");
      }),
    ]);
    assert.equal(result.exitCode, 0, stripVTControlCharacters(screen));
    assert.match(
      screen,
      /\x1b\]7501;state=clear(?::[^\x1b\x07]*)?(?:\x1b\\|\x07)/,
      "Installed TUI did not emit OSC 7501 clear on exit",
    );
    console.log("Installed CLI version, real TUI initialization, OSC 7501 status and keyboard exit passed");
  } finally {
    if (!exited) terminal.kill();
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  if (!process.argv[2]) {
    throw new Error("Usage: node scripts/verify-installed-tui.mjs /path/to/zcode");
  }
  await verifyInstalledTui(process.argv[2]);
}
