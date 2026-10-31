# CCP-Bot 安装包实机验证报告

验证对象：Windows 安装包 `CCP-Bot_0.2.7_x64-setup.exe`（GitHub Release `v0.2.7`）
验证机器：本机 Windows x64，用户 `Damon`，已装 Docker 29.8.2，`gh` CLI 已登录
验证时间：2026-10-31 20:12–20:55（Asia/Shanghai）
验证方式：下载官方 Release 资产 → 静默安装 → 双击启动 → 走完向导 → 观察进程、端口、`<root>\logs\local-*.log` 与界面文字

---

## 0. 一句话结论

**装完之后，一个人必须自己提供两样东西**：第 3 步的模型凭据（AI 的 key／登录，或一个不需要 key 的 OpenAI 兼容端点），以及第 4 步的 CopilotKit Intelligence（登录一次，或粘贴一个 project key）。身份提供方不用配 —— 应用自己往 `.env` 写 `CCPBOT_SINGLE_USER=true`（身份开关），这一步不需要人。

**但 0.2.7 这个安装包配完这两样也起不来**：向导能一路走完、数据库能起来（`logs/local-postgres.log` 里有 `database system is ready to accept connections`，端口 55788），内建 Bot 却在启动瞬间退出：

```
$ bun --env-file=.env agent-bot/src/index.ts
error: Cannot find module '@ag-ui/encoder' from 'C:\Users\Damon\CCP-Bot\agent-bot\src\index.ts'
Bun v1.4.3 (Windows x64)
```

`http://127.0.0.1:3010/health` 从未返回 200，界面停在「That did not finish / The built-in Bot did not answer.」。这是安装器的步骤缺失，不是配置问题（根因见第 11 节）。

**「Bot 的手」（computer）在 0.2.7 里根本不存在**：0.2.7 的 `local.rs` 没有 computer 步骤，实测也没有 `computer\` 目录、没有 `local-computer.log`、没有 workspace 目录。默认工作文件夹 `workspace` 是 0.2.8 才引入的。

---

## 1. 验证对象与证据口径

### 1.1 安装包

```
PS> Get-FileHash C:\Users\Damon\AppData\Local\Temp\ccpbot-verify\CCP-Bot_0.2.7_x64-setup.exe -Algorithm SHA256 | Format-List

Algorithm : SHA256
Hash      : ACF2F44ED1EA6E115CCE6550911AB29CA57F60FE7EABD3C26AC535CDFCFA544F
Path      : C:\Users\Damon\AppData\Local\Temp\ccpbot-verify\CCP-Bot_0.2.7_x64-setup.exe

PS> Get-Item ...\CCP-Bot_0.2.7_x64-setup.exe | Select-Object Name, Length, LastWriteTime | Format-List

Name          : CCP-Bot_0.2.7_x64-setup.exe
Length        : 4768020
LastWriteTime : 2026/10/31 20:12:06
```

### 1.2 资产表（`gh api` 原样输出，权威来源）

```
PS> gh api repos/DamonZS/CCP-Bot/releases --paginate -q '.[] | select(.tag_name=="v0.2.7" or .tag_name=="v0.2.8") | .tag_name as $t | .assets[] | "\($t) \(.name) \(.size)"'

