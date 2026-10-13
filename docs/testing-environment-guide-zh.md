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

Admin GraphQL、Dashboard、支付、业务写入和浏览器业务流程需要单独发放的 staging 测试账号、夹具和任务授权。Vendure 后台账号仅授予应用层权限，不代表 VPS、SSH 或 Docker 权限；凭据由项目方通过批准的私下渠道单独提供，不写入本公开指南、仓库或公开工件。不得使用 production 凭据或生产数据。

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

## 6. 临时访问规则与当前例外

本指南的默认做法仍是按任务授予最低必要权限；但本项目因流水线开发已明显超期，项目方已专门批准 Maleeha 在当前 staging/Runner 沙盒内自主开发、调试和运行测试，以减少逐项审批造成的等待。该例外只适用于 Maleeha 和当前测试沙盒，不是其他承包商的默认权限；准确范围及合作结束后的撤权清单见第 10 节。

当前 VPS 不承载 production。未来 production 将使用另一台独立 VPS；Maleeha 不获准访问未来 production 主机或 minipc。不要把当前 staging 沙盒权限复制到生产环境。

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

公开评估工作流仍使用 GitHub 托管的 `ubuntu-latest`；公开 Pull Request 不会自动在这台 self-hosted Runner 上运行任意代码。当前 staging workflow 通过 `workflow_dispatch` 手动启动，workflow 逻辑只允许 `main` 和 `codex/maleeha-pipeline` 两个 ref。GitHub `staging` Environment 当前没有 Required reviewers，部署分支为 No restriction。`vendure-project-briefing/main` 的公开仓库 PR 规则有效；另外三个私有仓库虽配置了分支规则，但当前 GitHub 方案不强制执行，不能把它们视为有效的审批或禁止直推屏障。Maleeha 另有单独的 VPS 主机管理员身份，详见第 10 节；这不改变 Runner 服务本身以 `gha-runner` 非特权账号运行的事实。

### 8.3 受控 PostgreSQL gateway

旧脚本 `setup_tax_rates.mjs` 和 `admin_delist_products.mjs` 即使 dry-run 也会调用 Docker Compose 与 `psql`。现在通过最小化 gateway 支持它们，而不是开放 Docker socket 或 Docker 组：

- 按步骤使用的 `/opt/gha-runner/staging-bin/docker` 只允许 `docker compose ps -q postgres` 和 `docker exec -i <当前 staging postgres> psql -U vendure_staging -d vendure_staging ...`；
- `/usr/local/sbin/staging-postgres-ps` 与 `/usr/local/sbin/staging-postgres-exec` 是 `/etc/sudoers.d/90-staging-postgres-gateway` 中唯一的 sudo 白名单入口；
- 其他容器、其他数据库、`docker build`、`docker run`、卷操作、privileged 模式和任意 Docker 命令都会被拒绝。syslog 只记录操作类型，不记录 SQL 文本或凭据。

验证通过：允许路径返回 `SELECT 1`；错误数据库被拒绝；`docker run --privileged` 被拒绝。这个 gateway 只服务于上述两个脚本，不是通用 Docker 或 PostgreSQL 管理权限。

### 8.4 可审计运维入口和身份状态

- `/usr/local/sbin/pipeline-debug-status` 与 `/usr/local/sbin/pipeline-debug-runner-restart` 仍是项目方保留的状态查看/Runner 重启入口；它们不再是 Maleeha 当前权限的上限。
- 按 2026-10-13 权限变更记录，`maleeha-debug` 使用 Maleeha 提供的个人 SSH 公钥登录，拥有交互式 SSH、无限制 sudo，并加入 rootful `docker` 组。因此其权限实质等同于当前 VPS 沙盒的主机管理员：可管理该机上的 staging、Runner、容器、数据库及系统配置，而非只操作一个隔离容器。
- 该身份只适用于当前非生产 VPS；不包括未来独立 production VPS 或 minipc。Maleeha 的 Linux/VPS 身份与 Vendure 后台管理员账号属于不同系统层级。
- 本节对 VPS 权限的描述依据既有实施记录；本次更新只读核验了 GitHub 页面，没有使用 Maleeha 的私钥重新登录 VPS。不得在文档中记录 SSH 私钥、密码或 API key 的值。

