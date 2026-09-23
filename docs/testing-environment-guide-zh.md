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
