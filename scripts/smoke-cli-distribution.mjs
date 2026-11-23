// 从 Release tar 包验证 CLI；PTY 和模型服务都不是发布包的前置条件。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyInstalledTui } from "./verify-installed-tui.mjs";

const exec = promisify(execFile);
const archive = process.argv[2];
assert.ok(archive, "Usage: node scripts/smoke-cli-distribution.mjs <archive.tar.gz>");
const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-cli-smoke-")));
try {
  await exec("tar", ["-xzf", resolve(archive), "-C", directory]);
  await verifyInstalledTui(join(directory, "zcode/bin/zcode"));
  console.log("Release tarball CLI verification passed; Web is not included");
} finally {
  await rm(directory, { recursive: true, force: true });
}