### 8.5 备份、回滚和当前结果

VPS 上保留 root-only 回滚标记：`/root/vps-pre-formal-config-latest.path`、`/root/vps-pre-archive-mount-latest.path` 和 `/root/vps-pre-resource-limits-latest.path`。更早的 VPS 清理备份仍是古早网站隔离/归档的回滚点。本指南不公布备份中的具体内容和凭据。

变更后验证通过：

1. 两层 staging Compose 都在运行；Vendure API healthy，`https://staging.tibella.eu/health` 返回 HTTP 200 与 `{"status":"ok"}`；
2. Runner 服务 enabled/active，rootless Docker 报告版本 `29.3.1`；
3. Runner 用户和 staging 非 root 应用用户都能写入共享归档目录；
4. 受控 PostgreSQL gateway 通过允许路径测试，并拒绝负面测试；
5. 公开工作流边界、production 分离和“不修改 minipc”规则保持不变。

截至 2026-10-13，GitHub 协作者角色、Environment 审核人/分支设置和 workflow 允许的 ref 已按第 10 节核对；这只确认权限/入口配置，不代表任务已通过。仍待完成、不能报告为 PASS：完整出站域名 allowlist 的实际强制验证、流水线正式长链运行、Batch 1/Batch 2 业务验收、压测及获准红队测试。当前基础设施结果为 `STAGING_RUNNER_INFRASTRUCTURE_READY`，不是 Pipeline 最终验收。

## 9. 2026-10-11 Vendure staging 管理员账号

- Vendure staging 应用此前已完成首次启动初始化，已有 SuperAdmin；本次没有重置数据库、重建 staging 或更改现有管理员。
- 已在隔离的 Vendure staging 应用中新增专用后台管理员账号，供授权的 staging 开发/验收工作使用。该账号权限属于 Vendure 应用层，不是 VPS/Linux/SSH/Docker 身份，也不提供 production 访问。
- 登录凭据由项目方通过批准的私下渠道另行提供；密码不写入本指南、GitHub 仓库、日志或公开工件。请勿将凭据粘贴到代码或任务报告。
- 本次验证了新账号的 Admin API 登录、管理员记录和角色；staging health 与 Dashboard 页面也正常。此记录不代表 Pipeline 已完成或业务任务已通过。
- 如果 GitHub Actions 后续确实需要该账号，需另行由项目方将凭据放入受保护的 GitHub Environment secrets；本次没有创建或更新这些 secrets。


## 10. 2026-10-13 Maleeha 权限授权记录与合作结束撤权清单

项目方为减少超期开发中的逐项审批等待，已授权 Maleeha 在指定 GitHub 仓库和当前 staging/Runner 沙盒内自主修改、调试、合并迭代并运行获准测试。以下 GitHub 设置于 2026-10-13 在已登录页面核对；VPS 权限取自此前实施记录，本次没有用 Maleeha 私钥登录复测。本文不包含任何秘密值。

### 10.1 GitHub 仓库与分支操作权限

GitHub 账号 `Maleehaa06` 是直接协作者，不是组织 Owner：

| 仓库 | 当前角色 | 可进行的项目操作 |
|---|---|---|
| `vendure-project-briefing` | Write | 修改流水线工作流、代码和项目文档；在有效规则允许下创建 PR、启动 workflow 并迭代 |
| `pipeline-contract` | Write | 修改流水线代码/契约并提交 |
| `vendure-staging-baseline` | Write | 修改 staging Vendure 源码并提交 |
| `vendure-base-reference` | Write | 修改 Vendure 底座参考源码并提交 |
| `vendure-evaluation-input` | Read | 查看固定验收输入；不能直接改写 |

分支规则的实际生效情况：

