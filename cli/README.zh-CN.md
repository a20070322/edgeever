# 知识工作台 EdgeEver CLI

从定制版 EdgeEver 拆出的独立 Node.js CLI，与仓库旧脚本共用实现。运行要求 Node.js 22 或更新版本；安装后不需要 Bun、服务端源码或构建步骤。

## 本地安装（尚未发布到 npm）

在本目录运行：

```sh
npm ci
npm test
npm pack --pack-destination /tmp
npm install -g /tmp/knowledge-workbench-edgeever-cli-0.2.0.tgz
edgeever --help
```

`/tmp` 示例适用于 macOS/Linux；Windows 请换成已有临时目录。包名暂定，未声明拥有 npm 同名包或已发布。直接通过包名执行 `npm install -g knowledge-workbench-edgeever-cli` 或 registry 版 `npx`，需要另行完成发布。

## 配置与使用

```sh
edgeever profile set cloud --url https://your.edgeever.host --token '替换为新令牌'
edgeever --profile cloud notebooks
edgeever --profile cloud search '会议'
edgeever --profile cloud get memo_id
edgeever --profile cloud update memo_id --body-file ./note.md
edgeever --profile cloud workspace link ./资料 --notebooks nb_id
edgeever --profile cloud workspace sync ./资料 --pull-only
edgeever workspace status ./资料
# 修改文件后，先预览再上传：
edgeever --profile cloud workspace sync ./资料 --dry-run
edgeever --profile cloud workspace sync ./资料
```

填写实例根地址，不加 `/mcp`。配置默认保存到 `~/.edgeever/config.json`，可通过 `EDGEEVER_CONFIG` 指定其他位置，兼容原有 profile。环境变量 `EDGEEVER_URL`、`EDGEEVER_TOKEN` 优先于选定的 profile。令牌不得放入源码；直接在终端填写令牌可能留在 shell 历史中。POSIX 系统首次创建配置时使用仅所有者可读写权限。

基础命令使用已有 REST API。工作目录同步要求服务端提供我们新增的 `/api/v1/file-workspace` 能力、原子版本写入和附件同步；不能默认官方镜像具备这些能力。同步权限：`read:notebooks`、`read:memos`、`write:memos`、`read:resources`、`write:resources`。

不同实例/工作区使用不同本地目录。新 Markdown 文件不会自动导入，删除不会传播，同步需手动触发。退出码：0 成功，1 错误，2 已报告同步冲突。全部命令见 `edgeever --help`。

## 开发与验证

本目录是独立 npm 包，有意放在 Bun workspace 匹配范围之外，不改变服务端 Docker 构建。`bin/edgeever.mjs` 启动 `src/cli.mjs`；`src/file-workspace/` 是唯一同步核心。原 `scripts/edgeever.mjs` 和 `scripts/file-workspace/*.mjs` 转发到本包。

`npm test` 会打包 tarball，安装到独立临时目录，通过本地 HTTP 夹具验证已安装 CLI 的 profile、鉴权、multipart 上传、正文拉取、dry-run、冲突保留与旧服务能力拒绝。安装依赖需要 npm 仓库或缓存可用。这不替代真实服务集成测试和 Windows 验证；原 Bun/Hono/SQLite 集成测试仍位于上级仓库的 `scripts/file-workspace/core.test.mjs`。

许可证 AGPL-3.0-only。LICENSE 保留 EdgeEver 原许可证与版权声明。

## 随包分发的 Agent 技能

从 0.2.0 起，`skills/edgeever/` 随 CLI 同版本分发。技能安装不读取或复制令牌，也不连接 EdgeEver 实例。npm 安装或升级没有 postinstall 自动安装行为；请显式执行：

```sh
edgeever skill install --target all
edgeever skill status
# 安装新版 .tgz 或未来已发布的 npm 版本后：
edgeever skill update --target all
# 只为一个工具安装：
edgeever skill install --target kimi
# 其他支持 SKILL.md 的工具：指定它的技能父目录。
edgeever skill install --dir /absolute/path/to/tool/skills
```

| 目标 | 默认用户技能目录 | 环境变量覆盖 |
| --- | --- | --- |
| `codex` | `~/.codex/skills/edgeever` | `$CODEX_HOME/skills/edgeever` |
| `claude` | `~/.claude/skills/edgeever` | `$CLAUDE_CONFIG_DIR/skills/edgeever` |
| `kimi` | `~/.kimi-code/skills/edgeever` | `$KIMI_CODE_HOME/skills/edgeever` |

`all` 仅指上述三个目标，即使某工具尚未安装也会创建目录。`--dir` 与 `--target` 互斥。采用 `~/.agents/skills` 的新版 Codex 或共享技能环境可用 `--dir` 指定该目录，避免两处重复安装。Codex 默认路径遵循本机内置 skill-installer 的兼容目录约定；Kimi 和 Claude 路径依据 [Kimi 官方文档](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)及 [Claude Code 官方文档](https://code.claude.com/docs/en/skills)。安装后新开 Agent 会话加载技能；文件复制成功不等于运行中的会话已经加载。

`status` 比较文件哈希和 CLI 版本。`install` 保留已有安装，旧受管副本请用 `update` 更新；`update` 不安装尚不存在的技能。本地修改或非本 CLI 管理的副本会保留，并以退出码 2 提示。检查后可以在 install/update 加 `--force`：先把整个旧目录移到技能父目录旁的 `.edgeever-skill-backups/`，输出备份路径，再安装随包技能。目标目录或受管技能内的符号链接即使加 `--force` 也会阻止覆盖。普通更新也保留备份，不要把备份放进 Agent 会扫描的技能目录。

技能更新只使用当前已安装 CLI 的随包文件，不会下载新版 CLI。本包尚未发布到 npm。新增测试覆盖版本升级、本地修改、非受管技能、备份保留、目录选择和安装锁；打包测试会在隔离的临时数据目录中安装三个目标。
