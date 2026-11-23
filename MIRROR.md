# About this mirror

本仓库是 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的自动镜像，唯一目的：**用 GitHub Actions 构建官方 Agent CLI，发布到 Releases 和 npm**。

**代码零修改**：本仓库相对上游 only 新增 `.github/workflows/sync-and-build.yml` 和本文件。其余文件与上游 main 完全一致（fast-forward，无 merge commit）。

## 安装

从 npm 安装：

```bash
npm install -g @wormw/zcode-cli@latest   # 上游正式 tag
npm install -g @wormw/zcode-cli@nightly  # 上游 main 的每日构建
zcode --version
```

这是非官方镜像包，上游源码不改；npm `package.json` 仅在构建产物中生成。

也可以从 [Releases](../../releases) 下载 tarball：

```bash
tar -xzf zcode-cli-*-node24.tar.gz
cd zcode
./install.sh          # 默认 ~/.local，PREFIX=/usr/local 可改
zcode --version
```

运行需要 Node.js >= 24.14.0。

校验：

```bash
shasum -a 256 -c zcode-cli-*.sha256
```

## 工作流

每天 02:00 UTC（北京 10:00）触发，或手动 Actions → Run workflow：

1. `git fetch upstream`，`git merge --ff-only upstream/main`
2. `pnpm install --frozen-lockfile` + `pnpm --filter @zcode/cli... build`
3. 打包 `apps/zcode-cli/packages/cli/dist/` + 安装脚本，附 sha256
4. 上传 Release，命名：上游有 tag 用 tag（如 `v3.18.2`），否则 `nightly-YYYYMMDD-<sha>`（prerelease）
5. 同名 Release 已存在则跳过
6. 正式 tag 发布到 npm `latest`；每日 main 发布 `0.0.0-nightly.<时间>.<sha>` 到 `nightly`
7. npm 发布带 provenance，并从 registry 全新安装验证 `zcode --version`

每次 Release body 记录了对应的上游 commit hash，可直接 diff 审计。

npm 发布需要仓库 Secret `NPM_TOKEN`（Granular Access Token，Read and write (publish and stage)，允许绕过发布 2FA）。首次发布后可配置 npm Trusted Publisher，移除长期 token。手动运行可勾选 `skip_npm` 仅发 GitHub Release。

## 限制

- 仅 Agent CLI（`zcode` 命令），不含桌面 GUI、不含 `--web` 模式
- 不做 SEA 单文件打包，需要 Node 运行时