v0.2.8 CCP-Bot_0.2.8_aarch64.dmg 9624923
v0.2.8 CCP-Bot_0.2.8_x64-setup.exe 4783472
v0.2.8 CCP-Bot_0.2.8_x64_en-US.msi 6987776
v0.2.8 container-images.json 3063
v0.2.7 CCP-Bot_0.2.7_aarch64.dmg 9615973
v0.2.7 CCP-Bot_0.2.7_x64-setup.exe 4768020
v0.2.7 CCP-Bot_0.2.7_x64_en-US.msi 6971392
v0.2.7 container-images.json 3063
```

平台覆盖：Windows 有 `x64-setup.exe` + `x64_en-US.msi`；macOS **只有 `aarch64.dmg`**（Apple Silicon，无 Intel 包）。

### 1.3 证据口径

- 界面文字：窗口截图（自己写的 `grab.ps1`，窗口矩形与 PNG 像素 1:1 对应）与点击脚本（`clickwin.ps1`/`clicktype.ps1`，按窗口内偏移点击，不依赖屏幕绝对坐标）——报告里引用的界面文字都是截图上的原样文本。
- 日志：直接读 `<root>\logs\local-*.log` 原文件内容。
- 进程/端口/目录：`Get-Process`、`netstat`、`Get-ChildItem` 原样输出。
- 源码引用：本地检出 `D:\Project\CCP-Bot`，以及 `git show v0.2.7:desktop/src-tauri/src/local.rs` / `git show v0.2.8:...`。**源码只用来解释运行时，运行时才是证据。**

### 1.4 本机前置状态（会影响结果的）

- Docker 在跑（`docker version --format {{.Server.Version}}` → `29.8.2`），且本机开发检出的容器在跑：`bot-postgres-1` 占 `127.0.0.1:5432`、`bot-agent-computer-1` 占 `127.0.0.1:4100`、`bot-supervisor-1` 占 `127.0.0.1:4500`、`ccpbot-control-plane` 占 `127.0.0.1:62779`。
- 端口 3010 开始时空闲。
- 本机原本已装 **0.2.8**（`H:\CCP-Bot`，并有 HKCU 卸载项和两个快捷方式）。为做这次验证，先停掉了它正在跑的进程（pid 31596），安装前导出了注册表副本。**验证结束后已把它卸载干净并删除运行根，机器回到「未安装」状态**（见第 12 节）。

---

## 2. 实测时间线

| 时刻 | 事件 |
| --- | --- |
| 20:12 | 下载 0.2.7 setup.exe（4,768,020 B） |
| 20:16 | `/S` 静默安装完成（exit 0，0.6 s），落到 `H:\CCP-Bot` |
| 20:17 | 双击启动，窗口出现；**无任何服务进程、3010 空闲** |
| 20:19–20:23 | 向导 Step 1（框架）→ Step 2（安装） |
| 20:24:49 | 下载源码部署包（`.ccpbot-deployment` 记录版本 `v0.2.8`） |
| 20:25:17 | 依赖装完 |
| 20:23–20:32 | 点「Install CCP-Bot」→ 8 个镜像就位（实际下载 194.7 MB）→ 20:32:14 界面出现「Installation complete」 |
| 20:39 | 点「Start CCP-Bot」→ 进入 local 模式 |
| 20:43:54 | 便携 PostgreSQL 起来（端口 55788） |
| 20:44:57 | 内建 Bot 崩溃：`Cannot find module '@ag-ui/encoder'` |
| ~20:48 | 界面显示「That did not finish / The built-in Bot did not answer.」 |
| 20:53 | 停止应用（pid 6300） |
| 20:54 | 卸载 0.2.7，删除运行根，残留进程清理 |

---

## 3. 步骤 1：下载安装包

```powershell
$t = 'C:\Users\Damon\AppData\Local\Temp\ccpbot-verify'
gh release download v0.2.7 --repo DamonZS/CCP-Bot `
  --pattern "CCP-Bot_0.2.7_x64-setup.exe" `
  --dir $t --clobber
```

输出（节选）：文件落到 `$t\CCP-Bot_0.2.7_x64-setup.exe`，`Length 4768020`，SHA-256 见 1.1。

---

## 4. 步骤 2：静默安装

```powershell
$p = Start-Process -FilePath "$t\CCP-Bot_0.2.7_x64-setup.exe" -ArgumentList '/S' -Wait -PassThru
$p.ExitCode
```

```
0
```

耗时 0.6 秒，**不需要管理员**。安装位置不是新建目录，而是复用了本机已记住的位置：

```
PS> Get-ChildItem 'H:\CCP-Bot' -Force | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

Name                 Length LastWriteTime
----                 ------ -------------
ccpbot-desktop.exe 19427328 2026/10/31 18:23:42
uninstall.exe         79319 2026/10/31 20:16:47

PS> (Get-Item 'H:\CCP-Bot\ccpbot-desktop.exe').VersionInfo | Select-Object FileVersion, ProductVersion

FileVersion    ProductVersion
-----------    --------------
0.2.7          0.2.7

PS> Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CCP-Bot' |
    Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString, Publisher | Format-List

