# About this mirror

本仓库是 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的 CLI 发布镜像，唯一目的：**用 GitHub Actions 构建官方 Agent CLI，发布到 Releases 和 npm**。

## 产品与打包规则

- 发布产物只有 `zcode` 命令所需的 Agent、TUI、provider 配置、workers 和外置运行时；不包含桌面 GUI、Web 前端、HTTP/WebSocket Server 或 `--web` 模式。
- 上游源码保持检出原样。镜像只维护 `.github/workflows/sync-and-build.yml`、本文件及 `scripts/` 下的镜像打包和验证辅助文件。
- 打包阶段会在不修改上游源码的前提下，对 `agent/node_modules/@zcode/tui` 的 `runTui` 入口包一层 **OSC 7501（Program Status Protocol）** 状态上报，使新版 Herdr（`herdr-core` / `herdr-app`）等终端原生感知 `idle`、`working`、`blocked`（`permission` / `question` / `auth`）、`done`、`error` 与退出 `clear`。可通过 `ZCODE_OSC7501=0` 关闭，或通过 `ZCODE_OSC7501_APP` 自定义 `app` 标识（默认 `zcode`）；若未来上游原生实现 OSC 7501，打包器会自动跳过该包装。
- 镜像打包器复用上游 `stageTuiRuntime`、`collectSeaPlaywrightAssets` 和 `stageCredentialKeyring` 构建接口，收集六个桌面/服务器目标的 TUI、Playwright 与系统钥匙串资源。缺少必需资源时构建失败。
- CLI 运行时位于 `agent/node_modules`，不设置顶层 `node_modules`，也不依赖 npm 安装脚本。Node.js 版本要求跟随上游 `mise.toml`。
- `bin/zcode` 保留 CLI 的 TTY、参数和退出码，并将 `process.argv[1]` 指向真实 Agent 入口。构建时通过上游 `buildCli({ version })` 将 Agent 与 launcher 设置为同一镜像包版本；只有单独的 `--version`/`-v` 由 launcher 直接输出，`--web` 与其他参数一样直接交给 Agent CLI，不启动 Web。
- `scripts/package-cli-release.mjs` 是唯一产物组装入口；workflow 不调用 `build:zcode`、`build:sea`，也不生成 SEA 单文件。

## 安装

从 npm 安装：

```bash
npm install -g @wormw/zcode-cli@latest   # 上游正式 tag 的镜像构建
npm install -g @wormw/zcode-cli@nightly  # 上游 main 的每日构建
zcode --version
```

这是非官方镜像包。也可以从 [Releases](../../releases) 下载 tarball：

```bash
tar -xzf zcode-cli-*.tar.gz
cd zcode
./install.sh          # 默认 ~/.local，PREFIX=/usr/local 可改
zcode --version
```

运行需要 Node.js，具体最低版本以安装包的 `engines.node` 为准。

校验：

```bash
shasum -a 256 -c zcode-cli-*.sha256
```

### Herdr（新版 `herdr-app` + `herdr-core`）配合配置

镜像产物默认在交互式 TTY 中发射 OSC 7501 状态序列（`app=zcode`）。在 `~/.config/herdr-app/programs.json` 中加入以下条目即可在 `+` 菜单和侧边栏中识别 `zcode`：

```json
{
  "programs": {
    "zcode": {
      "name": "ZCode",
      "icon": "my-icons/zcode.svg",
      "tint": true,
      "tile": "#334155",
      "color": "#ffffff",
      "match": ["zcode", "zcode-cli"],
      "run": ["zcode"]
    }
  }
}
```

## 同步与发布所有权

镜像 main 通过普通 merge commit 定期合入**本次构建的精确上游 SHA**，保留镜像新增文件；禁止 rebase 和 force push。合入发生冲突时 workflow 失败并保留人工处理边界，不自动覆盖任何一侧。每次构建分别 checkout：

1. 当前镜像 main：提供 workflow、打包器、README 和验证脚本。
2. `zai-org/ZCode` 的指定 ref：放在独立 `upstream-src/`，提供实际构建源码。

因此上游前进时不会与镜像提交产生 fast-forward 冲突，也不会在切换 SHA 时删除镜像脚本。定时运行及手动留空 `ref` 时，workflow 将同一 SHA 合回镜像 main 并 push；指定其他 `ref` 的临时构建不改 main。Release body 记录上游 commit hash，可直接审计。

## 工作流与版本

每天 02:00 UTC（北京 10:00）构建上游 main，也可手动 Actions → Run workflow：

1. checkout 镜像与上游，读取上游 `mise.toml` 安装固定 Node/pnpm。
2. `pnpm install --frozen-lockfile`，再运行 `build:sea:prepare` 准备 Node CLI 和运行时资源；该步骤不生成 SEA。随后通过 `buildCli({ version })` 将 Agent 产物标记为镜像包版本。
3. 组装 CLI-only stage，生成 Release tarball、sha256 和真实 npm `.tgz`。
4. 从 npm `.tgz` 隔离安装，核对 `zcode --version` 与镜像版本，并通过真实 PTY 验证 TUI 初始化和键盘退出；Release tarball 也执行同一 CLI 验证。不调用模型。
5. 上传 Release，再按输入决定是否发布 npm；发布后从 registry 全新安装并重复验证。
6. 上游 tag 生成 `v<版本>-mirror.<修订号>` Release 和 `<版本>-mirror.<修订号>` npm 版本，使用 `latest`；main 生成带 UTC 时间和短 SHA 的 nightly，使用 `nightly`。
7. 同一上游 tag 的重复构建递增镜像修订号，不覆盖已有 Release 或不可变 npm 版本。workflow 并发组串行化发布，避免重复分配版本。

实际使用分为两条路径：每日 main/nightly 和 main 合并完全自动；正式版本在上游发布 tag 后，通过 **Actions → Run workflow → `ref=v3.18.2`** 半自动触发。正式 tag 的镜像构建发布到 npm `latest`，无需在本机手动 merge 或 push。

npm 发布需要仓库 Secret `NPM_TOKEN`。手动运行可勾选 `skip_npm` 仅发 GitHub Release。`verify_npm` 输入只验证已发布版本或 dist-tag（如 `latest`、`nightly`），绝不重新 publish，用于 npm 异步接受后的独立恢复检查。

## 回归验证

镜像辅助逻辑使用现有 Node 测试框架：

```bash
node --test scripts/test/cli-mirror-release.test.mjs
```

测试覆盖 CLI 参数和版本、无 Web/Server/顶层运行时、npm pack 文件清单及安装入口。实际发布仍必须执行真实构建和安装验证。

## 限制

- 仅 Agent CLI，不含桌面 GUI 和本地 Web。
- 不做 SEA 单文件打包，需要 Node 运行时。
- 六个目标的资源会全部收集；普通 Linux x64 Action 只实际执行 Linux x64 smoke，其他平台仍需对应平台验证。
- 验证不发送模型 prompt，不代表模型供应商登录和对话链路已经验收。
