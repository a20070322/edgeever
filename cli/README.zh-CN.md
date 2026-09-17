# 知识工作台 EdgeEver CLI

从定制版 EdgeEver 拆出的独立 Node.js CLI，与仓库旧脚本共用实现。运行要求 Node.js 22 或更新版本；安装后不需要 Bun、服务端源码或构建步骤。

## 本地安装（尚未发布到 npm）

在本目录运行：

```sh
npm ci
npm test
npm pack --pack-destination /tmp
npm install -g /tmp/knowledge-workbench-edgeever-cli-0.6.0.tgz
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

不同实例/工作区使用不同本地目录。新 Markdown 文件需要显式 workspace import，删除不会传播，同步需手动触发。退出码：0 成功，1 错误，2 已报告同步冲突。全部命令见 `edgeever --help`。

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


## 文档 ID 与可读路径（0.3.0）

受管 Markdown 使用 YAML 文档头：

```markdown
---
edgeever:
  memo_id: memo_example
---
# 笔记正文
```

上传时只移除 CLI 管理的元数据，用户原有 front matter 保留；`edgeever` 中可能出现 `preserve_front_matter: true`，用来保留原有文档头。`edgeever` 是保留字段。新路径使用可读名称，重名时追加 ` (2)` 等编号。身份由 ID 决定，不依赖文件名。目录内改名/移动更新本地映射，不改远端标题或所属笔记本。ID 缺失、重复、非法或没有绑定基线时会报告，禁止猜测对应关系。移动笔记时会修复失效的相对二进制附件链接；笔记之间的 Markdown 链接不会自动改写。

旧 v1/v2 工作目录先迁移：

```sh
edgeever --profile cloud workspace migrate /path/to/notes --dry-run
edgeever --profile cloud workspace migrate /path/to/notes
edgeever --profile cloud workspace sync /path/to/notes --dry-run
```

迁移会验证实例身份，但不写服务端。原文件和状态备份在 `.edgeever/migrations/` 下，本地未同步修改、远端版本及正文基线都会保留；已有未跟踪文件不会覆盖。中断后重跑相同 migrate 命令，沿保存的日志恢复。目标文件被修改时停止并保留两份内容。迁移期间不要编辑工作目录。回滚时先保留当前目录，按备份状态中的旧路径恢复原文件，再恢复状态文件；不得用旧 CLI 操作 v3 状态。二进制资源和上传日志仍留在工作目录中。

从本地新文件创建笔记，并保留原文件名：

```sh
edgeever --profile cloud workspace import /path/to/notes --file 260924.md --notebook nb_id --title '迭代 260924'
```

import 创建云端笔记后，把 ID 写回同一个文件并绑定。目标笔记本必须在已选范围内。新的本地附件需导入完成后再添加并 sync；已有远端引用或已知资源映射可用。创建请求结果不确定时不会自动重试。找到确认创建的云端笔记后，以相同 import 命令追加 `--memo memo_id` 对账，CLI 会核对完整正文和笔记本再绑定。若无法确认是否创建，应停下检查导入日志，不能清除日志盲重建。已保存回执但中断的导入可以重跑 import 恢复。普通无 ID 新文件仍为 untracked。

只要服务端已有 file-workspace 能力，0.3.0 不需要升级服务端。本版不增加后台监听或删除传播。运行仓库的 Bun 集成测试前需执行 `npm ci --prefix cli`，因为 YAML 依赖归 CLI 独立管理。

## 云端笔记归属移动（0.3.1）

笔记在云端换笔记本后，sync 会在 CLI 管理的目录间搬迁对应文件，也能修复 0.3.0 留下的旧路径。先用 `workspace sync <目录> --dry-run --pull-only` 预览，再用 `workspace sync <目录> --pull-only` 执行，不上传正文。不要删除本地文件或重新链接：`--replace-scope` 保留既有映射，不能重置路径。

搬迁保留本地修改和冲突基线，修复相对附件链接；目标文件名被占用时追加序号。本版识别到的手动本地移动以及新导入的自选路径会保留为本地覆盖；旧版已经保存到受管目录内的手动路径无法完全区分。本次处理笔记在笔记本间移动，不包含笔记本自身改名或更换父级。

原文件保存在 `.edgeever/history/moves/`。中断留下的 `.edgeever/pending-move.json` 会在下次 sync 扫描 ID 前恢复。若源文件或目标文件发生额外变更，保留日志和备份并停止；检查后再恢复，不要删除状态或换旧版 CLI 重试。回滚 CLI 前先完成恢复、备份整个目录。Windows 文件系统行为尚未实测。

## 自动合并与人工解决冲突（0.4.0）

```bash
edgeever --profile cloud workspace sync ./资料 --auto-merge --dry-run
edgeever --profile cloud workspace sync ./资料 --auto-merge
edgeever workspace conflicts ./资料
# 人工终端菜单：查看三方内容、生成草稿、编辑、选择一方、确认或跳过
edgeever --profile cloud workspace resolve ./资料 --memo MEMO_ID --interactive
# 脚本/编辑器流程：
edgeever --profile cloud workspace resolve ./资料 --memo MEMO_ID --use merge
# 编辑返回的草稿路径，清除冲突标记，再执行：
edgeever --profile cloud workspace resolve ./资料 --memo MEMO_ID --continue
edgeever --profile cloud workspace sync ./资料
```

`--auto-merge` 显式启用按行的确定性三方合并，比较上次基线、本地文本、最新云端文本。互不重叠或相同的改动可合并，重叠冲突保留待处理。`--dry-run` 不改文件或基线；`--pull-only --auto-merge` 只将成功合并结果落到本地，不上传。新增/修改本地二进制附件需要人工明确处理，不合并二进制字节；图形笔记仍只读。

文本冲突会在 `.edgeever/conflicts/` 下保存基线、本地、远端快照及纯正文草稿 `merge.md`。重复 sync 不覆盖草稿，受影响笔记在确认前不上传。草稿的相对附件链接按原笔记位置解释，不按草稿目录解释；选择附件时保留对应链接或使用提供的远端版本。编辑时删除 `<<<<<<< LOCAL`、`||||||| BASE`、`=======`、`>>>>>>> REMOTE` 标记及不需要的备选内容，不要粘贴受管 `edgeever` 元数据。`resolve --continue` 校验原本地文件/附件指纹及远端版本、内容、所属笔记本，再安装结果，不上传。输入发生变化时，用 `--use merge` 生成新草稿；旧草稿仍保留，可搬回人工修改。之后 sync 上传时再次校验远端版本。

`--use merge --edit [--editor <可执行文件>]` 可打开草稿，交互菜单也可打开。editor 只接受单个可执行文件路径/名称，不接受带参数的 shell 命令。默认 macOS 为 `open -W`、Windows 为记事本、其他平台为 `vi`；关闭编辑器后返回。菜单需要终端 TTY，“查看”显示三方快照。`--use local|remote` 表示明确选择一方全文并清除待处理冲突，选择 local 后同步可能舍弃远端修改。resolve 与 sync 阻止上传未清除的标记行（正文里演示标记的例子也需缩进或删除后才能同步）。

本地文件缺失时，先检查备份，再用 `resolve --memo ID --use remote` 逐篇恢复并 sync。不要删除 `.edgeever/state.json` 或已跟踪文件来重置路径。`link --replace-scope` 保留映射和基线是预期行为。目录后缀 `(2)` 可能源于任意本地占用，包括旧空目录，不能说明云端存在同名笔记本。0.3.1+ 支持笔记换所属笔记本，笔记本自身改名/换父级仍不在本次范围。本版无需服务端改动。回滚前备份整个工作目录及 `.edgeever`，并先用本版完成待处理冲突；旧 CLI 不识别新增的活动冲突记录。

## 创建笔记本（0.5.0）

```bash
edgeever --profile cloud create-notebook --name "260924" --parent 笔记本ID
edgeever --profile cloud create-notebook --path "开发迭代/260924" --parent 笔记本ID --parents --dry-run
edgeever --profile cloud create-notebook --path "开发迭代/260924" --parent 笔记本ID --parents
```

创建需要 `read:notebooks` 和 `write:notebooks`。不传 `--parent` 时从工作区根级开始。`--name` 创建或复用单个完整名称，`--path` 用 `/` 分隔层级。`--parents` 补齐缺失祖先，不带时祖先必须已存在。名称去除首尾空格后限 1–80 字符，拒绝空段、点路径和控制字符。匹配限定在同一父级，按名称精确匹配并区分大小写；唯一同名项复用，多个同名项停止。输出逐层 created/reused 和最终 `notebookId`，可交给 `workspace import`。dry-run 不修改服务器（会使用临时本地操作锁）。

逐层创建不是服务端事务，失败会报告完成步骤，已创建笔记本保留。创建日志和按服务器区分的锁保存在 CLI 配置旁的 `notebook-operations/`，不保存凭据。响应丢失后重跑只会核对并复用可见的唯一同名结果；结果仍不可见时返回 uncertain（退出码 2）。只有确认原请求已结束且没有创建结果，才可显式加 `--retry-uncertain`，旧日志会保留。不同机器/客户端并发仍可能创建重名项，本功能不提供服务端唯一性保证。此命令不会导入本地文件或修改 workspace 链接范围。

## 已删除笔记本的空目录清理（0.6.0）

sync 后将受管目录 ID 与整个工作区的笔记本列表比较，清理前再次检查。云端已删除笔记本对应的本地空目录会按由深到浅的顺序移除，仅使用空目录删除操作。仍存在、仅被排除/移出同步范围的笔记本目录，以及非受管目录都会保留。有任何文件（包括隐藏文件）时保留并报告 `directory-retained-not-empty`，绝不递归删除。本地 Markdown 与笔记基线继续按原有规则保留。直接链接的笔记本消失时报告 `scope-notebook-missing`，不再中止整个同步。`--dry-run` 报告 `would-remove-directory`，并考虑本次计划搬走的笔记，不改文件和映射；`--pull-only` 也会清理空目录。本版不包含笔记本自身改名/换父级映射，也不删除非空本地文件夹。