DisplayName     : CCP-Bot
DisplayVersion  : 0.2.7
InstallLocation : "H:\CCP-Bot"
UninstallString : "H:\CCP-Bot\uninstall.exe"
Publisher       : ccpbot
```

（提示：若机器上已有同产品旧版本，`/S` 会**覆盖到原安装目录**，不会问你去哪；想换目录要用 `/D=<路径>`，且必须是最后一个参数且不加引号。）

---

## 5. 步骤 3：双击启动 —— 它自己什么都不起

```powershell
Start-Process 'H:\CCP-Bot\ccpbot-desktop.exe'
Start-Sleep -Seconds 8
Get-Process ccpbot-desktop | Select-Object Id, MainWindowTitle, Path | Format-Table -AutoSize
Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>" | Select-Object Name
netstat -ano | Select-String ':3010\s'
Test-Path 'C:\Users\Damon\CCP-Bot'
```

实测：窗口标题 `CCP-Bot`，path `H:\CCP-Bot\ccpbot-desktop.exe`；**没有 bun / postgres / node 子进程**，**3010 空闲**，**`C:\Users\Damon\CCP-Bot` 不存在**。

→ 双击启动只开窗口，运行根与整套栈要等你在向导里点「Install」和「Start」。**这一步本身不会自己走到 `/health`。**

界面（首屏，原样文字）：

> **Your own AI coworkers, on this computer.**
> They answer questions, use the tools you connect, and can work in a browser for you.
>
> ［**Set up CCP-Bot**］  ← 主按钮
> Takes a few minutes. CCP-Bot installs what it needs first, then asks you to sign in to the AI plan you already have.
>
> ［Run it on this computer instead］  ← 次要按钮（右下）

---

## 6. 步骤 4：向导四步（每一步的原样文字）

### Step 1 of 4

> **STEP 1 OF 4** — **Your first Bot**
> CCP-Bot sets this up for you. If you write code, you can choose the agent framework below.
> ▸ Choose the agent framework
> ［Back］ ［Continue］

（我保持默认，只点 Continue。注意：即使在第 0 步点了「Run it on this computer instead」，第 1 步仍是这个共享向导。）

### Step 2 of 4 —— 这里就是「安装」

> **STEP 2 OF 4** — **Install CCP-Bot**
> Install the software CCP-Bot needs on this computer. This can take a few minutes. You'll sign in after installation finishes.
> *Using Docker for local services.*
> Where CCP-Bot lives：**C:\Users\Damon\CCP-Bot**
> ［Back］ ［Install CCP-Bot］

点下去之后，检查项依次变绿：

> ✓ Container engine — docker is answering. ［Complete］
> ✓ Deployment — **v0.2.8** in C:\Users\Damon\CCP-Bot ［Complete］
> ◐ Dependencies — Preparing the local runtime. ［In progress · 1s elapsed］
> … ◐ Local software — Downloading local software (6/8). 194.7 MB downloaded. ［In progress · 3m 18s elapsed］
> …
> 标题变成 **Installation complete** — "CCP-Bot's local software is ready. Next, connect your AI and CopilotKit accounts."
> ✓ Local software — Local software is downloaded (8/8).
> ✓ Recorder — The Recorder is ready.
> ✓ Installation — Local software is installed. Continue to sign in.
> ［Back］ ［Continue to sign in］

**两个值得注意的点：**

1. **即使选了「Run it on this computer instead」，Step 2 走的仍然是容器路径**，界面明确写 `Using Docker for local services.`，并拉了 8 个镜像（`ghcr.io/damonzs/ccpbot-agent-bot`、`ccpbot-agent-computer`、`ccpbot-server`、`ccpbot-supervisor`、`pgvector/pgvector:pg17` 等；本机多数镜像早已在本地，所以实际只下载了 194.7 MB）。`local.rs`（真正的本机模式）到第 7 节点 Start 之前根本没被调用。
2. **界面上的 "Deployment — v0.2.8" 不是你装的安装包版本**。实测装的是 0.2.7 的 exe，而它抓来的源码 tarball 是 `v0.2.8`：

```
PS> Get-Content 'C:\Users\Damon\CCP-Bot\.ccpbot-deployment' -Raw

{"version":"v0.2.8","layout":["agent-bot","agent-computer","app","bun.lock","bunfig.toml","docker-compose.yml","examples","extension","package.json","patches","scripts","server","shared","toolkit","tsconfig.base.json","worker"]}
```

（`layout` 里没有 `desktop/`：Release 源码包里不含「装它自己」的那个桌面应用。）

### Step 3 of 4 —— 模型凭据（**人必须配的第 1 样**）

> **STEP 3 OF 4** — **Connect your AI**
> Connect your provider with a supported plan or an API key.
> · OpenAI — Sign in with ChatGPT Plus, Pro, Team or Enterprise.
> · Anthropic — Sign in with a Claude Pro, Max, Team or Enterprise plan.
> · Google Gemini — Use a Google AI Studio key or sign in for Gemini API access.
> · xAI — Use an xAI API key or sign in to your xAI account.
> · Any OpenAI-compatible endpoint — Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.

选中一行才会展开两个标签页，例如 OpenAI：

> ［Sign in with my plan］ ［Use an API key］
> Opens OpenAI in your browser. Nothing is typed here and no key is stored.
> ［Sign in with OpenAI］ ［Use a saved ChatGPT sign-in］
> —— 或 ——
> Use a saved OpenAI API key／**OpenAI API key**：［输入框］

**本次实测我在这个框里填的是我自己的占位串 `sk-verify-placeholder`（不是产品要求的值，只为把向导走下去）。** 只要框里非空，「Continue」就从置灰变成可点 —— **向导不对 key 做任何校验**。

（补充：选最后一行的 OpenAI 兼容端点时，界面只要求 Base URL + 模型名，**不要求 key**，`Ollama`、`vLLM` 就是这样用的。）

### Step 4 of 4 —— Intelligence（**人必须配的第 2 样**）

> **STEP 4 OF 4** — **Connect to CopilotKit**
> Local installation is complete. Connect CopilotKit, then start CCP-Bot.
> CCP-Bot keeps your conversations in CopilotKit. Sign in and it sets the rest up for you.
> ［**Sign in to CopilotKit**］ ［Use a saved connection］
> ▸ Point at your own Intelligence server
> ▸ Sign in through your organization
> ▸ Installation options
> ［Back］ ［**Start CCP-Bot**］ ← 此刻是**置灰**的

展开第一个折叠区，原样文字：

> Enter your Intelligence server's addresses, then sign in to choose a project. CCP-Bot creates its Learning container for you. Sign-in requires Chrome or Microsoft Edge. You can also use an existing project key.
> **Project key**：［输入框，占位符 "the key from your own Intelligence"］
> **API URL**：`https://api.intelligence.copilotkit.ai`（**预填**）
> **Gateway WebSocket URL**：`wss://realtime.intelligence.copilotkit.ai`（**预填**）
> ［Sign in to Intelligence］

**本次实测我在 Project key 里填的是我自己的占位串 `cpk-verify-placeholder-not-a-real-key`（同样不是产品要求的值）。** 填完界面立刻变成：

