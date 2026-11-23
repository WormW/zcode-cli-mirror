#!/usr/bin/env node
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultOsc7501WrapperPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "cli-mirror",
  "osc7501-tui-wrapper.mjs",
);
const UPSTREAM_OSC7501_SOURCE_DIRS = [
  "apps/zcode-cli/packages/cli/src",
  "apps/zcode-cli/packages/tui/src",
];
const UPSTREAM_OSC7501_PATTERN = /\]7501;|OSC_7501/i;

const cliRunnerSource = `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const agentEntry = resolve(root, "agent", "zcode.cjs");
const args = process.argv.slice(2);

if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
  console.log(version);
} else {
  // CLI 自启动子进程依赖真实 Agent 路径；其他参数（包括 --web）不由镜像 launcher 解释。
  process.argv[1] = agentEntry;
  await import(pathToFileURL(agentEntry).href);
}
`;

const binForwarderSource = `#!/usr/bin/env node
import "./zcode.mjs";
`;

const installScriptSource = `#!/usr/bin/env bash
set -e
PREFIX="\${PREFIX:-$HOME/.local}"
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$PREFIX/lib" "$PREFIX/bin"
rm -rf "$PREFIX/lib/zcode"
mkdir -p "$PREFIX/lib/zcode"
cp -R "$SOURCE_DIR"/. "$PREFIX/lib/zcode"/
ln -sf ../lib/zcode/bin/zcode "$PREFIX/bin/zcode"
echo "Installed to $PREFIX. Ensure $PREFIX/bin is on your PATH."
`;

const importSourceModule = (sourceRoot, file) =>
  import(pathToFileURL(resolve(sourceRoot, file)).href);

const copyCollectedAssets = async ({ assets, manifest, outputAgent, prefix }) => {
  for (const file of manifest.files) {
    const source = assets[`${prefix}${file.path}`];
    if (!source) throw new Error(`Missing collected CLI asset: ${file.path}`);
    const destination = resolve(outputAgent, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    await chmod(destination, file.mode);
  }
};

export async function stageCliRuntime({ sourceRoot, outputDirectory }) {
  const outputAgent = resolve(outputDirectory, "agent");
  const { stageTuiRuntime } = await importSourceModule(
    sourceRoot,
    "scripts/zcode-distribution/assets.mjs",
  );
  await stageTuiRuntime(outputDirectory);

  const { supportedTargets } = await importSourceModule(
    sourceRoot,
    "apps/zcode-cli/packages/cli/scripts/sea-targets.mjs",
  );
  const { collectSeaPlaywrightAssets, seaPlaywrightAssetPrefix } = await importSourceModule(
    sourceRoot,
    "apps/zcode-cli/packages/cli/scripts/sea-playwright-assets.mjs",
  );
  const playwrightStaging = resolve(outputDirectory, "../cli-playwright-staging");
  const hostPlatform = process.platform === "win32" ? "win" : process.platform;
  try {
    const { assets, manifest } = await collectSeaPlaywrightAssets({
      root: resolve(sourceRoot, "apps/zcode-cli"),
      stagingDirectory: playwrightStaging,
      target: `${hostPlatform}-${process.arch}`,
    });
    await copyCollectedAssets({
      assets,
      manifest,
      outputAgent,
      prefix: seaPlaywrightAssetPrefix,
    });
  } finally {
    await rm(playwrightStaging, { recursive: true, force: true });
  }

  const { stageCredentialKeyring } = await importSourceModule(
    sourceRoot,
    "scripts/stage-credential-keyring.mjs",
  );
  for (const target of supportedTargets) {
    await stageCredentialKeyring({
      sourceRoot: resolve(sourceRoot, "packages/shared"),
      targetRoot: outputAgent,
      platformKey: target.replace(/^win-/, "win32-"),
    });
  }
}

export const createPackageManifest = ({ name, version, nodeVersion, registry, repository }) => ({
  name,
  version,
  private: false,
  description: "Unofficial CLI-only build of the official ZCode Agent CLI",
  license: "Apache-2.0",
  type: "module",
  main: "./agent/zcode.cjs",
  bin: { zcode: "./bin/zcode" },
  files: ["bin", "agent", "docs", "install.sh"],
  engines: { node: `>=${nodeVersion}` },
  repository: { type: "git", url: repository },
  publishConfig: { access: "public", registry },
});

const readNodeVersion = async (sourceRoot) => {
  const source = await readFile(resolve(sourceRoot, "mise.toml"), "utf8");
  const match = source.match(/^node\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("Unable to read the Node.js version from upstream mise.toml");
  return match[1];
};

async function directoryContainsOsc7501(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (await directoryContainsOsc7501(fullPath)) return true;
      continue;
    }
    if (!/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) continue;
    const content = await readFile(fullPath, "utf8");
    if (UPSTREAM_OSC7501_PATTERN.test(content)) return true;
  }
  return false;
}

export async function upstreamSupportsOsc7501(sourceRoot) {
  for (const dir of UPSTREAM_OSC7501_SOURCE_DIRS) {
    if (await directoryContainsOsc7501(resolve(sourceRoot, dir))) {
      return true;
    }
  }
  return false;
}

