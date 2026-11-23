import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { formatOsc7501, wrapRunTuiWithOsc7501 } from "../cli-mirror/osc7501-tui-wrapper.mjs";
import { assembleCliRelease } from "../package-cli-release.mjs";
import { verifyInstalledTui } from "../verify-installed-tui.mjs";

const exec = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function fixture(t, { upstreamNativeOsc7501 = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-cli-release-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "upstream");
  const output = join(directory, "stage/zcode");
  const dist = join(source, "apps/zcode-cli/packages/cli/dist");
  await mkdir(join(dist, "provider"), { recursive: true });
  await mkdir(join(source, "apps/zcode-cli/docs/usage"), { recursive: true });
  await mkdir(join(source, "packages/web/dist"), { recursive: true });
  await mkdir(join(source, "packages/server/dist"), { recursive: true });
  if (upstreamNativeOsc7501) {
    await mkdir(join(source, "apps/zcode-cli/packages/tui/src"), { recursive: true });
    await writeFile(
      join(source, "apps/zcode-cli/packages/tui/src/program-status.ts"),
      'export const OSC_7501_PREFIX = "\\x1b]7501;";\n',
    );
  }
  await writeFile(join(source, "mise.toml"), '[tools]\nnode = "24.14.0"\npnpm = "10.33.2"\n');
  await writeFile(join(source, "LICENSE"), "fixture license\n");
  await writeFile(join(source, "apps/zcode-cli/docs/usage/index.md"), "usage\n");
  await writeFile(join(dist, "provider/zcode-builtin.json"), "{}\n");
  await writeFile(join(dist, "THIRD-PARTY-NOTICES.md"), "notices\n");
  await writeFile(join(source, "packages/web/dist/index.html"), "must not ship\n");
  await writeFile(join(source, "packages/server/dist/entry-http.js"), "must not ship\n");
  await writeFile(
    join(dist, "zcode.cjs"),
    `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), entry: process.argv[1] }));
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE || 0);
`,
  );
  const readme = join(directory, "MIRROR.md");
  await writeFile(readme, "CLI-only fixture\n");
  await assembleCliRelease({
    sourceRoot: source,
    outputDirectory: output,
    name: "@fixture/zcode-cli",
    version: "1.2.3-mirror.4",
    readme,
    repository: "git+https://github.com/example/zcode-cli.git",
    stageRuntime: async ({ outputDirectory }) => {
      await mkdir(join(outputDirectory, "agent/node_modules/@zcode/tui/dist"), { recursive: true });
      await writeFile(
        join(outputDirectory, "agent/node_modules/@zcode/tui/package.json"),
        `${JSON.stringify(
          {
            name: "@zcode/tui",
            version: "0.1.0",
            type: "module",
            main: "./dist/index.js",
            exports: { ".": { import: "./dist/index.js" } },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(outputDirectory, "agent/node_modules/@zcode/tui/dist/index.js"),
        `export const EXTRA_EXPORT = "kept";
export async function runTui(options) {
  await options.loadStartupOptions?.();
  return 0;
}
`,
      );
      await mkdir(join(outputDirectory, "agent/node_modules/@napi-rs/keyring"), {
        recursive: true,
      });
      await writeFile(
        join(outputDirectory, "agent/node_modules/@napi-rs/keyring/package.json"),
        '{"name":"@napi-rs/keyring","version":"2.1.2"}\n',
      );
    },
  });
  return { directory, output };
}

const missing = async (path) => {
  await assert.rejects(stat(path), { code: "ENOENT" });
};

test("CLI-only assembly preserves Agent arguments and distribution version", async (t) => {
  const { directory, output } = await fixture(t);
  const bin = join(output, "bin/zcode");
  const version = await exec(process.execPath, [bin, "--version"]);
  assert.equal(version.stdout.trim(), "1.2.3-mirror.4");

  for (const args of [[], ["--web"], ["--prompt", "--web"], ["app-server", "--stdio"]]) {
    const result = await exec(process.execPath, [bin, ...args], { cwd: directory });
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: args,
      entry: join(output, "agent/zcode.cjs"),
    });
  }
  await assert.rejects(
    exec(process.execPath, [bin], {
      env: { ...process.env, FIXTURE_EXIT_CODE: "17" },
    }),
    (error) => error.code === 17,
  );

  await missing(join(output, "web"));
  await missing(join(output, "server"));
  await missing(join(output, "node_modules"));
  const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
  assert.equal(manifest.private, false);
  assert.equal(manifest.engines.node, ">=24.14.0");
  assert.equal(manifest.bin.zcode, "./bin/zcode");
});

test("npm pack and global install preserve the nested CLI runtime without Web or Server", async (t) => {
  const { directory, output } = await fixture(t);
  const result = await exec(npmCommand, ["pack", "--json", "--pack-destination", directory], {
    cwd: output,
  });
  const [{ files, filename }] = JSON.parse(result.stdout);
  const paths = files.map((file) => file.path);
  assert.ok(paths.includes("agent/zcode.cjs"));
  assert.ok(paths.includes("agent/node_modules/@zcode/tui/package.json"));
  assert.ok(paths.includes("agent/node_modules/@zcode/tui/dist/index.js"));
  assert.ok(paths.includes("agent/node_modules/@zcode/tui/dist/index.upstream.js"));
  assert.ok(paths.includes("agent/node_modules/@zcode/tui/dist/osc7501-tui-wrapper.mjs"));
  assert.ok(paths.includes("agent/node_modules/@napi-rs/keyring/package.json"));
  assert.ok(paths.includes("bin/zcode"));
  assert.ok(paths.includes("docs/usage/index.md"));
  assert.ok(!paths.some((path) => path.startsWith("web/") || path.startsWith("server/")));
  assert.ok(!paths.some((path) => path.startsWith("node_modules/")));
  assert.ok(!paths.some((path) => path.endsWith(".map")));

  const prefix = join(directory, "npm-global");
  await exec(npmCommand, [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--ignore-scripts",
    join(directory, filename),
  ]);
  const installed = join(
    prefix,
    process.platform === "win32" ? "node_modules" : "lib/node_modules",
    "@fixture/zcode-cli",
  );
  await stat(join(installed, "agent/node_modules/@zcode/tui/package.json"));
  await stat(join(installed, "agent/node_modules/@napi-rs/keyring/package.json"));
  await missing(join(installed, "web"));
  await missing(join(installed, "server"));
  await missing(join(installed, "node_modules"));
  const version = await exec(process.execPath, [join(installed, "bin/zcode"), "--version"]);
  assert.equal(version.stdout.trim(), "1.2.3-mirror.4");
});

test("installed version mismatch fails before starting the TUI", async (t) => {
  const { directory, output } = await fixture(t);
  await assert.rejects(
    verifyInstalledTui(join(output, "bin/zcode"), {
      expectedVersion: "9.9.9",
      verificationRoot: directory,
    }),
    /Installed CLI version does not match 9\.9\.9/,
  );
});

test(
  "Release installer creates a working zcode command outside the source directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const { directory, output } = await fixture(t);
    const prefix = join(directory, "installed");
    await exec("sh", [join(output, "install.sh")], {
      cwd: directory,
      env: { ...process.env, PREFIX: prefix },
    });
    await rm(output, { recursive: true, force: true });
    const installed = join(prefix, "bin/zcode");
    assert.equal((await exec(installed, ["--version"])).stdout.trim(), "1.2.3-mirror.4");
    const result = await exec(installed, ["tui", "example"]);
    assert.deepEqual(JSON.parse(result.stdout).argv, ["tui", "example"]);
  },
);

test("workflow publishes the npm tarball through an explicit local path", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/sync-and-build.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /npm publish "\.\/stage\/\$NPM_TARBALL"/);
});

test("assembled @zcode/tui shim wraps runTui with OSC 7501 and preserves other exports", async (t) => {
  const { output } = await fixture(t);
  const tuiModule = await import(
    pathToFileURL(join(output, "agent/node_modules/@zcode/tui/dist/index.js")).href
  );
  assert.equal(tuiModule.EXTRA_EXPORT, "kept");
  const writes = [];
  const code = await tuiModule.runTui({
    stdout: { isTTY: true, write: (chunk) => writes.push(chunk) },
    loadStartupOptions: async () => ({ loginRequired: false }),
  });
  assert.equal(code, 0);
  assert.deepEqual(writes, [
    formatOsc7501({ state: "idle", app: "zcode" }),
    formatOsc7501({ state: "clear" }),
  ]);
});

test("packager skips OSC 7501 shim when upstream already supports OSC 7501", async (t) => {
  const { output } = await fixture(t, { upstreamNativeOsc7501: true });
  await stat(join(output, "agent/node_modules/@zcode/tui/dist/index.js"));
  await missing(join(output, "agent/node_modules/@zcode/tui/dist/index.upstream.js"));
  await missing(join(output, "agent/node_modules/@zcode/tui/dist/osc7501-tui-wrapper.mjs"));
});

test("OSC 7501 wrapper tracks auth, turns, approvals, questions, subagent filter, errors and exit", async () => {
  const writes = [];
  const fakeProcess = new EventEmitter();
  let sessionSink;
  let registeredApprovalHandler;
  let mainSessionId = "main-1";

  const wrappedRunTui = wrapRunTuiWithOsc7501(
    async (options) => {
      await options.loadStartupOptions();
      options.subscribeSessionEvents((event) => {
        // upstream TUI sink
        void event;
      });
      options.registerPermissionRequester(async (request) => {
        if (request.toolName === "CreateWorkflow") {
          return { decision: "allow" };
        }
        return await request._deferred;
      });

      // 1. 完成登录后解除 auth 阻塞
      await options.submitPrompt("/login", {});

      // 2. 主会话开始执行 -> working
      sessionSink({ id: "e1", sessionId: "main-1", type: "turn_started", payload: {} });

      // 3. 子会话的 turn_complete 和 tool mirror 不能干扰主会话状态
      sessionSink({ id: "e2", sessionId: "child-1", type: "turn_complete", payload: {} });
      sessionSink({
        id: "e3",
        sessionId: "main-1",
        type: "tool_call_started",
        payload: { source: "subagent", toolName: "Bash" },
      });

      // 4. CreateWorkflow 自动放行不触发 blocked
      await registeredApprovalHandler({ toolName: "CreateWorkflow", input: {} });

      // 5. Bash 审批 + AskUserQuestion 并发排队 -> 先 permission，解决后转 question，全解决后恢复 working
      let resolveBash;
      let resolveQuestion;
      const bashReq = registeredApprovalHandler({
        toolName: "Bash",
        input: { command: "npm test" },
        _deferred: new Promise((resolve) => {
          resolveBash = resolve;
        }),
      });
      const questionReq = registeredApprovalHandler({
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Deploy to prod?" }] },
        _deferred: new Promise((resolve) => {
          resolveQuestion = resolve;
        }),
      });
      resolveBash({ decision: "allow" });
      await bashReq;
      resolveQuestion({ decision: "allow" });
      await questionReq;

      // 6. 回合完成 -> done
      sessionSink({ id: "e4", sessionId: "main-1", type: "turn_complete", payload: {} });

      // 7. 再次执行并出错 -> working -> error
      sessionSink({ id: "e5", sessionId: "main-1", type: "turn_started", payload: {} });
      sessionSink({
        id: "e6",
        sessionId: "main-1",
        type: "turn_error",
        payload: { error: { message: "rate limited" } },
      });

      // 8. 切会话 -> idle，然后 Esc 取消中的回合 -> working -> idle
      mainSessionId = "main-2";
      sessionSink({ id: "e7", sessionId: "main-2", type: "session_created", payload: {} });
      const abortController = new AbortController();
      await assert.rejects(
        options.submitPrompt("hello", {
          abortSignal: abortController.signal,
          onEvent: () => {},
        }),
        /Aborted/,
      );

      return 0;
    },
    { env: {}, proc: fakeProcess },
  );

  const code = await wrappedRunTui({
    stdout: { isTTY: true, write: (chunk) => writes.push(chunk) },
    getMainSessionId: () => mainSessionId,
    loadStartupOptions: async () => ({ loginRequired: true }),
    subscribeSessionEvents: (sink) => {
      sessionSink = sink;
      return () => {
        sessionSink = undefined;
      };
    },
    registerPermissionRequester: (handler) => {
      registeredApprovalHandler = handler;
      return () => {
        registeredApprovalHandler = undefined;
      };
    },
    submitPrompt: async (prompt, callOptions) => {
      if (prompt === "/login") {
        return { response: "ok", loginRequired: false };
      }
      callOptions?.onEvent?.({ id: "e8", sessionId: "main-2", type: "turn_started", payload: {} });
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(writes, [
    formatOsc7501({ state: "blocked", kind: "auth", app: "zcode" }),
    formatOsc7501({ state: "idle", app: "zcode" }),
    formatOsc7501({ state: "working", app: "zcode" }),
    formatOsc7501({ state: "blocked", kind: "permission", app: "zcode", msg: "Bash: npm test" }),
    formatOsc7501({ state: "blocked", kind: "question", app: "zcode", msg: "Deploy to prod?" }),
    formatOsc7501({ state: "working", app: "zcode" }),
    formatOsc7501({ state: "done", app: "zcode" }),
    formatOsc7501({ state: "working", app: "zcode" }),
    formatOsc7501({ state: "error", app: "zcode", msg: "rate limited" }),
    formatOsc7501({ state: "idle", app: "zcode" }),
    formatOsc7501({ state: "working", app: "zcode" }),
    formatOsc7501({ state: "idle", app: "zcode" }),
    formatOsc7501({ state: "clear" }),
  ]);
});

test("OSC 7501 wrapper stays silent when non-TTY or disabled via ZCODE_OSC7501=0", async () => {
  const nonTtyWrites = [];
  const wrappedDefault = wrapRunTuiWithOsc7501(
    async (options) => {
      await options.loadStartupOptions?.();
      return 0;
    },
    { env: {} },
  );
  await wrappedDefault({
    stdout: { isTTY: false, write: (chunk) => nonTtyWrites.push(chunk) },
    loadStartupOptions: async () => ({ loginRequired: false }),
  });
  assert.deepEqual(nonTtyWrites, []);

  const disabledWrites = [];
  const wrappedDisabled = wrapRunTuiWithOsc7501(
    async (options) => {
      await options.loadStartupOptions?.();
      return 0;
    },
    { env: { ZCODE_OSC7501: "0" } },
  );
  await wrappedDisabled({
    stdout: { isTTY: true, write: (chunk) => disabledWrites.push(chunk) },
    loadStartupOptions: async () => ({ loginRequired: false }),
  });
  assert.deepEqual(disabledWrites, []);
});
