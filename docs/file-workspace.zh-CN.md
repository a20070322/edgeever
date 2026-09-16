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
- 目录与文件名附稳定 ID 的摘要，避免同名与大小写冲突。笔记改名后已有路径保持稳定；本地改文件名不表示远端改名。
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

- 同步已有普通笔记正文；新建文件仅标为 untracked，不自动导入。
- 本地删除、范围缩小或远端移出范围都不会自动传播删除；保留文件并提示。
- 元数据通过原 CLI/API 操作；不解析 front matter 为业务修改。
- 图形笔记可拉取，但禁止从本地正文推送，使用原图形工具编辑。
- 支持标准 Markdown 图片、附件链接与引用式链接的双向转换，代码块/行内代码保持不变；HTML 内嵌资源、Markdown 笔记间链接及外部网址不做本地镜像。
- 首版分页扫描所选笔记本并读取详情；不是游标持久化增量引擎，不承诺大库扫描性能。
- 仅手动同步，无后台监听；不含 OS 挂载、桌面 UI、自动三方合并。
- Markdown/富文本扩展仍遵循 EdgeEver 原转换规则。已验证普通万字正文，不代表所有扩展节点往返无损。

## 服务端与验证

新增 `/api/v1/file-workspace` 返回工作区与能力。旧服务端未声明原子版本写入时拒绝同步。保存使用原 edit-session + PATCH；服务端在原子 batch 开头用已有 `revision >= 0` CHECK 约束拒绝过期版本，使历史、正文、元数据、索引、审计整体回滚。无新迁移。部署回滚到旧服务端后，此 CLI 会因能力缺失而拒绝同步。

测试：`bun test scripts/file-workspace/core.test.mjs`。使用临时目录、真实 Hono API、SQLite 适配器与全部既有 migrations；覆盖范围、万字修改、冲突、重试、安全路径、并发事务。未完成 Windows 文件系统或 Cloudflare 实际部署验证。全仓 typecheck 当前受到扩展/官网缺失依赖影响；需与本次 API 类型检查结果区分。


## 附件工作流与升级

默认下载正文中引用的服务端附件到 `attachments/<附件ID>/<哈希>-文件名`，正文改为相对路径。下载需鉴权并校验 SHA-256 与字节数；绝不携带令牌访问第三方 URL 或跟随重定向。相对文件路径必须在工作目录内，不允许符号链接或 file://。单文件上限 100 MiB，当前不是分片/流式落盘方案。

在本地加入图片或 PDF，并在 Markdown 中插入标准链接；下一次 sync 自动上传后用 `/api/v1/resources/<ID>/blob` 提交正文。本地正文继续保留相对路径。附件内容改变时创建新资源，绝不覆盖旧资源；删除文件或移除引用不删除服务端资源。引用仍在但本地文件缺失时阻止推送，status 返回 attachment-error。下载的是被正文引用的附件，不是全部孤立资源。

状态自动升级为 v2，原 v1 状态备份到 `.edgeever/state-v1.backup.json`；分别记录本地 hash/base 与 serverHash/serverBase，以及附件路径/ID/SHA 映射和上传回执。升级后不要用旧 CLI 写同一目录。回滚需先保留本地新修改及整个 `.edgeever` 目录，再恢复升级前的工作目录快照。

每次上传先写日志，再保存上传回执，最后保存正文。正文失败后重试复用回执。上传响应丢失时，通过所属笔记的资源列表按文件名、SHA、大小查找结果；如果仍无法确定是否成功，会停止而不是盲目重传。错误会提示具体文件；应待原请求结束后再次同步。不能确认失败时不要手改日志或强制重传。未被正文引用的上传结果暂时保留，不自动回收。

--dry-run 不上传、不下载、不改正文及同步基线；只检查文件和预计操作。--pull-only 不上传本地附件，但会下载远端正文所引用资源。本地附件与远端正文同时修改时，仍进入笔记冲突流程。客户端使用旧 `/file-workspace` 能力声明而没有 attachmentSync 时拒绝同步，须先升级本机服务。


确已确认原上传请求结束且服务端没有对应资源时，可运行 `workspace uploads <目录>` 查看日志 key，然后 `workspace retry-upload <目录> --key <key>` 显式授权重试，再执行 sync。该动作保留原日志；在原请求仍运行时使用可能留下重复资源，不能当作常规重试。