> **Connected to CopilotKit.**

并且「Start CCP-Bot」变成可点 —— **同样不做任何校验，假 key 也会被当成已连接**。

（正常用户的路径是上面的「Sign in to CopilotKit」：浏览器登录 → 选/建一个 project → 自动拿到 `cpk-...` key。省掉这步的唯一办法是自建 Intelligence 服务器。）

---

## 7. 步骤 5：点「Start CCP-Bot」之后真正发生了什么

点击后应用进入本机模式（`local.rs` 的 `start()`）。它做的事，按日志与磁盘证据：

| 步骤（界面上叫） | 实测结果 |
| --- | --- |
| 源码部署包 | 20:24:49 已就位（`v0.2.8`） |
| 便携 PostgreSQL | 解包到 `<root>\postgres\pgsql`，数据目录 `postgres\data`，端口写在 `postgres\port` = **55788** |
| 数据库初始化 | `logs/local-postgres.log` 有 `database system is ready to accept connections` |
| 写 `.env` | 20:43:55 写入（内容见下） |
| 界面构建 | `<root>\app\dist\index.html` 已生成 |
| 数据库 schema | 已迁移 |
| **内建 Bot** | **20:44:57 崩溃**（`logs/local-bot.log`） |
| computer（Bot 的手） | **0.2.7 没有这一步** |
| server / worker | **没跑到** —— 没有 `local-server.log`、`local-worker.log` |
| `/health` | **从未返回 200** |

### 7.1 `<root>\.env`（原样内容，`C:\Users\Damon\CCP-Bot\.env`，506 B）

```

# Written by CCP-Bot local mode.
INTELLIGENCE_API_URL=https://api.intelligence.copilotkit.ai
INTELLIGENCE_GATEWAY_WS_URL=wss://realtime.intelligence.copilotkit.ai
INTELLIGENCE_API_KEY=cpk-verify-placeholder-not-a-real-key

# Written by CCP-Bot local mode.
DATABASE_URL=postgres://ccpbot@127.0.0.1:55788/ccpbot
PORT=3010
SERVER_PORT=3010
APP_DIST_DIR=C:\Users\Damon\CCP-Bot\app\dist
CCPBOT_SINGLE_USER=true
SERVER_INTERNAL_URL=http://127.0.0.1:3010
NODE_ENV=
MANAGED_AGENT_AG_UI_URL=http://127.0.0.1:55789
```

（`INTELLIGENCE_API_KEY` 那行是我在 Step 4 填的占位值；`MANAGED_AGENT_AG_UI_URL` 的 55789 是应用给内建 Bot 预分配的空闲端口，写在 `<root>\bot\port`。）

### 7.2 `logs\local-postgres.log`（原样）

```
2026-10-31 20:43:54.611 CST [27472] LOG:  starting PostgreSQL 17.6 on x86_64-windows, compiled by msvc-19.44.35213, 64-bit
2026-10-31 20:43:54.612 CST [27472] LOG:  listening on IPv4 address "127.0.0.1", port 55788
2026-10-31 20:43:54.723 CST [5984] LOG:  database system was shut down at 2026-10-31 20:43:52 CST
2026-10-31 20:43:54.832 CST [27472] LOG:  database system is ready to accept connections
2026-10-31 20:48:54.678 CST [29656] LOG:  checkpoint starting: time
```

### 7.3 `logs\local-bot.log`（原样，168 B —— 本次验证的决定性证据）

```
$ bun --env-file=.env agent-bot/src/index.ts
error: Cannot find module '@ag-ui/encoder' from 'C:\Users\Damon\CCP-Bot\agent-bot\src\index.ts'
Bun v1.4.3 (Windows x64)
```

### 7.4 界面上给出的失败提示（原样）

> **That did not finish**
> The built-in Bot did not answer.
> ▸ Technical details
> Get setup help

界面到这一步就停住了：`Start CCP-Bot` 的失败没有被兜住，界面的使用入口没有打开，`http://127.0.0.1:3010` 也没有服务在听。

---

## 8. 核心问题 1：双击装好的应用，它能不能自己一路走到 `/health` 200 与界面可用？

**0.2.7：不能。** 证据链：

1. 双击只开窗口（第 5 节：无子进程、3010 空闲、运行根不存在）。
2. 向导能走完，但它自己选的是**容器安装路径**（Step 2 写着 `Using Docker for local services.`）。
3. 点「Start CCP-Bot」后它**确实**进了本机模式：数据库起来了、`.env` 写了、界面构建了。
4. 内建 Bot 在启动瞬间因缺依赖退出（7.3），`local.rs` 的 `wait_for_health(BOT_TIMEOUT=90s, <bot>/health)` 必然失败，于是整个 `start()` 提前返回错误 → **server 与 worker 从未启动 → `/health` 从未 200**。
5. 界面给的提示就是 7.4 那三句。

**要走到 `/health` 200，缺的不是配置，是安装器要把 `agent-bot` 的依赖装上**（根因见第 11 节）。

---

## 9. 核心问题 2：装完之后，一个人到底还要配几样东西？

### 9.1 逐项回答

