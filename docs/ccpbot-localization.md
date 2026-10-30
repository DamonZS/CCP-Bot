# CCP-Bot 中文化与品牌改名（实现记录）

## 背景

本仓库是 Bun + Hono + PostgreSQL + CopilotKit Intelligence + Tauri 的多包工作区，上游项目名为
**OpenBot**，界面语言全部为英文。本工作把它中文化（zh-CN 为默认界面语言，保留英文回退），并把
品牌统一改名为 **CCP-Bot**。

## 目标

1. 简体中文成为默认界面语言；缺词回退英文原文，绝不出现空白或 key 泄漏。
2. 语言可在设置页切换（简体中文 / English），选择持久化。
3. 品牌统一为 CCP-Bot：界面文案、窗口标题、包名、环境变量前缀、容器/Helm 名称、Rust crate。
4. 全部改动机器可验证：typecheck、vite build、bun test 通过。

## 非目标

- 不重写界面布局、不改业务逻辑、不改数据库结构。
- 不翻译代码注释、测试名、日志字段、协议字段、数据库列名。
- 不引入重型 i18n 依赖（不引入 i18next），使用仓库自带的轻量词典。
- 不改 LICENSE 中的版权与授权信息，不改上游外链，不改历史 CHANGELOG 条目。

## 词典式取词（source-string key）

`t("Save")` 以英文原文为 key 查询 zh-CN 词典：

- 命中返回中文；未命中返回原文，空串/纯空白条目视为未翻译。任何未翻译字符串都可安全上线。
- 不使用 `t("save.button")` 这类 key，避免为几百个文件另造一套命名体系。
- 语言在模块加载时读取一次（`localStorage` 键 `ccpbot-locale`），切换语言时写入存储并
  `location.reload()`，因此不需要 React 上下文穿透，也不需要在 500 个文件里订阅语言。
- 默认语言是 zh-CN，不读 `navigator.language`：没有人表达过偏好时，这个构建说的是中文。

模块位置 `app/src/lib/i18n/`：

| 文件 | 内容 |
| --- | --- |
| `locale.ts` | `Locale` 类型、存储键、`parseStoredLocale`、`resolveLocale`、`readLocale`、`applyLocale`、`currentLocale`（模块级缓存）、`resetLocaleCache`（测试缝）、`LOCALE_OVERRIDE_KEY`（测试锁定语言） |
| `messages/zh-CN.ts` | `export const ZH_CN: Record<string, string>`，按 source 排序，共 1711 条 |
| `t.ts` | `t(source)` 与 `tf(source, vars)`（`{name}` 占位符，未传的占位符原样保留） |
| `index.ts` | 统一出口 |

设置页入口：`app/src/components/settings/language-preference.tsx`，挂在
`app/src/routes/_authed/settings/index.tsx` 的 `General` 区首行。

## 机械抽取

`scripts/i18n/localize.ts` 用 TypeScript 编译器 API 做**纯文本区间编辑**（不重打印文件，保留原有
格式与注释）：

```
bun scripts/i18n/localize.ts scan --root app/src --out scripts/i18n/inventory.json
bun scripts/i18n/localize.ts apply --root app/src
```

判定面：

- JSX 文本：`Save` → `{t("Save")}`，换行与缩进折成单空格；首尾空格留在表达式外侧。
- 白名单属性整体取值：`aria-label="New conversation"` → `aria-label={t("New conversation")}`
  （属性内必须带花括号，否则 JSX 语法崩坏——这是第一版的实际事故）。
- 花括号内的字面量（子表达式、三元分支、`return "X"`、属性值）裸 `t("…")`，不带括号。
- `return "X"` 只在函数/变量/属性名匹配 label/title/text/description/hint/status/message/note/
  placeholder/explain… 且值以大写开头、不是 `Bearer`/`GET`/`JSON` 这类协议 token 时才包裹。
- 属性名白名单刻意不含 `message`/`name`，避免把请求载荷当成界面文案翻译。

实测：`2348 wraps, 1709 unique across 224/497 files`，分布
`{jsx-text:1035, jsx-expression:433, attribute:572, property:275, return-literal:33}`；
`apply` 后重扫为 0（幂等）。

配套脚本：

- `scripts/i18n/chunk.ts`：把未翻译项按每块 120 条切给翻译流程（`scripts/i18n/chunks/*.zh.json`）。
- `scripts/i18n/merge.ts`：合并 chunks + 手写条目，按 source 排序重写 `messages/zh-CN.ts`，缺项非零退出。
- `scripts/i18n/check.ts`：反向核对——列出源码里 `t()`/`tf()` 用到但词典没有的字符串
  （手写组件是主要来源）。当前 `0 missing, 1710 source strings used, 1711 entries`。

