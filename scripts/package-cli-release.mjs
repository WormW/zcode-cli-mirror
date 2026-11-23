#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
