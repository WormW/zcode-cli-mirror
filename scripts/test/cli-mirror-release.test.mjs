import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { assembleCliRelease } from "../package-cli-release.mjs";
import { verifyInstalledTui } from "../verify-installed-tui.mjs";

const exec = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-cli-release-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "upstream");
  const output = join(directory, "stage/zcode");
  const dist = join(source, "apps/zcode-cli/packages/cli/dist");
  await mkdir(join(dist, "provider"), { recursive: true });
  await mkdir(join(source, "apps/zcode-cli/docs/usage"), { recursive: true });
  await mkdir(join(source, "packages/web/dist"), { recursive: true });
  await mkdir(join(source, "packages/server/dist"), { recursive: true });
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
      await mkdir(join(outputDirectory, "agent/node_modules/@zcode/tui"), { recursive: true });
      await writeFile(
        join(outputDirectory, "agent/node_modules/@zcode/tui/package.json"),
        '{"name":"@zcode/tui","version":"0.1.0"}\n',
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