| 要配的东西 | 出现在哪一步 | 谁提供 | 不提供会怎样 |
| --- | --- | --- | --- |
| **模型凭据**（OpenAI/Anthropic/Gemini/xAI 的登录或 API key；或任意 OpenAI 兼容端点的 URL+模型名） | Step 3 of 4 | **人**（选 OpenAI 兼容端点时可完全不填 key） | 「Continue」置灰，走不到下一步 |
| **Intelligence 连接**（浏览器登录 CopilotKit 拿 `cpk-...`，或粘贴 project key；自建服务器则填三个值） | Step 4 of 4 | **人**（其中的 API URL / Gateway WS URL 已预填好托管默认值，通常只需 key 或登录） | 「Start CCP-Bot」置灰 |
| **身份提供方**（Google/Microsoft/Okta OAuth 或 `CCPBOT_SINGLE_USER`） | 向导里**不出现** | **应用自己写** —— 实测 `.env` 里被写入 `CCPBOT_SINGLE_USER=true` | 不需要人管；但若人为清掉它又没有 OAuth，服务器会拒绝启动（9.4） |
| 数据库、端口、界面目录、内建 Bot 地址、内部密钥 | 无 | **应用自己生成并写入**（`.env` + `<root>\.secrets`） | 无需人管 |

**结论：人只需要配 2 样（模型凭据 + Intelligence）。** 说「顶多配个 API key」基本对得上，但实际是**两个不同系统的凭据**：一个是模型（AI 的 key/登录），一个是 CopilotKit Intelligence（记忆与会话）。除此之外不需要别的配置。

### 9.2 `.env` 里出现过的每一个键（谁写的）

| 键 | 谁写的 | 说明 |
| --- | --- | --- |
| `INTELLIGENCE_API_URL` | 应用写（值来自向导，**预填**托管默认值） | `https://api.intelligence.copilotkit.ai` |
| `INTELLIGENCE_GATEWAY_WS_URL` | 应用写（同上，**预填**） | `wss://realtime.intelligence.copilotkit.ai` |
| `INTELLIGENCE_API_KEY` | **人填的值，应用落盘** | 登录 CopilotKit 得到，或粘贴自建服务器的 project key |
| `DATABASE_URL` | 应用写 | 含本次随机端口 55788 |
| `PORT` / `SERVER_PORT` | 应用写 | 固定 3010 |
| `APP_DIST_DIR` | 应用写 | `<root>\app\dist` |
| `CCPBOT_SINGLE_USER` | 应用写 | `true` —— **身份提供方因此不用人配** |
| `SERVER_INTERNAL_URL` | 应用写 | `http://127.0.0.1:3010` |
| `NODE_ENV` | 应用写 | 空 |
| `MANAGED_AGENT_AG_UI_URL` | 应用写 | 指向内建 Bot 端口 55789 |
| `AGENT_COMPUTER_URL` / `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | 应用写（**0.2.7 本次没跑到**，0.2.8 的 `write_env` 会写） | 指向 Bot 的「手」 |
| **`OPENAI_API_KEY`** | **本次全程没人写** —— 我填的模型 key 没进 `.env` | 见 9.3 |
| `GOOGLE_OAUTH_*` / `MICROSOFT_OAUTH_*` / `OKTA_OAUTH_*` / `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | 没有出现 | 用 `CCPBOT_SINGLE_USER=true` 代替 |
| `COMPUTER_TOKEN` / `MANAGED_AGENT_TOKEN` / `WORKER_SHARED_SECRET` / `AGENT_TOOL_TOKEN` / `KEY_ENCRYPTION_KEY` / `SUPERVISOR_TOKEN` | 应用自己铸（**不在 `.env`，在 `<root>\.secrets\*.dpapi`**） | Windows 上用 DPAPI 加密到当前用户，各 352 B |

`.secrets` 实测内容：

```
PS> Get-ChildItem 'C:\Users\Damon\CCP-Bot\.secrets' -Force | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

Name                       Length LastWriteTime
----                       ------ -------------
AGENT_TOOL_TOKEN.dpapi        352 2026/10/31 20:44:52
COMPUTER_TOKEN.dpapi          352 2026/10/31 20:44:53
KEY_ENCRYPTION_KEY.dpapi      352 2026/10/31 20:44:54
MANAGED_AGENT_TOKEN.dpapi     352 2026/10/31 20:44:55
SUPERVISOR_TOKEN.dpapi        352 2026/10/31 20:44:56
WORKER_SHARED_SECRET.dpapi    352 2026/10/31 20:44:57
```

### 9.3 一个诚实记录的观察：模型 key 的去向

我在 Step 3 填的 `sk-verify-placeholder` **没有出现在 `<root>\.env`**，也**没有出现在 `.secrets`**（那里只有上表 6 个应用自己铸的 token）。也就是说：本次本机模式里，**我没有观察到模型凭据被持久化到任何地方**。

同时源码里写得很清楚，模型 key 是**经 `.env` 送到内建 Bot 的**：