翻译术语表（固定）：Bot 保留英文；Channel=频道、Task=任务、Routine=例程、Approval=审批、
Connector=连接器、Skill=技能、Workspace=工作区、Runner=运行器、Container=容器、Supervisor=监管器、
Harness=执行环境、Turn=轮次、Conversation/Session=会话、Audit=审计、Provider=供应商、Catalog=目录、
Plugin=插件、Boundary=边界、Credential=凭据；URL/API/ID/MCP/CEL/JSON/SQL/SSO/OAuth/TTS/LLM/CLI/SDK
与各家产品名永不翻译。

## 品牌改名

`scripts/rebrand.ts` 一次扫全仓（`git ls-files`，按 2603 个文本文件）：

```
bun scripts/rebrand.ts              # dry run
bun scripts/rebrand.ts --write
bun scripts/rebrand.ts --repair-idents --write
```

替换顺序（顺序即全部技巧，形态互相嵌套）：

| 规则 | 结果 | 说明 |
| --- | --- | --- |
| `ai.copilotkit.openbot` → `app.ccpbot` | 26 | Tauri identifier |
| `OPENBOT_` → `CCPBOT_` | 798 | 环境变量前缀 |
| `OpenBot` → `CCP-Bot` | 展示 | 标语、窗口标题、文档 |
| `OpenBot` → `CcpBot` | 标识符 | `OpenBotRole`→`CcpBotRole`、`hasOpenBotAccess`→`hasCcpBotAccess` |
| `openbot` → `ccpbot` | 4723 | 包名、类名、后缀、容器名 |
| `OPENBOT` → `CCPBOT` | 21 | 全大写常量 |

`OpenBot` 的两种去向是必须的：展示名带连字符，但 `CCP-BotRole` 会让 TypeScript 在连字符处报
`',' expected`，与真正的问题无关。脚本按前后字符是否属于标识符字符（`[A-Za-z0-9_$]`）决定走哪条。

改名后随之改名的路径：`charts/openbot` → `charts/ccpbot`，以及 `ccpbot-page.ts`、`ccpbot-client.ts`、
`ccpbot-browser.ts` 与其测试文件、`extension/tests/fixtures/*ccpbot*`。

保留不动：`LICENSE`（版权行）、`CHANGELOG`（历史条目）、`bun.lock`/`package-lock.json`（由包管理器
重写）、`github.com/CopilotKit/OpenBot` 等上游外链。大小写敏感的 `openbot` 只应剩这些。

品牌最终值：`package.json` name `ccpbot`；workspaces `app/server/worker/shared/toolkit/extension`；
`@ccpbot/shared`、`@ccpbot/toolkit`、`@ccpbot/recorder-extension`；Tauri `productName` `CCP-Bot`、
`identifier` `app.ccpbot.desktop`；crate `ccpbot-desktop`、lib `ccpbot_desktop_lib`；
`examples/fintech` 的 brand 为 `{ tenantId: "ccpbot", productName: "CCP-Bot" }`
（`bun run generate:app-config` 生成 `app/src/lib/generated/application-config.ts`）。

## 测试语言

app 的 268 个测试文件断言的是英文原文（`role="button"` 名字 "Browser"），中文界面会让它们全部失败。
因此 `app/tests/preload.ts` 把整套测试锁定在源语言：

```ts
(globalThis as { __ccpbotLocale?: string }).__ccpbotLocale = "en";
```

`locale.ts` 的 `currentLocale()` 先读这个覆盖值，再读 `localStorage`，最后落到 `DEFAULT_LOCALE`
（zh-CN）。`app/tests/i18n.test.ts` 覆盖词典命中、未命中回退、`tf()` 插值、默认语言、存储键。

## 验收

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `bun run typecheck`（workspace 全部包） | 6/6 通过 |
| 前端构建 | `cd app && bun ../node_modules/vite/bin/vite.js build` | `built in ~27s`，仅 chunk 体积告警 |
| i18n 覆盖 | `bun scripts/i18n/check.ts` | `0 missing` |
| i18n 行为 | `bun test app/tests/i18n.test.ts` | 9 passed |
| 界面回归样本 | `bun test app/tests/browser-nav-item.test.tsx` | 18 passed |
| 品牌残留 | `git ls-files` + 排除白名单后 grep `openbot` | 仅 CHANGELOG 与上游外链 |
| Rust 清单 | `cargo metadata --offline --no-deps`（`desktop/src-tauri`） | 包 `ccpbot-desktop` |

已知遗留：`app/package.json` 的 `build` 脚本用相对路径 `node_modules/vite/bin/vite.js`，在 bun 把依赖
提升到仓库根时找不到该文件（上游原有行为），因此构建用上一行的显式路径执行。