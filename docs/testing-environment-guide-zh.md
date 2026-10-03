# 公开承包商测试环境指南

> 本文是面向承包商的公开脱敏指南，用于公开评估和经过授权的 staging 验证。不包含密码、token、私钥、数据库连接字符串、生产数据或私有源码链接。

## 1. 用途与两阶段执行方式

公开 hands-on 阶段：承包商克隆公开的 `vendure-project-briefing` 仓库，在自己的电脑、clone、fork、Codespace 或隔离 Linux runner 中查看脱敏任务并运行确定性的 demo。

正式验证阶段不同于公开 demo。项目方会冻结候选修订、任务输入、环境身份、夹具、工作流入口、证据要求、清理和回滚规则，然后通过受控工作流，在获得授权的 staging 环境中运行候选 Pipeline。公开 demo 成功只能证明可行性，不等于私有 Vendure 项目正式验收。

## 2. 公开 hands-on 材料

公开仓库：

`https://github.com/vendure-ai-factory/vendure-project-briefing`

使用公开分支 `codex/github-refactor-20260904`，并阅读仓库 README、`docs/START_HERE.md`、`docs/ACCEPTANCE_OVERVIEW.md`、`docs/CONTRACTOR_QUICKSTART.md` 和 `evaluation-demo/task.md`。

在 clone 中可以运行无秘密 demo：

```bash
node evaluation-demo/scripts/run-demo.mjs
bash evaluation-demo/scripts/verify.sh --acceptance
```

承包商可以查看更大的脱敏迁移输入包，修改自己的 clone 或 fork，并提交分支、commit 或 Pull Request 供审阅。公开 PR 不会授予私有仓库、VPS、production 或项目 `main` 分支的权限。

## 3. 经过授权的 staging 入口

项目方的 staging 服务与 production 分离。项目方授权具体任务并提供临时测试账号后，承包商可以使用以下公共入口：

| 用途 | 地址 | 边界 |
|---|---|---|
| staging 入口 | `https://staging.tibella.eu` | 仅 staging，不是 production |
| 健康检查 | `https://staging.tibella.eu/health` | 只读预检；预期 HTTP 200 和 `{"status":"ok"}` |
| Shop GraphQL | `https://staging.tibella.eu/shop-api` | 使用 POST GraphQL；最小身份检查为 `{ __typename }` |

Admin GraphQL、Dashboard、支付、业务写入和浏览器业务流程需要单独发放的 staging 测试账号、夹具和任务授权。不得使用 production 凭据或生产数据。

## 4. 代码如何进入 staging

正常受控路径是：

```text
承包商修订或获批准的私有候选分支
        -> 项目方审阅并冻结 Acceptance Manifest
        -> 受保护的 GitHub Actions 工作流
        -> 不可变镜像或固定版本产物
        -> 项目方控制的 staging VPS
        -> API / GraphQL / 浏览器 / 证据检查
```

staging 源码仓库和部署凭据由项目方控制。承包商运行公开 demo 或提交候选 Pipeline 时，不需要私有源码权限。如果正式任务确实需要私有源码，项目方可以临时授予 GitHub 协作者身份，只限约定仓库和分支或 Pull Request 流程。

## 5. 测试位置分工

### 承包商自己的环境或 GitHub Actions

- 使用 lockfile 安装依赖；
- 类型检查、lint、单元测试和确定性集成测试；
- 构建候选 Pipeline 和临时测试容器；
- 不依赖 staging 域名、持久化 staging 数据、VPS 身份、TLS、反向代理或 VPS 资源限制的代码级 E2E；
- 公开 demo 和脱敏输入包的证据生成。

### 项目方控制的 staging VPS

- 精确镜像和部署身份检查；
- staging 域名、TLS、CORS、公共路由和持久化检查；
- 迁移、重置、恢复、worker 队列以及 PostgreSQL/Redis 身份检查；
- 依赖 staging 夹具或 staging 域名的浏览器/API 流程；
- 压测和经过授权的非破坏性安全测试。