> `local.rs`（0.2.8）`bot_arguments()` 上方注释：*"`.env` is read through `--env-file`, so the model key the wizard collected reaches the Bot the same way it reaches the server, instead of being copied here."*
> `bot_environment()` 上方注释：*"The model key and any relay address come from `.env`, which is where the wizard already put them."*

而且本机开发检出的 `.env`（由桌面端容器路线写过）里**确实有**这一行，注释还写明是桌面端写的：

```
# Written by CCP-Bot Desktop. Anything else in this file is left alone.
OPENAI_API_KEY=…
```

→ 也就是说：容器路线会把模型 key 写进 `.env`（有本机开发检出的 `.env` 为证），但本次**本机模式**下没写。因为 Bot 在 import 阶段就崩了，我无法判断这是「第二条独立缺口」还是「另有注入路径」——**这点没有证据，不做断言**，留作 0.2.9 验证时一并看。

### 9.4 不填时，应用停在什么状态（界面/日志原文）

- **Step 3 没选模型**：「Continue」置灰，无额外提示（就停在这一步）。
- **Step 4 没填 Intelligence / 没登录**：「Start CCP-Bot」置灰（启用条件是：安装已完成 && `apiKey` 非空或已有保存的 key && 模型可启动）。界面也没有额外的错误文字，就是不让你点。
- **若绕过向导直接启动本机模式且 key 为空**：`.env` 里不会写 Intelligence 三项（应用逻辑是「三项全空就不写」），服务器会拒绝启动。源码原文（`server/src/config.ts`）：

  > `CopilotKit Intelligence is required and is not configured. Missing: ${missing.join(", ")}`

- **身份提供方缺失时**，源码原文（`server/src/auth/dev-actor.ts`）：

  > `No identity provider is configured. Set GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_* with BETTER_AUTH_SECRET and BETTER_AUTH_URL, or set CCPBOT_SINGLE_USER=true to run with one administrator and no sign-in. Refusing to start rather than serving a deployment where every visitor is an administrator.`

  （**本机模式自己会写 `CCPBOT_SINGLE_USER=true`，所以这条正常不会遇到**；上面两条是源码原文，本次实测没触发，因为我把 key 填了。部署级的说明在 `.env.example` 里也写着：*"Required: the server refuses to start without the URL, the gateway URL and the key below, because Intelligence owns durable threads and memory and a deployment without it forgets every conversation. There is no degraded mode."*）

### 9.5 落地位置

| 东西 | 位置 |
| --- | --- |
| 程序本体 | 安装目录（本机 `H:\CCP-Bot`）+ 卸载器 `uninstall.exe` + HKCU 卸载项 + 桌面/开始菜单快捷方式 |
| 运行根（源码、依赖、数据库、日志、`.env`、`.secrets`） | `%USERPROFILE%\CCP-Bot`（本机 `C:\Users\Damon\CCP-Bot`，2.6 GB / 160,361 个文件） |
| 它自己装的 bun | `<root>\ccpbot-engine\bun-1.4.3\bun.exe`（96 MB，随运行根一起删） |
| 便携 PostgreSQL 17.6 | `<root>\postgres\pgsql` + `<root>\postgres\data`（首次下载约 330 MB，之后复用） |
| Playwright 浏览器 | `<root>\browsers`（本次未用到） |
| 应用数据 | `%APPDATA%\app.ccpbot.desktop\last-launched-root.json`（34 B，内容 `"\\?\C:\Users\Damon\CCP-Bot"`） |
| Recorder 相关 | `%LOCALAPPDATA%\CCP-Bot\recorder`（卸载时由安装器清理） |

---

## 10. 核心问题 3：「Bot 的手」起没起，默认工作文件夹在哪？

**0.2.7：没有这只手。** 证据（全部是实测）：

- `local.rs`（v0.2.7）的 `start()` 步骤清单里**没有 computer 这一步**：checkout → runtime → database → 写 `.env` → dependencies → interface → schema → bot → server/worker。
- 磁盘上没有 `<root>\computer\`（`bot\port` 有，`computer\` 不存在）。
- `logs\` 里只有 `local-postgres.log` 与 `local-bot.log`，**没有 `local-computer.log`**。
- `.env` 里没有 `AGENT_COMPUTER_URL` / `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS`。
- 没有 workspace 目录：`Test-Path <root>\workspace` → `False`，`<root>\workspace.txt` → `False`。

**0.2.8 才有**（`git show v0.2.8:desktop/src-tauri/src/local.rs`）：

- 新增 computer 步骤（`local.rs:1494-1533`），界面上这一步叫 **"Hands"**，启动文案：*"Starting the computer your Bot works in…"*，成功后写 *"Bots work in <workspace> (/health <status>)."*
- **默认工作文件夹 = `<root>\workspace`**（即本机的 `C:\Users\Damon\CCP-Bot\workspace`），常量 `WORKSPACE_FOLDER = "workspace"`；用户可以在界面上点「Choose the folder a Bot works in」换一个，选择记在 `<root>\workspace.txt` 一行文本里（删掉该文件即恢复默认）。
- 该进程跑在 `<root>` 下、入口 `agent-computer/src/index.ts`，Bot 在里面的文件操作与命令执行由 `agent-computer/src/workspace.ts` 限定在这个文件夹内。

---

## 11. 根因（**与上面的「0.2.7 实测状态」分开看**）

> 这两件事要分开：**第 8 节是 0.2.7 在真机上的实测结果**（确定的事实）；**本节是为什么**（由源码与磁盘状态定位）。

**根因：`agent-bot` 不是根 workspace 的成员，而安装器的本机模式里没有任何一步去装它的依赖。**

1. 根 `package.json`（部署包里那份，由安装器下载）：

```json
"workspaces": ["app", "server", "worker", "shared", "toolkit", "extension"]
```

`agent-bot` 与 `agent-computer` **都不在列表里**。所以根目录的 `bun install` 永远不会给它们装依赖。

2. `agent-bot/package.json` 需要三个包：

```json
"dependencies": { "@ag-ui/core": "0.0.57", "@ag-ui/encoder": "0.0.57", "openai": "^4.104.0" }
```

3. 磁盘状态证实它们从未被装上：

```
PS> (Get-ChildItem 'C:\Users\Damon\CCP-Bot\node_modules' -Force | Measure-Object).Count
9
PS> Get-ChildItem 'C:\Users\Damon\CCP-Bot\node_modules' -Force | Select-Object -ExpandProperty Name
.bin  .bun  @biomejs  @copilotkit  @types  playwright-core  roughjs  typescript  yaml

