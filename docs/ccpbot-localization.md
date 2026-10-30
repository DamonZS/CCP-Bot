# CCP-Bot 中文化与品牌改名方案

## 背景

本仓库（原 OpenBot）是 Bun + Hono + PostgreSQL + CopilotKit Intelligence + Tauri 的多包工作区，
界面语言全部为英文，产品名称为 OpenBot。目标是把它中文化（zh-CN 为默认界面语言，保留英文回退），
并把品牌统一改名为 **CCP-Bot**。

## 目标

1. 简体中文成为默认界面语言；缺词回退英文原文，绝不出现空白或 key 泄漏。
2. 语言可在设置页切换（中文 / English），选择持久化。
3. 品牌标识统一为 CCP-Bot：界面文案、窗口标题、包名、环境变量前缀、容器/镜像/Helm 名称。
4. 全部改动机器可验证：typecheck、biome、bun test、vite build 通过。

## 非目标

- 不重写界面布局、不改业务逻辑、不改数据库结构。
- 不翻译代码注释、测试名、日志字段、协议字段、数据库列名。
- 不引入重型 i18n 依赖（不引入 i18next / @formatjs），使用本仓库自带的轻量词典。
- 不改 LICENSE 中的版权与授权信息。

## 方案

### 词典式取词（source-string key）

`t("Save")` 以英文原文为 key 查询 zh-CN 词典：

- 命中返回中文；未命中返回原文。任何未翻译字符串都可安全上线。
- 不使用 `t("save.button")` 这类 key，避免为 500 个文件另造一套命名体系。
- 语言在模块加载时读取一次（`localStorage`），切换语言时重载页面，因此不需要 React 上下文穿透。

模块位置 `app/src/lib/i18n/`：

- `locale.ts`：语言枚举、存储键、读写与解析。
- `messages/zh-CN.ts`：`Record<string, string>` 词典。
- `t.ts`：`t(source)` 与 `tf(source, vars)`（`{name}` 占位符）。
- `index.ts`：统一出口。

### 机械抽取

`scripts/i18n/scan.ts` 用 TypeScript 编译器 API 统计可翻译面（JSX 文本、placeholder/title/label/aria-label/alt 等属性）。
`scripts/i18n/codemod.ts` 做纯文本区间编辑（不重排代码、不格式化整文件）：

- JSX 文本：`保存` → `{t("Save")}`；
- 白名单属性：`placeholder="..."` → `placeholder={t("...")}`；
- 无插值字符串才会被包裹；含 `${}` 的模板串留给第二阶段人工处理。

### 品牌改名分层

| 层 | 内容 | 例子 |
| --- | --- | --- |
| 展示层 | 界面文案、窗口标题、托盘、文档标题 | `OpenBot` → `CCP-Bot` |
| 标识层 | 包 scope、Tauri identifier、Rust crate、二进制名 | `@openbot/shared` → `@ccpbot/shared`，`ai.copilotkit.openbot.desktop` → `ai.ccpbot.desktop` |
| 配置层 | 环境变量前缀、容器/镜像/Helm 名、脚本默认名 | `OPENBOT_*` → `CCPBOT_*`，`openbot-server` → `ccpbot-server` |

保留：`LICENSE` 版权行、上游文档外链、历史 CHANGELOG 条目原文。

## 验收

1. `bun run --filter app typecheck`、`--filter desktop typecheck` 通过。
2. `bunx biome lint .` 无新增错误。
3. `bun test` 关键套件通过（至少 app/server 相关）。
4. `bun run --filter app build` 成功。
5. `grep -ri openbot` 只剩 LICENSE、CHANGELOG 历史、外链等白名单命中。
6. 界面默认中文，设置页可切回 English。