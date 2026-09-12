# Evaluation Input Sanitization Report

## 中文说明

### 目的

这份报告记录了本次“公开评价输入副本”在可移植性和安全性方面所做的清理。它给未来的 AI 和承包商使用，避免把某台电脑的路径或测试密码误当成项目要求。这里发布的是脱敏后的干净工作树副本，不是私有仓库的 Git 历史镜像。

### 本次已经完成

1. 将脚本和 E2E 测试中的本机路径改为仓库相对路径，或改为运行时环境变量。默认目录包括：
   - `./fixtures/美甲图案`：测试图片和目录结构；
   - `./artifacts`：日志、截图、CSV 和归档输出；
   - `./legacy/vendure-store`：旧 Vendure 输入代码。
2. 将硬编码测试密码、管理员密码和密码哈希替换为环境变量或明显占位符。当前代码不会提供任何可直接使用的密码。
3. 将数据库、地理数据、订单 CSV、导出脚本、批量发货脚本和截图路径改为可配置入口。
4. 更新了 `acceptance-inputs/测试任务.docx` 和 `legacy/vendure-store/MULTI_COUNTRY_TESTING_GUIDE.md`，不再要求使用 Windows、WSL、SSD 或某台机器上的固定路径，同时保留图片目录的层级规则。
5. 更新了 `SOURCE_LAYOUT.md` 和 `legacy/SOURCE_MANIFEST.md`，明确说明这是评价输入，不是目标运行环境，也不包含生产凭据；本公开副本不包含私有仓库历史。

### 运行前配置

请在本地终端或 CI 的受保护 Secret 中设置需要的变量；不要把真实值写进脚本、README、Issue、PR 或日志：

```bash
export EVALUATION_TEST_PASSWORD='your-local-test-password'
export EVALUATION_ADMIN_USERNAME='your-local-admin-username'
export EVALUATION_ADMIN_PASSWORD='your-local-admin-password'
export INPUT_DIR='./fixtures/美甲图案'
export ARTIFACTS_DIR='./artifacts'
```

按脚本需要，还可以设置 `ARCHIVE_ROOT`、`GEO_DATA_DIR`、`VENDURE_DB_PATH`、`ORDERS_EXPORT_CSV`、`LOG_FILE`、`LOOKUP_TABLE`、`TEST_ASSET_PATH`、`SCREENSHOT_PATH`、`EXPORT_SCRIPT`、`MARK_SHIPPED_SCRIPT`、`SUPERADMIN_USERNAME`、`SUPERADMIN_PASSWORD` 和 `SUPERADMIN_PASSWORD_HASH`。

如果没有设置密码变量，测试代码只会使用 `REPLACE_WITH_...` 这种明显占位符；需要密码的测试应先配置变量再运行。`SUPERADMIN_PASSWORD_HASH` 只供本地修复脚本使用，不能从数据库复制真实哈希到 Git。

### 目录结构不能打平

`fixtures/美甲图案` 的目录层级是评价的一部分，不能把所有图片混到一个目录。承包商应保持“每套设计一个目录、设计图与效果图按名称配对、`1/0` 为整套总效果图”的结构，并通过 `INPUT_DIR` 指向另一份同样结构的输入。

### 边界和安全提醒

- 这是评价/迁移输入代码，不是生产环境授权。
- 不要提交生产密码、API key、SSH key、真实客户数据、数据库文件、`.env` 文件或运行日志。
- 旧脚本中涉及数据库写入、批量发货、密码重置或管理员修复的功能，只能在隔离的测试数据库中运行。
- 代码中保留的 `localhost`、示例邮箱和 Vendure 业务名称是测试语境，不代表公开的生产入口。

### 验证结果

- 当前工作树扫描：未发现私钥、常见 Token、数据库连接串、固定 Windows/Linux 用户路径或旧硬编码测试密码。
- DOCX XML 可以正常解析，清理后的文档不再含固定的 Linux 用户目录、挂载盘目录或 Windows 用户/盘符路径。
- 在 Windows 工作树中使用 `git -c core.whitespace=cr-at-eol diff --check` 作为提交前检查，以免把正常的 CRLF 行尾误报为尾随空格。
- 这次没有复制或重写私有 Git 历史，也没有对私有仓库强制推送。公开仓库只接收经过审计的当前工作树副本；私有仓库及其历史仍由项目方控制。

## English note

This public package is an evaluation input, not a production credential store. It is a sanitized clean-tree publication rather than a mirror of the private repository's Git history. The current working tree was made portable: machine-specific paths now use repository-relative defaults or environment variables, and test/admin passwords or password hashes are supplied only at runtime through protected environment variables or clear replacement placeholders.

Use `./fixtures/美甲图案` for the structured test assets and `./artifacts` for local evidence. Keep the directory structure intact; it is part of the evaluation contract. Do not flatten the images or commit secrets, `.env` files, databases, customer data, SSH keys, or runtime logs.

The main code and DOCX input were checked for common secret patterns and machine-specific paths. The current public tree is sanitized. The private source repository and its history remain outside this public package and are not granted to contractors by this publication.

Future AI agents and contractors should read this report, `SOURCE_LAYOUT.md`, and the relevant evaluation documents before running anything. They should provide runtime secrets through the environment, use an isolated test database, and treat every script that writes data as a controlled evaluation action.