PS> Test-Path 'C:\Users\Damon\CCP-Bot\node_modules\@ag-ui'      → False
PS> Test-Path 'C:\Users\Damon\CCP-Bot\node_modules\openai'      → False
PS> Test-Path 'C:\Users\Damon\CCP-Bot\agent-bot\node_modules'   → False
```

4. `local.rs` 里**没有** `agent-bot` 的依赖安装步骤，但**有** `agent-computer` 的（v0.2.8，`local.rs:1442-1448`），注释原文自证了这个工作区机制：

   > *"The computer's dependencies are installed apart from the rest: it is deliberately not a workspace member, so `bun install` at the root never touches it, and a checkout that has never run a computer has no `node_modules` there yet."*
   > → `run_bun(&bun, &root.join("agent-computer"), &["install"])`

   **同样的理由对 `agent-bot` 成立，但代码里没有对应的那一段。** v0.2.7 与 v0.2.8 的 `local.rs` 都没有。

5. 于是内建 Bot 用 `bun --env-file=.env agent-bot/src/index.ts` 从根目录启动时，必然报 `Cannot find module '@ag-ui/encoder'`（7.3 的日志），后续的 server / worker / `/health` 全部不会发生。

**所以：0.2.7（以及同样缺这一步的 0.2.8）配好 key 也起不来，这不是偶发、不是网络问题、也不是用户少配了什么——是安装器的步骤缺失。**

---

## 12. 卸载与清理（把机器还给「未安装」状态）

```powershell
# 1) 先停掉正在运行的应用
Get-Process ccpbot-desktop | Stop-Process -Force

# 2) 静默卸载（NSIS 卸载器）
$p = Start-Process -FilePath 'H:\CCP-Bot\uninstall.exe' -ArgumentList '/S' -PassThru
$p.WaitForExit(120000) | Out-Null
$p.ExitCode
```

```
0
```

卸载结果（原样）：

```
H:\CCP-Bot exists: False
HKCU key exists: False
desktop shortcut: False
start menu shortcut: False
%LOCALAPPDATA%\CCP-Bot: False
HKCU NativeMessagingHosts app.ccpbot.recorder: False
```

→ **卸载是干净的**：安装目录、注册表卸载项、两个快捷方式、`%LOCALAPPDATA%\CCP-Bot`（含 Recorder 的 NativeMessagingHosts 注册）全部清除。

**运行根不会被卸载器删**（安装器只清理 `%LOCALAPPDATA%\CCP-Bot`，碰不到 `%USERPROFILE%\CCP-Bot`）。本次按验证要求手动删除，删除前记录：

```
PS> Get-ChildItem 'C:\Users\Damon\CCP-Bot' -Force | Select-Object Mode, Name, Length | Format-Table -AutoSize
（共 31 项：agent-bot/agent-computer/app/bot/ccpbot-engine/examples/extension/logs/node_modules/patches/postgres/scripts/server/shared/toolkit/worker、
 .secrets、.ccpbot-dependencies.json、.ccpbot-deployment、.ccpbot-engine.json、.ccpbot-local、.ccpbot-prepared.json、.env、bun.lock、bunfig.toml、
 container-images.json、docker-compose.yml、package.json、tsconfig.base.json）

size MB: 2606.6
files: 160361
```

**删除时踩到一个值得记录的坑**：`Remove-Item` 一开始失败，因为**应用退出后便携 PostgreSQL 还活着**——6 个 `postgres.exe`（启动于 20:43:54）仍持有 `postgres\data` 与 `logs\local-postgres.log`：

```
Remove-Item: The process cannot access the file 'C:\Users\Damon\CCP-Bot\logs\local-postgres.log' because it is being used by another process.
Remove-Item: The process cannot access the file 'C:\Users\Damon\CCP-Bot\postgres\data' because it is being used by another process.
Remove-Item: Access to the path 'C:\Users\Damon\CCP-Bot\postgres\pgsql\bin\postgres.exe' is denied.