如果任务依赖 staging 域名、持久化数据、代理、VPS 身份或资源限制，GitHub Actions 通过不能替代 staging 结果。压测和红队工作必须有书面范围、测试窗口、速率限制、清理方案和明确授权，绝不能针对 production。

## 6. 临时访问规则

如果项目方决定让承包商直接操作正式 staging 测试，应分开授予以下临时权限：

1. 只有在确实需要源码时，才授予限于约定仓库和分支或 PR 流程的 GitHub 身份；
2. 只具有最低必要权限的 staging 测试账号；
3. 明确的任务卡、测试窗口、速率限制和清理方法。

不得向承包商提供 production 权限、VPS SSH/root、无限制 Docker 或 self-hosted runner、数据库/Redis 权限、仓库 secrets、私钥或部署文件中的凭据。约定工作或验收窗口结束后撤销权限。

## 7. 交付证据要求

每次正式运行至少应记录候选 commit 或 digest、任务输入、环境身份、命令或工作流运行记录、API/GraphQL/浏览器证据、日志和 trace、数据创建与清理、回滚或安全停止结果、失败检查和复现步骤。日志和证据不得包含密码、token、cookie、私钥或完整连接字符串。

`STAGING_ENVIRONMENT_READY` 只表示 staging API/worker 环境可用，不表示产品、定制 Pipeline、业务 E2E、压测或红队测试已经通过。

## 8. 2026-10-03 正式 VPS staging 与 Runner 配置

本节记录当前 Hostinger 的实际实施状态，说明基础设施边界和验证结果；它不表示产品或 Pipeline 已经通过最终验收。

### 8.1 主机与资源基线

- 主机：`srv748373.hstgr.cloud`、Ubuntu 24.04.2 LTS、x86_64、2 个 vCPU、约 7.8 GiB RAM、约 96 GiB 根分区。
- 创建并启用了 4 GiB `/swapfile`，权限为 `0600`，并写入 `/etc/fstab`。
- Runner 自带 Node `v20.20.2` 和 npm `10.8.2`。工作流必须使用这个固定工具链，或明确选择 Node 20/22，不能依赖未记录的宿主机 Node。
- 已安装 `postgresql-client`，`psql` 为 PostgreSQL 16.15；已安装 Playwright Chromium 系统依赖和浏览器包，缓存归 Runner 所有。
- 软件安装后 VPS 报告 `REBOOT_REQUIRED_PENDING`。本次没有重启；重启需要单独的项目方维护窗口授权。

当前资源上限如下：

| 组件 | CPU 上限 | 内存上限 |
|---|---:|---:|
| Vendure API | 1.0 CPU | 2 GiB |
| Vendure worker | 0.75 CPU | 1.5 GiB |
| PostgreSQL | 1.25 CPU | 1.5 GiB |
| Redis | 0.5 CPU | 512 MiB |

并发固定为 1 个作业。资源被杀、排队等待或依赖耗尽必须报告为 `DEPENDENCY_ENVIRONMENT`，不能算 Pipeline PASS。完整的 8 个 Batch 1 加 16 个 Batch 2 运行预计较慢，必须使用明确的延长超时，不能偷偷提高并发。

### 8.2 staging/Runner 分离

- staging 在 `/opt/nail-patterns-staging` 下由独立的 `nail-staging` 和 `nail-patterns-staging-app` Compose project 运行，拥有自己的内部网络、命名数据卷和 root-only secret 文件；API 仍绑定 `127.0.0.1:3100`，由 staging HTTPS 入口代理。
- GitHub Actions Runner 注册为 `staging-vps-rootless-runner`，以非特权用户 `gha-runner` 运行，使用独立 rootless Docker daemon `/run/user/1004/docker.sock`；systemd 服务已 enabled/active。
- `gha-runner` 不在 rootful `docker` 组中，SSH 也明确拒绝该服务账号登录。Runner 作业不能取得 rootful Docker socket，也不能把 Runner 服务账号当成 VPS 登录身份。
- `/opt/pipeline-archive` 是受控共享归档/证据目录，所有者为 `root:pipeline-archive`，权限 `2770`。Runner 用户和 staging 非 root `node` 用户都通过写入测试。它挂载到 staging API/worker，但不是数据库卷或 secret 卷。
- Runner 不加入 `nail-staging-internal`，也不挂载 staging PostgreSQL/Redis 数据卷；访问 staging 必须使用批准的 HTTPS/API 入口或明确批准的适配器。

