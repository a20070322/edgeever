# CLI 本地 Markdown 工作目录（正文与附件）

独立 Node.js/npm 安装方式见 [CLI 中文说明](../cli/README.zh-CN.md)。安装后将下文的 `bun scripts/edgeever.mjs` 换成 `edgeever`；原脚本入口仍然兼容。

对应英文：[File workspace](file-workspace.md)。

目的：让 Codex、Claude Code 或普通编辑器通过本地文件搜索、编辑已有笔记，再通过 EdgeEver API 回写。数据库仍为权威存储；无需 Git。CLI 不访问桌面 SQLite，不会看到桌面尚未同步到服务端的修改。

## 使用

独立 npm 包需要 Node.js 22+；仓库脚本也可使用 Bun。同步需要更新后的服务端源码。原 CLI 的环境变量或 profile 均可复用。令牌至少需要 `read:notebooks`、`read:memos`、`write:memos`、`read:resources`、`write:resources`。令牌不要放进工作目录或版本库。

```bash
export EDGEEVER_URL=http://127.0.0.1:8787
# EDGEEVER_TOKEN 通过安全的本机配置提供，或使用 --profile。
bun scripts/edgeever.mjs notebooks
bun scripts/edgeever.mjs workspace link ./资料 --notebooks nb_a,nb_b --exclude nb_private
bun scripts/edgeever.mjs workspace sync ./资料
bun scripts/edgeever.mjs workspace status ./资料
# 用 AI / 编辑器修改已有 .md 正文后：
bun scripts/edgeever.mjs workspace sync ./资料 --dry-run
bun scripts/edgeever.mjs workspace sync ./资料
```

- 全量：`workspace link ./资料 --all`。
- 默认包含子笔记本；`--shallow` 只选择指定笔记本。排除目录始终包含其子级。
- 调整范围：重新 link 并带 `--replace-scope`，保留已有文件和基线。
- 只拉取：`workspace sync ./资料 --pull-only`，保留本地未提交修改。
- 目录与文件使用可读名称，重名时追加序号；笔记 ID 写入 YAML front matter。笔记改名后已有路径保持稳定；本地改文件名不表示远端改名。
- `status` 无需认证与网络；其他命令使用配置的实例和账号。禁止跨实例/工作区复用同一目录。

## 冲突与恢复

`.edgeever/state.json` 保存 ID、路径、版本、哈希和完整基线正文；不保存令牌。不要手工修改状态文件。冲突时保留本地正文，远端副本写入 `.edgeever/conflicts`。历史被替换文件保存在 `.edgeever/history`，内容也可能敏感。

```bash
# 明确选择远端，覆盖前会保留本地历史；也可恢复丢失的本地文件。
bun scripts/edgeever.mjs workspace resolve ./资料 --memo memo_id --use remote
# 先自行合并本地文件，再确认以当前远端为新基线：
bun scripts/edgeever.mjs workspace resolve ./资料 --memo memo_id --use local
bun scripts/edgeever.mjs workspace sync ./资料
```

`--use local` 是显式接受本地正文作为后续推送内容，可能取代远端变更，务必先审阅。resolve 本身不推送，之后 sync 仍检查版本。进程意外退出留下 `.edgeever/lock` 时，先确认原进程已停止，再删除该锁。不要边同步边编辑同一个文件；工具会检测多种竞争并保留历史，但不是操作系统文件锁。

成功退出码为 0，失败为 1；sync 遇到冲突、缺失本地文件或路径冲突等需处理事项为 2。逐篇同步不是整个目录的原子事务，前面成功的笔记会保留同步进度，后续可重试。

## 首版边界

- 新建文件标为 untracked，通过 `workspace import` 显式导入；sync 不自动创建笔记。
- 本地删除、范围缩小或远端移出范围都不会自动传播删除；保留文件并提示。
- 仅保留字段 `edgeever` 用于识别笔记；其他 front matter 作为正文保留，不解释为业务修改。
- 图形笔记可拉取，但禁止从本地正文推送，使用原图形工具编辑。
- 支持标准 Markdown 图片、附件链接与引用式链接的双向转换，代码块/行内代码保持不变；HTML 内嵌资源、Markdown 笔记间链接及外部网址不做本地镜像。
- 首版分页扫描所选笔记本并读取详情；不是游标持久化增量引擎，不承诺大库扫描性能。
- 仅手动同步，无后台监听；不含 OS 挂载、桌面 UI；通过 --auto-merge 显式启用文本三方合并。
- Markdown/富文本扩展仍遵循 EdgeEver 原转换规则。已验证普通万字正文，不代表所有扩展节点往返无损。

## 服务端与验证