PS> Get-Process postgres | Select-Object Id, StartTime, Path
17108 … 31612  postgres  2026/10/31 20:43:54  C:\Users\Damon\CCP-Bot\postgres\pgsql\bin\postgres.exe
```

结束这些进程后才删掉：

```powershell
Get-Process postgres | Stop-Process -Force
Remove-Item 'C:\Users\Damon\CCP-Bot' -Recurse -Force
```

清理后的机器状态：

```
ccpbot-desktop: 0
postgres: 0
port 3010: 0（空闲）
H:\CCP-Bot: False
HKCU uninstall key: False
C:\Users\Damon\CCP-Bot: False
```

（注意：我是**强杀应用**后观察到的残留 postgres。应用自己的「Stop」按钮是否也会留下它，本次没有验证。）

---

## 13. 未验证 / 边界（别把这些当成结论）

1. **0.2.8 的 exe 没有实机走一遍**：本报告的真机证据来自 0.2.7。0.2.8 的资产大小/存在性已核对（1.2），源码差异已逐条读（第 10、11 节），但**没有在真机上装它**。0.2.9 出来后按同一套判据重跑并把结果写进本报告新章节。
2. **macOS 只发了 `aarch64.dmg`**：Intel Mac 没有安装包（仅从资产名判断，未在 macOS 上验证）。
3. **`.msi` 未试**：本次只验了 `x64-setup.exe`。
4. **容器路线（Docker）没有跑完**：向导 Step 2 拉了 8 个镜像并报「Installation complete」，但后续启动走的是本机模式，容器栈（`docker compose`）没有被验证。
5. **无 Docker 的机器上，向导是否直接进本机模式**：未验证。本机因有 Docker，首屏主按钮走的是容器路径（源码里的判断是「没有引擎时才默认本机模式」）。
6. **模型 key 最终落在哪**：见 9.3，未观察到，不做断言。
7. **应用自己的「Stop」路径**：未验证（本次是强杀进程）。

---

## 14. 复现用的完整命令序列（PowerShell）

```powershell
# 工作目录
$t = 'C:\Users\Damon\AppData\Local\Temp\ccpbot-verify'; New-Item -ItemType Directory -Force $t | Out-Null

# 1. 下载并核对安装包
gh release download v0.2.7 --repo DamonZS/CCP-Bot --pattern "CCP-Bot_0.2.7_x64-setup.exe" --dir $t --clobber
Get-FileHash "$t\CCP-Bot_0.2.7_x64-setup.exe" -Algorithm SHA256   # ACF2F44E…544F

# 2. 静默安装（不需要管理员）
(Start-Process "$t\CCP-Bot_0.2.7_x64-setup.exe" -ArgumentList '/S' -Wait -PassThru).ExitCode   # 0

# 3. 启动并确认「双击不会自己起栈」
Start-Process 'H:\CCP-Bot\ccpbot-desktop.exe'
Start-Sleep 8
Get-Process ccpbot-desktop | Select-Object Id, MainWindowTitle
docker ps --format '{{.Names}}  {{.Ports}}'          # 只有你自己的容器
netstat -ano | Select-String ':3010\s'               # 空
Test-Path 'C:\Users\Damon\CCP-Bot'                   # False

# 4. 界面上走完向导（Step1 Continue → Step2 Install CCP-Bot → Step3 选模型填 key → Step4 填 Intelligence → Start CCP-Bot）
#    之后观察：
Get-ChildItem 'C:\Users\Damon\CCP-Bot\logs' | Select-Object Name, Length, LastWriteTime
Get-Content 'C:\Users\Damon\CCP-Bot\logs\local-bot.log'          # ← 决定性证据
Get-Content 'C:\Users\Damon\CCP-Bot\.env'
try { (Invoke-WebRequest 'http://127.0.0.1:3010/health' -TimeoutSec 3 -UseBasicParsing).StatusCode } catch { 'never answered' }

# 5. 卸载 + 清理
Get-Process ccpbot-desktop, postgres -ErrorAction SilentlyContinue | Stop-Process -Force
(Start-Process 'H:\CCP-Bot\uninstall.exe' -ArgumentList '/S' -Wait -PassThru).ExitCode   # 0
Remove-Item 'C:\Users\Damon\CCP-Bot' -Recurse -Force
```

---

## 15. 待办（0.2.9 出来后按同一套判据重跑）

- 判据 A：`http://127.0.0.1:3010/health` 返回 200。
- 判据 B：`<root>\logs\local-*.log` 里的步骤链一路到 `ready`（含 `bot` 步骤成功、`computer` 步骤成功）。
- 判据 C：0.2.9 必须出现 **bot 步骤成功**（即 `@ag-ui/encoder` 类的模块缺失不再发生）。
- 判据 D：`<root>\workspace`（或所选文件夹）存在，且 `local-computer.log` 有 `/health` 响应 —— 也就是「Bot 的手」真的起来了。
- 附带查：9.3 的模型 key 去向问题。

*报告结束。所有界面文字、日志、命令输出均为本次验证的原样记录；引用源码的地方均标注了文件与行号。*