function resolveTuiEntryRelativePath(packageJson) {
  const exportsField = packageJson?.exports;
  if (typeof exportsField === "string") return exportsField;
  if (exportsField && typeof exportsField === "object") {
    const rootExport = exportsField["."];
    if (typeof rootExport === "string") return rootExport;
    if (rootExport && typeof rootExport === "object") {
      if (typeof rootExport.import === "string") return rootExport.import;
      if (typeof rootExport.default === "string") return rootExport.default;
    }
  }
  return typeof packageJson?.main === "string" ? packageJson.main : "./dist/index.js";
}

export async function installOsc7501TuiWrapper({
  sourceRoot,
  outputDirectory,
  wrapperSourcePath = defaultOsc7501WrapperPath,
}) {
  if (await upstreamSupportsOsc7501(sourceRoot)) {
    console.log("Upstream already emits OSC 7501; skipping mirror TUI wrapper.");
    return { wrapped: false, reason: "upstream-native" };
  }

  const tuiPackageDir = resolve(outputDirectory, "agent/node_modules/@zcode/tui");
  const tuiPackageJson = JSON.parse(await readFile(resolve(tuiPackageDir, "package.json"), "utf8"));
  const entryPath = resolve(tuiPackageDir, resolveTuiEntryRelativePath(tuiPackageJson));
  const relEntry = relative(tuiPackageDir, entryPath);
  if (!relEntry || relEntry.startsWith("..")) {
    throw new Error(`Invalid @zcode/tui entry path: ${entryPath}`);
  }
  await stat(entryPath);

  const entryDir = dirname(entryPath);
  const entryBase = basename(entryPath);
  const extMatch = entryBase.match(/\.(?:mjs|js)$/);
  if (!extMatch) {
    throw new Error(`Unsupported @zcode/tui entry extension: ${entryBase}`);
  }
  const ext = extMatch[0];
  const upstreamBase = `${entryBase.slice(0, -ext.length)}.upstream${ext}`;
  const upstreamPath = resolve(entryDir, upstreamBase);
  const wrapperTarget = resolve(entryDir, "osc7501-tui-wrapper.mjs");

  await rename(entryPath, upstreamPath);
  await cp(wrapperSourcePath, wrapperTarget);
  const shimSource = `// Mirror OSC 7501 shim: wraps @zcode/tui runTui without modifying upstream source.
export * from "./${upstreamBase}";
import { runTui as upstreamRunTui } from "./${upstreamBase}";
import { wrapRunTuiWithOsc7501 } from "./osc7501-tui-wrapper.mjs";

export const runTui = wrapRunTuiWithOsc7501(upstreamRunTui);
`;
  await writeFile(entryPath, shimSource);
  return { wrapped: true, entryPath, upstreamPath, wrapperTarget };
}

export async function assembleCliRelease({
  sourceRoot,
  outputDirectory,
  name,
  version,
  nodeVersion,
  readme,
  registry = "https://registry.npmjs.org",
  repository,
  stageRuntime = stageCliRuntime,
}) {
  sourceRoot = resolve(sourceRoot);
  outputDirectory = resolve(outputDirectory);
  const cliDist = resolve(sourceRoot, "apps/zcode-cli/packages/cli/dist");
  const outputAgent = resolve(outputDirectory, "agent");
  const outputBin = resolve(outputDirectory, "bin");

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputAgent, { recursive: true });
  await mkdir(outputBin, { recursive: true });
  await cp(resolve(cliDist, "zcode.cjs"), resolve(outputAgent, "zcode.cjs"));
  await cp(resolve(cliDist, "provider"), resolve(outputAgent, "provider"), { recursive: true });
  await cp(
    resolve(cliDist, "THIRD-PARTY-NOTICES.md"),
    resolve(outputAgent, "THIRD-PARTY-NOTICES.md"),
  );
  await chmod(resolve(outputAgent, "zcode.cjs"), 0o755);

  await stageRuntime({ sourceRoot, outputDirectory });
  await installOsc7501TuiWrapper({ sourceRoot, outputDirectory });

  await writeFile(resolve(outputBin, "zcode.mjs"), cliRunnerSource);
  await writeFile(resolve(outputBin, "zcode"), binForwarderSource);
  await chmod(resolve(outputBin, "zcode.mjs"), 0o755);
  await chmod(resolve(outputBin, "zcode"), 0o755);
  await cp(
    resolve(sourceRoot, "apps/zcode-cli/docs/usage"),
    resolve(outputDirectory, "docs/usage"),
    { recursive: true },
  );
  await cp(resolve(readme), resolve(outputDirectory, "README.md"));
  await cp(resolve(sourceRoot, "LICENSE"), resolve(outputDirectory, "LICENSE"));
  await writeFile(resolve(outputDirectory, "install.sh"), installScriptSource);
  await chmod(resolve(outputDirectory, "install.sh"), 0o755);

  const manifest = createPackageManifest({
    name,
    version,
    nodeVersion: nodeVersion ?? (await readNodeVersion(sourceRoot)),
    registry,
    repository,
  });
  await writeFile(
    resolve(outputDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    options[key] = value;
    index += 1;
  }
  for (const key of ["source", "output", "name", "version", "readme", "repository"]) {
    if (!options[key]) throw new Error(`Missing required --${key}`);
  }
  return options;
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await assembleCliRelease({
    sourceRoot: options.source,
    outputDirectory: options.output,
    name: options.name,
    version: options.version,
    readme: options.readme,
    registry: options.registry,
    repository: options.repository,
  });
  console.log(
    `CLI-only package assembled: ${manifest.name}@${manifest.version} (${options.output})`,
  );
}