- `vendure-project-briefing/main` 是公开仓库：PR、解决讨论、0 个必需审批、禁止强推/删除的规则有效；不需要项目方逐次批准，Maleeha 可以满足规则后自行合并。
- `pipeline-contract/main`、`vendure-base-reference/main` 和 `vendure-staging-baseline/codex/staging-vendure-3.7.3` 是私有仓库：虽配置了 PR、0 审批、禁止强推/删除，但当前 GitHub 方案不会强制执行这些规则。因此不能声称它们能阻止直推或提供有效保护；Maleeha 的 Write 角色可能允许直接推送/合并。
- GitHub `staging` Environment 当前没有 Required reviewers，部署分支设为 No restriction。staging workflow 用 `workflow_dispatch` 手动启动，代码只允许 `main` 和 `codex/maleeha-pipeline` 两个 ref。Maleeha 可以在允许的 ref 上启动获准运行，不必先把流水线合并到 `main`。
- Environment secrets 不会因 Write 角色而在设置页显示为明文，但能修改 workflow 并启动获准 Runner 作业意味着相关测试秘密可能被执行代码使用；只可放 staging/test 凭据，绝不放 production 凭据。

### 10.2 当前 VPS 沙盒权限

当前 VPS 只用于 staging 和 Runner；未来 production 使用另一台独立 VPS，minipc 也不在授权范围内。按既有实施记录，`maleeha-debug` 具有 SSH 登录、无限制 sudo 和 rootful Docker 权限，等同当前这台 VPS 的主机管理员，可以自行检查/改动该机上的 Runner、staging、容器、数据库与系统配置。Runner 服务仍以非特权 `gha-runner` 用户运行，但这不构成对主机管理员账号的隔离。Vendure 后台账号是单独的应用层身份；如需 Maleeha 实际登录后台，仍需确认其凭据是否已另行交付，不能把“账号已创建”误写成“承包商已拿到登录权”。

### 10.3 合作结束后的撤权与核验

先保留已验收代码、PR/commit、workflow run、报告及需要复用的测试夹具，然后按顺序执行：

1. **撤销 GitHub 身份：**移除 `Maleehaa06` 在上述五个仓库的直接角色；检查 team/org 继承授权、待处理邀请、deploy key、临时集成和项目方创建的 token，并一并清理。保存所需 PR、分支、workflow 与证据记录。
2. **关闭 VPS 登录：**锁定/删除 `maleeha-debug`，移除其 `authorized_keys` 公钥、sudoers 规则、`docker`/其他授权组成员关系和 SSH 配置引用；终止现有 SSH 会话并验证新登录失败。
3. **检查主机级持久化：**由于该身份有主机管理员权限，仅删账号不足以证明无残留。核查新用户/SSH key、sudoers、systemd service/timer、cron、Runner 注册和配置、启动项、Docker 容器/镜像/卷/网络、监听端口/防火墙规则及 staging 配置差异。若发现无法解释或无法验证的持久化改动，从可信基线重建 staging/Runner 后再恢复所需数据。
4. **回收 Runner 与工作流控制：**检查是否有新增 Runner 注册、服务、令牌或工作流入口；撤销/轮换 Runner 注册凭据，必要时由项目方身份重新注册；审阅并保留正式交付所需工作流，删除临时权限和不再需要的入口。
5. **撤销应用账号：**禁用/删除专用 Vendure staging 管理员（例如 `maleeha-staging@invalid.example`，若仍存在），轮换可能暴露的 staging SuperAdmin 密码；按证据保留要求清理临时账号/数据，同时保留需要的固定验收夹具。
6. **轮换测试凭据：**撤销或轮换 Maleeha/其工作流可使用过的 Stripe test key、OpenRouter key、GitHub Environment secrets、staging 管理员、数据库及其他临时凭据。production 凭据不得复用。
7. **完成关闭核验：**记录执行人、时间和结果；确认 GitHub 无访问、SSH 被拒、旧凭据失效、Runner 由项目方身份运行、staging health 和必要测试正常。未解释的主机差异不得标记为“已清洁”。

本节记录的是已批准/已实施的权限边界和未来离场步骤；更新文档本身没有改变 GitHub 角色、VPS 账号、SSH key、Runner、secrets 或业务状态。
