# CCP-Bot

CCP-Bot 是一个智能体（agent）工作台：Vite/React 前端在 `:3010`，Hono server 在 `:3001`，
可以配套 Python/TypeScript 的 agent 运行时与每个 bot 独立容器运行。

本仓库是 **CCP 工具链里那一份** CCP-Bot：在 OpenBot（上游 `github.com/CopilotKit/OpenBot`，
MIT）基础上完成了

- **界面中文化**：zh-CN 为默认语言，`t()` 词典式取词（未命中的文案回退英文原文），左上角
  「设置 → General」可切回 English；
- **改名**：产品名 `CCP-Bot`，包名/环境变量前缀（`CCPBOT_*`）、Tauri identifier
  （`app.ccpbot.desktop`）、Docker 服务名与 Helm chart 名统一为 ccpbot；
- 上游链接、LICENSE 与 CHANGELOG 原样保留，便于追溯来源。

## 快速开始（源码模式）

```bash
git clone https://github.com/DamonZS/CCP-Bot.git
cd ccp
cp .env.example .env      # 然后填入 CPK_INTELLIGENCE_API_KEY 等密钥
bun install
bun run dev               # app :3010 + server :3001
```

源码模式需要 PostgreSQL（`docker compose up -d` 可起本地库）与 CopilotKit Intelligence 的密钥，
缺任意一项 server 会直接退出并说明缺什么。

## 在 CCP 里使用

CCP（`DamonZS/Claude-Codex-Pro-Tool`）的「CCP-Bot」页面可以直接内嵌本仓库的界面：
填地址即可连接已在运行的实例；本机没有的话，选一个空文件夹点「下载并准备」，CCP 会从本仓库
克隆、`bun install`、生成 `.env`，然后一键启动。

## 许可

MIT，见 `LICENSE`。上游版权归 CopilotKit 及其贡献者所有。