公开评估工作流仍使用 GitHub 托管的 `ubuntu-latest`。公开 Pull Request 不得把任意代码放到这台 self-hosted Runner 上执行。staging 工作流必须受仓库 Environment 和分支/PR 控制保护。

### 8.3 受控 PostgreSQL gateway

旧脚本 `setup_tax_rates.mjs` 和 `admin_delist_products.mjs` 即使 dry-run 也会调用 Docker Compose 与 `psql`。现在通过最小化 gateway 支持它们，而不是开放 Docker socket 或 Docker 组：

- 按步骤使用的 `/opt/gha-runner/staging-bin/docker` 只允许 `docker compose ps -q postgres` 和 `docker exec -i <当前 staging postgres> psql -U vendure_staging -d vendure_staging ...`；
- `/usr/local/sbin/staging-postgres-ps` 与 `/usr/local/sbin/staging-postgres-exec` 是 `/etc/sudoers.d/90-staging-postgres-gateway` 中唯一的 sudo 白名单入口；
- 其他容器、其他数据库、`docker build`、`docker run`、卷操作、privileged 模式和任意 Docker 命令都会被拒绝。syslog 只记录操作类型，不记录 SQL 文本或凭据。

验证通过：允许路径返回 `SELECT 1`；错误数据库被拒绝；`docker run --privileged` 被拒绝。这个 gateway 只服务于上述两个脚本，不是通用 Docker 或 PostgreSQL 管理权限。

### 8.4 可审计运维入口和身份状态

- `/usr/local/sbin/pipeline-debug-status` 是受限只读状态入口，报告主机资源、staging Compose、staging health、Runner 状态和有限的 Runner journal 尾部；
- `/usr/local/sbin/pipeline-debug-runner-restart` 只能重启指定 Runner 服务，并通过 syslog 记录；
- 两个 wrapper 只通过空的 `pipeline-debug` 组和 `/etc/sudoers.d/90-pipeline-debug-ops` 提供；
- 当前还没有创建 `maleeha-debug` Linux 账号。创建它需要 Maleeha 的个人 SSH 公钥以及书面确认的开始/过期/撤销时间；创建后绝不能拥有 root、无限制 sudo、Docker socket/组、数据库、Redis 或 production 权限。

### 8.5 备份、回滚和当前结果

VPS 上保留 root-only 回滚标记：`/root/vps-pre-formal-config-latest.path`、`/root/vps-pre-archive-mount-latest.path` 和 `/root/vps-pre-resource-limits-latest.path`。更早的 VPS 清理备份仍是古早网站隔离/归档的回滚点。本指南不公布备份中的具体内容和凭据。

变更后验证通过：

1. 两层 staging Compose 都在运行；Vendure API healthy，`https://staging.tibella.eu/health` 返回 HTTP 200 与 `{"status":"ok"}`；
2. Runner 服务 enabled/active，rootless Docker 报告版本 `29.3.1`；
3. Runner 用户和 staging 非 root 应用用户都能写入共享归档目录；
4. 受控 PostgreSQL gateway 通过允许路径测试，并拒绝负面测试；
5. 公开工作流边界、production 分离和“不修改 minipc”规则保持不变。

仍待完成、不能报告为 PASS：Maleeha 的 SSH 公钥接入、受保护 staging Environment 的审核人/分支限制、完整出站域名 allowlist、实际定制 Pipeline workflow、业务 E2E、压测和获准红队测试。当前基础设施结果为 `STAGING_RUNNER_INFRASTRUCTURE_READY`，不是 Pipeline 最终验收。
