# 知识工作台部署

本 Fork 以 EdgeEver 1.74.0（`3c79414d8094f2cfde9c084a4f48a1d67bec86d6`）为基线，增加工作目录 API、笔记原子版本检查、附件元数据接口及独立 Node CLI。不新增数据库迁移；CLI 保持独立版本号。

在 `a20070322/edgeever` 手动运行 **Build Knowledge Workbench image** 工作流。它检查 API 类型、相关集成测试和 npm 包，再为 Linux amd64 构建 Web/API 容器。镜像标签为 `ghcr.io/a20070322/edgeever:kw-<完整提交SHA>`，同时输出带校验和的 Docker 镜像归档，供无法访问镜像仓库的主机使用。该工作流不发布 npm 包或上游桌面/移动端 Release。

本 Fork 排除上游自动同步任务，避免无人值守时替换定制代码。上游升级须复审和验证后推进 main。保留 1.74.0 的 `/api/openapi.json` 连通性探针；扩展接口说明放在 `file-workspace.openapi.json`。

部署前，在仓库外备份生产 `/data` 全卷和 Compose 配置。用旧实例的隔离副本验证新镜像，包括旧数据读取、工作目录拉取/回写/冲突/附件。验证通过后仅替换生产服务镜像，保留旧镜像及备份。升级失败时恢复旧镜像；若未来版本产生不兼容数据变化，则恢复升级前数据。严禁两个服务实例共用同一个 SQLite 卷。

凭据、数据库、笔记正文和备份不得进入 Git 或公开构建产物。Fork 源码继续遵守上游 AGPL 许可证。