新增 `/api/v1/file-workspace` 返回工作区与能力。旧服务端未声明原子版本写入时拒绝同步。保存使用原 edit-session + PATCH；服务端在原子 batch 开头用已有 `revision >= 0` CHECK 约束拒绝过期版本，使历史、正文、元数据、索引、审计整体回滚。无新迁移。部署回滚到旧服务端后，此 CLI 会因能力缺失而拒绝同步。

测试：先运行 `npm ci --prefix cli`，再运行 `bun test scripts/file-workspace/core.test.mjs`。使用临时目录、真实 Hono API、SQLite 适配器与全部既有 migrations；覆盖范围、万字修改、冲突、重试、安全路径、并发事务。未完成 Windows 文件系统或 Cloudflare 实际部署验证。全仓 typecheck 当前受到扩展/官网缺失依赖影响；需与本次 API 类型检查结果区分。


## 附件工作流与升级

默认下载正文中引用的服务端附件到 `attachments/<附件ID>/<哈希>-文件名`，正文改为相对路径。下载需鉴权并校验 SHA-256 与字节数；绝不携带令牌访问第三方 URL 或跟随重定向。相对文件路径必须在工作目录内，不允许符号链接或 file://。单文件上限 100 MiB，当前不是分片/流式落盘方案。

在本地加入图片或 PDF，并在 Markdown 中插入标准链接；下一次 sync 自动上传后用 `/api/v1/resources/<ID>/blob` 提交正文。本地正文继续保留相对路径。附件内容改变时创建新资源，绝不覆盖旧资源；删除文件或移除引用不删除服务端资源。引用仍在但本地文件缺失时阻止推送，status 返回 attachment-error。下载的是被正文引用的附件，不是全部孤立资源。

v1/v2 状态需要按下节显式迁移为 v3；分别记录本地 hash/base 与 serverHash/serverBase，以及附件路径/ID/SHA 映射和上传回执。升级后不要用旧 CLI 写同一目录。回滚需先保留本地新修改及整个 `.edgeever` 目录，再恢复升级前的工作目录快照。

每次上传先写日志，再保存上传回执，最后保存正文。正文失败后重试复用回执。上传响应丢失时，通过所属笔记的资源列表按文件名、SHA、大小查找结果；如果仍无法确定是否成功，会停止而不是盲目重传。错误会提示具体文件；应待原请求结束后再次同步。不能确认失败时不要手改日志或强制重传。未被正文引用的上传结果暂时保留，不自动回收。

--dry-run 不上传、不下载、不改正文及同步基线；只检查文件和预计操作。--pull-only 不上传本地附件，但会下载远端正文所引用资源。本地附件与远端正文同时修改时，仍进入笔记冲突流程。客户端使用旧 `/file-workspace` 能力声明而没有 attachmentSync 时拒绝同步，须先升级本机服务。


确已确认原上传请求结束且服务端没有对应资源时，可运行 `workspace uploads <目录>` 查看日志 key，然后 `workspace retry-upload <目录> --key <key>` 显式授权重试，再执行 sync。该动作保留原日志；在原请求仍运行时使用可能留下重复资源，不能当作常规重试。

## CLI 0.3：文档身份与迁移

服务器已有 file-workspace 和附件能力时，本次只需升级 CLI。每个已跟踪文件包含：

```yaml
---
edgeever:
  memo_id: memo_example
---
```

在同一工作目录中改名或移动文件时保留 ID。sync 按 ID 识别文件，并根据旧路径修复移动后失效的相对二进制附件链接；不会因此移动远端笔记所属笔记本。笔记间 Markdown 链接不会自动改写。重复、变更、缺失或陌生 ID 会阻止受影响笔记同步。状态文件仍保存实例绑定和冲突基线，不能仅靠复制 front matter 绑定任意笔记。上传前剥离 CLI 元数据，用户原有 front matter 保留；需要时会增加受管理的 `preserve_front_matter` 标志。

显式迁移旧目录：

```bash
edgeever workspace migrate ./资料 --dry-run
edgeever workspace migrate ./资料
```

迁移保留本地修改，将旧 hash 后缀路径转换为避免重名的可读路径，并把原状态和已跟踪文件原文备份到 `.edgeever/migrations/v3-<id>/`。不写服务端。中断后重跑 migrate 可续接；文件有额外修改时停止恢复，不覆盖。v3 目录不能交给旧 CLI。回滚前保留新修改，再按备份恢复原始路径和状态；检查生成的替代文件后再移除它们。

新文档显式导入所链接范围内的笔记本：

```bash
edgeever workspace import ./资料 --file 新笔记.md --notebook nb_example
```

保留本地文件名，默认以文件名作为标题。先导入文字，再添加本地附件并 sync。若创建成功但响应丢失，先检查笔记本、确认创建结果 ID，再用相同 import 命令追加 `--memo memo_confirmed`；CLI 校验笔记本和正文后绑定。不要盲目再次创建，不确定的请求可能已经成功。

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
