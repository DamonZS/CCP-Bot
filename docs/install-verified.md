# CCP-Bot 安装包实机验证报告

同一台机器上按同一套判据跑了三轮，三轮的结论都保留：

| 部分 | 安装包 | 时间 | 一句话 |
| --- | --- | --- | --- |
| **Part 1 · v0.2.7** | `CCP-Bot_0.2.7_x64-setup.exe` | 2026-10-31 20:12–20:55 | 出厂状态起不来：内建 Bot 缺依赖模块，`/health` 从未返回 200 |
| **Part 2 · v0.2.9** | `CCP-Bot_0.2.9_x64-setup.exe` | 2026-10-31 21:30–22:25 | Bot 与「手」都修好了、真的能到 `/health` 200，但出厂状态仍被两个 blocker 挡住，要在向导外补两步 |
| **Part 3 · v0.3.2** | `CCP-Bot_0.3.2_x64-setup.exe` | 2026-10-31 23:36–2026-11-01 00:45 | **空机器一次成功**：8 分 21 秒到 `/health` 200，窗口自己就能显示应用；装完只需要一个模型 key |

验证机器：本机 Windows x64，用户 `Damon`，已装 Docker 29.8.2，`gh` CLI 已登录
验证方式：下载官方 Release 资产 → 静默安装 → 双击启动 → 走完向导 → 观察进程、端口、`<root>\logs\local-*.log` 与界面文字

---

# Part 1 · v0.2.7（2026-10-31 20:12–20:55）

验证对象：Windows 安装包 `CCP-Bot_0.2.7_x64-setup.exe`（GitHub Release `v0.2.7`）

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

---

# Part 2 · v0.2.9（2026-10-31 21:30–22:25）

验证对象：Windows 安装包 `CCP-Bot_0.2.9_x64-setup.exe`（GitHub Release `v0.2.9`，tag 指向 commit `470a83b`）
安装位置：`H:\CCP-Bot`（NSIS 自己选的路径，per-user 安装，全程没有管理员提示）
起始机器状态：干净 —— 没有旧安装、没有 `C:\Users\Damon\CCP-Bot`、3010 端口空闲

`<root>` 在本文里指应用自己的运行目录，默认是 `C:\Users\Damon\CCP-Bot`。

## 16. 一句话结论（v0.2.9）

0.2.7 的两个致命缺陷都修好了，而且 **Intelligence 改成不需要人配**；但 **出厂状态仍然起不来**，卡在两个 blocker 上，都要人在向导之外补一步：

| # | 出厂状态下发生什么 | 补一步之后 |
| --- | --- | --- |
| **B1** | 机器上还没有 `<root>` 目录时，点「Start CCP-Bot」约 6 秒后失败：`Could not remember the local choice.`，目录始终没被创建，什么都没下载、没写日志、没起进程 | `New-Item -ItemType Directory C:\Users\Damon\CCP-Bot` 之后再点一次，整套流程才继续走 |
| **B2** | 第 3 步填的模型凭据不落到任何地方（`<root>\.env` 里没有、`<root>\.secrets` 里也没有），内建 Bot 起来就退出：`OPENAI_API_KEY is not set, and no OPENAI_BASE_URL names an endpoint that needs no key. This Bot cannot answer without a model.` | 手动往 `<root>\.env` 追加一行 `OPENAI_API_KEY=…` 后，再点 Start，**12 秒**内 `/health` 返回 200 |
| **B3** | 栈起来了、`/health` 也 200 了，但应用自己的窗口不显示应用，只显示 `CCP-Bot could not verify its app on port 3010 belongs to this installation. Try starting CCP-Bot again.`；窗口里的「Stop CCP-Bot」也报 `Compose down failed: CCP-Bot has no runtime ownership for this installation.` | 无（本次靠浏览器直接开 `http://127.0.0.1:3010` 才看到界面） |

**「装完要配几样」的答案（v0.2.9 本地路线）**：设计上 **只差一样 —— 第 3 步那个模型凭据**。Intelligence 不用人配（应用自己给 server 进程塞一份占位连接），身份不用人配（应用自己写 `CCPBOT_SINGLE_USER=true`）。但这一样在 0.2.9 里 **没能交到内建 Bot 手里**（B2），所以实测要在向导外人为补两处。逐键表见第 22 节。

**「Bot 的手」**：0.2.9 真的有手了 —— `<root>\logs\local-computer.log` 有内容、`workspace` 目录被创建，默认工作文件夹就是 `<root>\workspace`（没人在界面上选过文件夹时）。见第 23 节。

---

## 17. 安装包身份与安装结果

### 17.1 下载与指纹

```powershell
$t = 'C:\Users\Damon\AppData\Local\Temp\ccpbot-verify'
gh release view v0.2.9 --repo DamonZS/CCP-Bot --json tagName,publishedAt,assets
gh release download v0.2.9 --repo DamonZS/CCP-Bot --pattern "CCP-Bot_0.2.9_x64-setup.exe" --dir $t --clobber
Get-FileHash "$t\CCP-Bot_0.2.9_x64-setup.exe" -Algorithm SHA256
```

```text
v0.2.9  publishedAt 2026-10-31T13:33:51Z
资产（三个）：CCP-Bot_0.2.9_aarch64.dmg 9625349 B ｜ CCP-Bot_0.2.9_x64-setup.exe 4783834 B ｜ CCP-Bot_0.2.9_x64_en-US.msi 6987776 B

文件: C:\Users\Damon\AppData\Local\Temp\ccpbot-verify\CCP-Bot_0.2.9_x64-setup.exe
字节: 4783834
SHA256: A1B57C731B95283ED5B0761FE412ED0EE869BB0551BD36C65883650824CE482D
VersionInfo: FileVersion 0.2.9   ProductVersion 0.2.9
```

平台覆盖（只看资产名就能判定）：Windows 有 **exe + msi** 两份；macOS 只有 **aarch64** 一份 dmg（没有 x64 dmg），所以 Intel Mac 没有可下载的安装包。
另外 `v0.2.9` 的 Release **没有 `container-images.json`**（0.2.7/0.2.8 都有一个 3063 B 的），这和下面「本地路线不再走镜像」是一致的。

### 17.2 静默安装

```powershell
$p = Start-Process "$t\CCP-Bot_0.2.9_x64-setup.exe" -ArgumentList '/S' -Wait -PassThru
$p.ExitCode
Start-Sleep 5
Get-Item 'H:\CCP-Bot\ccpbot-desktop.exe' | Select-Object Length, @{n='Ver';e={$_.VersionInfo.ProductVersion}}
(Get-FileHash 'H:\CCP-Bot\ccpbot-desktop.exe' -Algorithm SHA256).Hash
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CCP-Bot' |
  Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString, Publisher, EstimatedSize
```

```text
ExitCode: 0          用时 0.7 秒，没有弹管理员提示
H:\CCP-Bot\ccpbot-desktop.exe  19494912 B  Ver 0.2.9  LastWriteTime 2026/10/31 21:33:16
SHA256: 98118C72859A56873432BD3F166C9B3ACACD94D79D17DDEE33E58AFCA3720470
H:\CCP-Bot\uninstall.exe       79319 B     LastWriteTime 2026/10/31 21:35:07

DisplayName    : CCP-Bot
DisplayVersion : 0.2.9
InstallLocation: H:\CCP-Bot
UninstallString: H:\CCP-Bot\uninstall.exe
Publisher      : ccpbot
EstimatedSize  : 19115
```

- 只写了 **HKCU** 一处卸载表项，`HKLM`（含 WOW6432Node）没有对应项 ⇒ 不需要管理员。
- 快捷方式：`C:\Users\Damon\Desktop\CCP-Bot.lnk` 有，`…\Start Menu\Programs\CCP-Bot.lnk` 有，`C:\Users\Public\Desktop\CCP-Bot.lnk` 没有。
- 这次机器上**没有**任何旧安装记录，安装器仍然选了 `H:\CCP-Bot`（不是默认的 `%LOCALAPPDATA%\Programs` 之类）—— 也就是安装目录不受我控制，想换位置得用 `/D=<目录>`（必须是最后一个参数、不能加引号）。

### 17.3 双击启动：它自己什么都不起（两轮都一样）

```powershell
Start-Process 'H:\CCP-Bot\ccpbot-desktop.exe'
Start-Sleep 8
Get-Process ccpbot-desktop | Select-Object Id, StartTime, MainWindowTitle
(Get-CimInstance Win32_Process -Filter "ParentProcessId=<上一步的 pid>").Name
netstat -ano | Select-String ':3010\s'
Test-Path 'C:\Users\Damon\CCP-Bot'
```

```text
pid 16568 启动于 21:35:57  MainWindowTitle 'CCP-Bot'
子进程：msedgewebview2.exe（只有 WebView2，没有 bun / postgres / node）
3010：没有监听
C:\Users\Damon\CCP-Bot：False
```

⇒ **双击装好的应用，它不会自己把栈跑起来**；起栈必须走窗口里的向导。

界面文字（0.2.9 的欢迎页，与 0.2.7 逐字一致）：

```text
CCP-Bot
Your own AI coworkers, on this computer.
They answer questions, use the tools you connect, and can work in a browser for you.
[ Set up CCP-Bot ]
Takes a few minutes. CCP-Bot installs what it needs first, then asks you to sign in to the AI plan you already have.
[ Run it on this computer instead ]        ← 本报告走的是这条「本机模式」
```

> 一个只影响我这台机器的插曲：0.2.9 第一次启动时直接跳到了第 2 步（容器安装页，带 `Using Docker for local services.`），没有欢迎页。原因是上一轮 0.2.7 验证在 `%APPDATA%\app.ccpbot.desktop\last-launched-root.json` 里留下了一行 `"\\?\C:\Users\Damon\CCP-Bot"`；把它移走再启动，欢迎页就回来了。**0.2.9 自己不再写这个文件**（跑完一整轮后该目录是空的）。全新机器上不存在这个文件，不受影响。

---

## 18. 实测时间线（v0.2.9）

| 时间 | 发生了什么 |
| --- | --- |
| 21:33:16 | 0.2.9 安装完成（exit 0，per-user，`H:\CCP-Bot`） |
| 21:35:57 | 双击启动，只有窗口，3010 空闲，`<root>` 不存在 |
| 21:38–21:44 | 欢迎页 →「Run it on this computer instead」→ 第 1 步 →「Nothing to install on this computer」→ 第 2 步 → 第 3 步（选 xAI、填占位 key）→ 第 4 步（Intelligence 全空，Start 可点） |
| **21:45:14** | 点「Start CCP-Bot」→ **6 秒后 B1**：`Could not remember the local choice.`，`<root>` 仍不存在 |
| 21:45:5x | 手动 `mkdir C:\Users\Damon\CCP-Bot` → 再点 Start，开始下载/解包（21:47:45 拉取源码 tarball，21:48:07 下载 bun，21:48:07→21:51:37 下载 315 MB 便携 PostgreSQL） |
| 21:52:17 | 数据库起来（`postgres\port`=49773）；`bot\port`=49774、`computer\port`=49775 预分配 |
| 21:53:28 | `agent-bot\node_modules` 与 `agent-computer\node_modules` 出现（0.2.9 新增的 Bot 依赖安装步骤生效） |
| **21:53:50** | **B2**：`logs\local-bot.log` 出现 `OPENAI_API_KEY is not set…`，Bot 退出；21:55 界面显示 `That did not finish / The built-in Bot did not answer.` |
| 22:00:27 | 手动把占位模型 key 写进 `<root>\.env` → 再点 Start → **22:00:28 起栈、22:00:29 `/health` 200** |
| 22:07:28 → 22:07:40 | 第三次启动（缓存全命中）：**12 秒**到 `/health` 200；bot / computer / server / worker 四个进程齐全 |
| 22:15:09 → 22:15:19 | 第四次启动（用于取最终原文证据）：同样是 12 秒内 200 |
| 22:16–22:25 | 卸载测试 → 清理运行目录 → 重装 0.2.9（见第 25 节） |

---

## 19. 步骤 1–4：向导的原样界面文字（v0.2.9）

用「窗口内偏移」点击（窗口 916×679，原点每次启动由 `GetWindowRect` 现取），四步全部截了图。

### 第 2 步：`Nothing to install on this computer`（B 类问题已修）

```text
STEP 2 OF 4
Nothing to install on this computer
This step fetches nothing. The First Start prepares the runtime, the portable database,
the interface and its schema itself, then serves them from this folder.
Where CCP-Bot lives
[ C:\Users\Damon\CCP-Bot ]
[ Back ]  [ Continue ]
```

逐条核对 0.2.7 的问题：**没有** `Using Docker for local services.` 脚注、**没有**「Install CCP-Bot」按钮、**没有**「Repair installation」、**没有**镜像下载行；前进按钮是 `Continue`（不是 `Continue to sign in`）。这一页确实什么都不拉。

### 第 3 步：`Connect your AI`

```text
STEP 3 OF 4
Connect your AI
Connect your provider with a supported plan or an API key.
  OpenAI            Sign in with ChatGPT Plus, Pro, Team or Enterprise.
  Anthropic         Sign in with a Claude Pro, Max, Team or Enterprise plan.
  Google Gemini     Use a Google AI Studio key or sign in for Gemini API access.
  xAI               Use an xAI API key or sign in to your xAI account.
  Any OpenAI-compatible endpoint — Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.
[ Back ]  [ Continue ]   ← 没填之前是灰的
```

点开 xAI 行之后（`Use an API key` / `Sign in` 两个 chip）：

```text
[ Use an API key ] [ Sign in ]
Model name
[ grok-4.7 ]
xAI API key
[ •••••••••••••••••••••••••••• ]
Get a xAI API key.
```

本次填的是 `sk-verify-0.2.9-xai-placeholder`（占位串）。**界面不校验 key**：只要非空，`Continue` 就变亮。这一点两轮一致。

### 第 4 步：`Run CCP-Bot on this computer`（Intelligence 全空也能点 Start）

```text
STEP 4 OF 4
Run CCP-Bot on this computer
Installation is complete. This stack runs on this computer, and the model you chose is
enough to start it — a CopilotKit connection is optional here.
Optional on this computer: connect CopilotKit to keep conversations there. CCP-Bot starts without it.
[ Sign in to CopilotKit ]  [ Use a saved connection ]
▸ Point at your own Intelligence server
▸ Sign in through your organization
▸ Installation options
[ Back ]  [ Start CCP-Bot ]      ← 此时 Project key 为空、没做任何登录，Start 已经是可点的黑底
```

⇒ 0.2.7 那个「必须先有 Intelligence 才能点 Start」的门槛，0.2.9 已经拆掉，**而且是真的不用填就能起**（第 20.3 节的实测）。

---

## 20. 点 Start 之后真正发生了什么

### 20.1 B1：出厂状态下第一次点 Start 必然失败

```text
That did not finish
Could not remember the local choice.
▸ Technical details
Get setup help
```

展开 Technical details：

```text
writing C:\Users\Damon\CCP-Bot\.ccpbot-local failed: 系统找不到指定的路径。 (os error 3)
```

此时 `<root>` 不存在、3010 空闲、没有任何 `logs` 目录。源码级解释：

- `desktop/src-tauri/src/main.rs:644` 在 `async fn local_start` 里**先**调 `local::remember(&root)?`
- `local.rs:879-887` 的 `remember` 就是 `std::fs::write(<root>\.ccpbot-local, "local\n")`，目录不存在就 `os error 3`，并按 `local.rs:884-886` 报出这句 `Could not remember the local choice.`
- 真正会创建这个目录的是后面的部署下载（`deployment.rs:154` `std::fs::create_dir_all(root)?`），而它排在 `remember` 之后；向导四步自己也从不创建它（第 2 步的原话就是「This step fetches nothing.」）

**手动补一步即可越过**：

```powershell
New-Item -ItemType Directory -Path 'C:\Users\Damon\CCP-Bot' -Force
# 再回界面点一次 Start CCP-Bot
```

补完之后 `<root>` 立刻被填上 `.ccpbot-local`(6 B)、`.ccpbot-deployment`(228 B)、`bun.lock`、`bunfig.toml`、`container-images.json`、`docker-compose.yml`、`package.json`、`tsconfig.base.json`，以及 `agent-bot`、`agent-computer`、`app`、`examples`、`extension`、`patches`、`scripts`、`server`、`shared`、`toolkit`、`worker` 十一个目录。

### 20.2 B2：第 3 步的模型凭据没有交到内建 Bot

第一次真正走到 Bot 步骤时，`<root>\logs\local-bot.log`（171 B，原样）：

```text

$ bun --env-file=.env agent-bot/src/index.ts
OPENAI_API_KEY is not set, and no OPENAI_BASE_URL names an endpoint that needs no key. This Bot cannot answer without a model.
```

界面同时显示：

```text
That did not finish
The built-in Bot did not answer.
▸ Technical details      → http://127.0.0.1:49774 never answered /health. Last time: 由于目标计算机积极拒绝，无法连接。 (os error 10061)
Get setup help
```

查磁盘可以确认凭据**根本没落盘**：

- `<root>\.env`：11 个键，全部是应用自己写的，**没有模型键**
- `<root>\.secrets`：六个 352 B 的 DPAPI 文件（`AGENT_TOOL_TOKEN` / `COMPUTER_TOKEN` / `KEY_ENCRYPTION_KEY` / `MANAGED_AGENT_TOKEN` / `SUPERVISOR_TOKEN` / `WORKER_SHARED_SECRET`），**没有模型键**

源码级解释（这是「第 3 步白填了」的真正原因）：

- 前端 `desktop/src/App.tsx:603-610` 发起的是 `invoke("local_start", { request: { root, apiUrl, gatewayWsUrl, apiKey } })` —— 只带 Intelligence 三件套，**不带模型**
- 后端 `main.rs:629-635` 的 `LocalStartRequest` 只有 `root` / `api_url` / `gateway_ws_url` / `api_key` 四个字段，**结构里就没有模型这一项**，`local_start`（`main.rs:638-672`）自然也无从写入
- 模型凭据那套机制只挂在容器路线上：`main.rs:1783` `start_stack_credential(&root, model)` → `main.rs:1981-1997` `ccpbot_env::compose(… Model { credential } …)` → `main.rs:2016` `vault::split(settings)`（注释在 `main.rs:2007-2015`：凭据进本机凭据库、其余进 `.env`）

**手动补一步即可越过**（这也是本仓库 `docs/local-mode.md:107` 记录的团队自测做法）：

```powershell
Add-Content 'C:\Users\Damon\CCP-Bot\.env' 'OPENAI_API_KEY=sk-verify-0.2.9-openai-placeholder'
# 再回界面点一次 Start CCP-Bot
```

### 20.3 补完 B1+B2 之后：真的能到 /health 200

```powershell
(Invoke-WebRequest 'http://127.0.0.1:3010/health' -UseBasicParsing).Content
(Invoke-WebRequest 'http://127.0.0.1:3010/api/capabilities' -UseBasicParsing).Content
(Invoke-WebRequest 'http://127.0.0.1:3010/' -UseBasicParsing).StatusCode
```

```text
HTTP 200  application/json
{"status":"ok"}

{"mode":"intelligence","durableHistory":true,"generativeUi":true,"selfHostBanner":true,
 "localEvaluation":true,"transcription":false,"voice":false,
 "authProviders":[],"ssoConfigured":false,"ssoRequired":false}

3010 根路径：200，index.html 1043 B（<title>CCP-Bot</title>，<html lang="zh-CN">）
```

启动耗时（第三次启动，全部缓存命中）：`22:07:28` 数据库起 → `22:07:32` 还没 200 → `22:07:40` **200**，即 **12 秒**。第四次 22:15:09 → 22:15:19 同样是 12 秒。

四个进程与四个端口（原样）：

```text
bun  ×4   （pids 9540 / 29524 / 33004 / 33744）
监听：::49774 内建 Bot      ::49775 computer（Bot 的手）      ::3010 server     127.0.0.1:49773 PostgreSQL
bot\port = 49774      computer\port = 49775      postgres\port = 49773
```

端口是每次启动**随机挑空闲端口**的，所以不会和你开发用的容器（`127.0.0.1:5432`）撞车。

五个日志文件（`<root>\logs\`，两轮合计追加）关键行原样：

```text
--- local-bot.log ---
$ bun --env-file=.env agent-bot/src/index.ts
agent-bot listening on http://127.0.0.1:49774/ag-ui

--- local-computer.log ---
$ bun agent-computer/src/index.ts
{"type":"computer-sandbox","sandbox":"off","note":"Chromium runs without its own sandbox, which is the only thing that works under a default container seccomp profile. Set COMPUTER_SANDBOX=on where the host allows it."}
{"type":"computer-browser-mode","mode":"headless","display":null}
agent-computer listening on http://127.0.0.1:49775

--- local-server.log ---
AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true lets a Bot reach this machine's own services. Fine locally, and for local development only. Remove it before deploying.
{"type":"learning-auto-assign","outcome":"unavailable","containerId":"ccpbot","message":"Intelligence could not be asked about the Learning container. CCP-Bot tries again."}
{"type":"computer-isolation","provider":"shared","isolation":"one shared computer","warning":"Every person's Bots run on one computer. Set COMPUTER_SUPERVISOR_URL for a computer per person."}
[CopilotKit Runtime] telemetry enabled — see https://docs.copilotkit.ai/telemetry to opt out (set COPILOTKIT_TELEMETRY_DISABLED=true).
No identity provider is configured, so every request is treated as dev@ccpbot.local (administrator). Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_* before anybody else can reach this.
CCP-Bot server listening on http://127.0.0.1:3010
{"type":"intelligence-entitlement-unreadable","reason":"Runtime entitlement request failed"}
{"type":"self-host-banner-entitlement-unavailable","reason":"Runtime entitlement request failed"}
{"type":"model-check-unreadable","provider":"openai","model":"gpt-5.6-terra","reason":"The operation timed out.","fix":"Could not ask openai whether gpt-5.6-terra is available. This is often temporary."}
{"type":"intelligence-memory-unavailable","reason":"PlatformRequestError","timestamp":"2026-10-31T14:01:33.020Z"}

--- local-worker.log ---
$ bun ../worker/src/index.ts
CCP-Bot worker status: idle
{"type":"routine-sweep","offered":[],"considered":0,"fired":[],"skipped":[]}
{"type":"routine-sweep-purge","purged":0}

--- local-postgres.log ---
2026-10-31 22:15:09.368 CST [32528] LOG:  starting PostgreSQL 17.6 on x86_64-windows, compiled by msvc-19.44.35213, 64-bit
2026-10-31 22:15:09.369 CST [32528] LOG:  listening on IPv4 address "127.0.0.1", port 49773
2026-10-31 22:15:09.617 CST [32528] LOG:  database system is ready to accept connections
2026-10-31 22:15:09.725 CST [32024] ERROR:  database "ccpbot" already exists
2026-10-31 22:15:09.725 CST [32024] STATEMENT:  CREATE DATABASE ccpbot;
```

（最后两行是复用已有数据库时的正常现象：它每次都尝试 `CREATE DATABASE ccpbot`，已存在就报个 ERROR 继续。`git grep -n "create_dir_all"` 式的细枝末节不在这里展开。）

---

## 21. 三条验收判据逐条核对

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| **A** `/health` 返回 200 | ✅ **做到了**（但要 B1+B2 两处人工补救） | `{"status":"ok"}`，`22:00:29` / `22:07:40` / `22:15:19` 三次；第三次 12 秒 |
| **B** 步骤链一路到 `ready` | ⚠️ **部分可证** | 逐进程日志按 `postgres → bot → computer → server/worker` 顺序出现；失败时界面会点名失败的那一步（`The built-in Bot did not answer.` + `<addr> never answered /health`）。界面上的「进度行」本轮从未渲染（原因见第 24.2 节），所以没有逐行文字可抄 |
| **C** bot 步骤成功（0.2.7 的缺模块不再发生） | ✅ **做到了** | 0.2.9 新增 `[dependencies] Installing the Bot's dependencies…`：`<root>\agent-bot\node_modules` 现在有 `@ag-ui`、`openai`、`zod` 等约 45 个包，而根 `<root>\node_modules` 仍只有 9 项（`.bin .bun @biomejs @copilotkit @types playwright-core roughjs typescript yaml`），`Test-Path <root>\node_modules\@ag-ui\encoder` = **False** |
| **D** 「Bot 的手」起来了 | ✅ **做到了** | `local-computer.log` 有 3 段启动记录并输出 `agent-computer listening on http://127.0.0.1:49775`；`<root>\workspace` 建好 |

---

## 22. 核心问题 2：装完到底还要配几样（`<root>\.env` 逐键）

### 22.1 逐键表（v0.2.9，原样内容）

```text
（文件开头是空行）
# Written by CCP-Bot local mode.
DATABASE_URL=postgres://ccpbot@127.0.0.1:49773/ccpbot
PORT=3010
SERVER_PORT=3010
APP_DIST_DIR=C:\Users\Damon\CCP-Bot\app\dist
CCPBOT_SINGLE_USER=true
SERVER_INTERNAL_URL=http://127.0.0.1:3010
NODE_ENV=
MANAGED_AGENT_AG_UI_URL=http://127.0.0.1:49774
AGENT_COMPUTER_URL=http://127.0.0.1:49775
AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true
OPENAI_API_KEY=sk-verify-0.2.9-openai-placeholder      ← 这一行是本次验证人工追加的（缺陷 B2）
```

| 键 | 谁写的 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | **应用自己写** | 指向便携 PostgreSQL 的随机端口 |
| `PORT` / `SERVER_PORT` | **应用自己写** | 都是 3010 |
| `APP_DIST_DIR` | **应用自己写** | 已构建好的前端目录 `<root>\app\dist` |
| `CCPBOT_SINGLE_USER` | **应用自己写** | **身份这一项不用人配**：写 `true` 就不需要 Google/Microsoft/Okta OAuth，服务端日志里对应显示「every request is treated as dev@ccpbot.local (administrator)」 |
| `SERVER_INTERNAL_URL` | **应用自己写** | 服务端自己调自己 |
| `NODE_ENV` | **应用自己写** | 写空 |
| `MANAGED_AGENT_AG_UI_URL` | **应用自己写** | 内建 Bot 的地址（本例 49774） |
| `AGENT_COMPUTER_URL` | **应用自己写** | 「手」的地址（本例 49775） |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | **应用自己写** | `true`，允许 Bot 访问本机服务 |
| `OPENAI_API_KEY` | **本该应用写、这一版没写**（B2） | 第 3 步收集的模型凭据的**唯一**落地位置；本次由人手动 `Add-Content` 补上 |
| `INTELLIGENCE_API_URL` / `INTELLIGENCE_GATEWAY_WS_URL` / `INTELLIGENCE_API_KEY` | **人没填就不出现，而且不填也能起来** | 见 22.2 |

`<root>\.secrets`（Windows DPAPI 凭据库，应用自己 mint，人不用管）：`AGENT_TOOL_TOKEN.dpapi`、`COMPUTER_TOKEN.dpapi`、`KEY_ENCRYPTION_KEY.dpapi`、`MANAGED_AGENT_TOKEN.dpapi`、`SUPERVISOR_TOKEN.dpapi`、`WORKER_SHARED_SECRET.dpapi`，每个 352 B。**没有模型凭据文件**（B2 的另一面）。

### 22.2 Intelligence 这一版确实不用人配（但代价是相关能力关闭）

0.2.7 的向导要求先填 Intelligence 才能点 Start；0.2.9 把这条门槛拆了 —— 第 4 步明确写「a CopilotKit connection is optional here」，Project key 空着 Start 就能点，而且真的能起（第 20.3 节）。

机制在 `local.rs`：

```rust
// local.rs:151-168
/// The CopilotKit Intelligence connection a local run answers for itself.
/// … server/src/config.ts refuses to start without a URL, a gateway address and a key, and it has no
/// way of knowing that a desktop install has no CopilotKit account behind it … These three values are
/// what satisfies that check — the ones the ignored live test has always used …
pub const LOCAL_INTELLIGENCE: [(&str, &str); 3] = [
    ("INTELLIGENCE_API_URL", "http://127.0.0.1:9/api"),
    ("INTELLIGENCE_GATEWAY_WS_URL", "ws://127.0.0.1:9/gateway"),
    ("INTELLIGENCE_API_KEY", "sk-local-placeholder-for-a-desktop-run"),
];
```

`server_environment`（`local.rs:1354-1370`）只在 `.env` 里**没有**真的 Intelligence 凭据时，把这组值塞进 **server 进程的环境变量**（不写文件，注释里解释了原因：写进 `.env` 会让向导和容器路线以为这份部署「已连接」）。

代价（原样日志）：URL 指向 `127.0.0.1:9`（discard 端口），所以任何真正访问 Intelligence 的功能都会失败 —— `intelligence-entitlement-unreadable`（权益）、`intelligence-memory-unavailable`（记忆/耐久会话）、`learning-auto-assign outcome: unavailable`（Learning 容器）。`/api/capabilities` 仍报 `mode=intelligence`、`durableHistory=true`，但请求打不通。

**结论**：想让 Bot 只用你自己那个模型跑，可以完全不配 Intelligence；想让会话/记忆落到 CopilotKit，才需要在第 4 步登录或粘 project key（那时才会写进 `.env`）。

---

## 23. 核心问题 3：「Bot 的手」起没起、默认工作文件夹在哪

**起来了。**（0.2.7 里根本没有这一步。）

- 日志：`<root>\logs\local-computer.log` 有内容，最后一行 `agent-computer listening on http://127.0.0.1:49775`
- 端口：`<root>\computer\port` = 49775，进程是第 4 个 `bun`
- 浏览器模式：`{"type":"computer-browser-mode","mode":"headless","display":null}` —— 无头 Chromium
- 沙箱：`{"type":"computer-sandbox","sandbox":"off", …}` —— 在容器里跑才需要关，桌面安装下它默认也是关的，注释说可以用 `COMPUTER_SANDBOX=on` 打开
- 隔离级别：`{"type":"computer-isolation","provider":"shared","isolation":"one shared computer"}` —— 所有 Bot 共用一台「手」

**默认工作文件夹**：`<root>\workspace`，本例即 `C:\Users\Damon\CCP-Bot\workspace`。

```powershell
Test-Path 'C:\Users\Damon\CCP-Bot\workspace'      # True（22:00:29 创建，空）
Test-Path 'C:\Users\Damon\CCP-Bot\workspace.txt'  # False  ← 没人选过文件夹
```

源码：`local.rs:382-391` `workspace_folder(root)` = 记住的选择，否则 `root.join("workspace")`；`local.rs:396` `set_workspace_folder` 会写 `workspace.txt`（界面上的「Choose the folder a Bot works in」按钮，改完下次启动生效）。所以**没动过界面的话，Bot 的手就在 `<root>\workspace` 里读写和执行命令**。

界面上的对应行（`LocalRun.tsx`，仅当本地屏渲染时可见）：`Hands on your files` — `Working in <workspace>. It reads, writes and runs commands there.`

---

## 24. 界面可用性：为什么窗口里看不到应用（B3）

### 24.1 窗口显示什么

栈健康、`/health` 200 的情况下，应用窗口显示的是：

```text
Refresh your CopilotKit connection
Update this connection to reopen your existing CCP-Bot.

That did not finish
CCP-Bot could not verify its app on port 3010 belongs to this installation. Try starting CCP-Bot again.
Get setup help

[ Show CCP-Bot ]   [ Stop CCP-Bot ]
```

点 `Show CCP-Bot` 没有反应；点 `Stop CCP-Bot` 报的是另一句：

```text
That did not finish
Compose down failed: CCP-Bot has no runtime ownership for this installation. Stop its containers using the original engine and context before starting CCP-Bot again.
```

（Stop 虽然报错，但确实把 3010 放开、把 bun/postgres 子进程杀了 —— 三次都这样。）

源码解释：`main.rs:2998` 在 `owned_app_url(&root, ports)` 为 `None` 时抛上面那句；`main.rs:3199-3206` 的 `owned_app_url` 要求同时满足 `stack::recorded_server_owns_port` 与 `stack::recorded_process_owns_port(root, "app", ports.app)`，两者都读 `stack.rs:1342-1344` 的 `host_pids_path(root)` = `<root>\.logs\host-pids.json`。而 **`local.rs` 里没有任何 `host_pids` / `record_process` / `ownership` 调用**（grep 为空），实测 `<root>\.logs` 目录也**不存在**（存在的只有 `<root>\logs` 与五个 `local-*.log`）。⇒ 本地路线从不写这份所有权记录，窗口因此永远认不出自己启动的应用。

### 24.2 界面可用性：浏览器里是好的

```powershell
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --headless=new --disable-gpu --no-first-run `
  --user-data-dir=$t\edge-profile --window-size=1400,900 --virtual-time-budget=15000 `
  --screenshot=$t\ui-3010.png 'http://127.0.0.1:3010/'
```

得到的页面（`ui-3010.png`，28,268 B）：标题 **`欢迎来到 CCP-Bot`**，中间是 orb，一个输入框写着 `Hand off tasks to your team of Bots`，下面一个黑底 `继续` 按钮。

⇒ **应用本身是能用的**（在浏览器里打开 `http://127.0.0.1:3010` 就行）；只有「装它的那个桌面窗口」因为 B3 显示不了它。

### 24.3 顺带发现：第一次启动时看不到任何进度

第一次启动要下载源码 tarball + bun + 315 MB PostgreSQL，实测从点 Start 到数据库起来花了 **4.5 分钟**（21:47:42 → 21:52:17）。这段时间窗口里**没有任何进度行**：20 秒一拍的截图 `prog-01…20.png` 大小几乎相同（≈61.9 KB），画面一直停在 STEP 4 OF 4 那一页。

源码解释：`desktop/src/App.tsx:1121` 渲染本地进度屏（`<LocalRun/>` + `<SetupProgress steps={steps}/>`）的条件是 `!running && returningToInstallation && !refreshIntelligence`；首次启动时这个条件不成立，所以只有等它跑完（或失败）才有变化。进度行本身存在（`LocalRun.tsx:43-53` 的标签表：`runtime`→Runtime、`database`→Database、`dependencies`→Dependencies、`interface`→Interface、`schema`→Database schema、`bot`→Built-in Bot、`computer`→**Hands**、`server`→Services、`ready`→**Answering**），只是首次启动不显示。

### 24.4 顺带发现：关掉应用不会停掉本地栈

实测：强杀 `ccpbot-desktop` 后 4 秒，`bun` 仍有 4 个、`postgres` 仍有 30 个进程、3010 仍在监听 —— 本地栈被留在了机器上（而应用内的 Stop 按钮又因为 B3 报错）。要停下来只能 `Get-Process bun, postgres | Stop-Process -Force`。

---

## 25. 卸载与清理（v0.2.9）

```powershell
Get-Process ccpbot-desktop -EA SilentlyContinue | Stop-Process -Force
Get-Process bun, postgres -EA SilentlyContinue | Stop-Process -Force
$u = Start-Process 'H:\CCP-Bot\uninstall.exe' -ArgumentList '/S' -Wait -PassThru
$u.ExitCode
Start-Sleep 12
Test-Path 'H:\CCP-Bot'
Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CCP-Bot'
Test-Path 'C:\Users\Damon\Desktop\CCP-Bot.lnk'
Test-Path "$env:LOCALAPPDATA\CCP-Bot"
Test-Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\app.ccpbot.recorder'
Test-Path 'C:\Users\Damon\CCP-Bot'      # ← 运行目录
```

```text
ExitCode: 0
H:\CCP-Bot: False
HKCU 卸载表项: False
桌面快捷方式: False        开始菜单快捷方式: False
%LOCALAPPDATA%\CCP-Bot: False
Chrome native messaging: False
运行目录 C:\Users\Damon\CCP-Bot: True      2619.6 MB
```

⇒ **卸载很干净**：程序、快捷方式、卸载表项、`%LOCALAPPDATA%\CCP-Bot`（含 recorder 与 local-computer）全清；**用户自己的运行目录 `<root>` 原封不动保留**（2619.6 MB 的数据库、源码、日志都留着）。这一点和 `windows/hooks.nsh` 的设计一致。

删运行目录要先杀进程（否则 PostgreSQL 占着文件）：

```powershell
Get-Process bun, postgres, node -EA SilentlyContinue | Stop-Process -Force
Start-Sleep 4
Remove-Item 'C:\Users\Damon\CCP-Bot' -Recurse -Force     # True
```

### 最终机器状态（本次验证结束时）

| 项 | 状态 |
| --- | --- |
| `H:\CCP-Bot` | **已重装 0.2.9**（`ccpbot-desktop.exe` 版本 0.2.9、HKCU 卸载表项在、桌面快捷方式在）—— 为了和验证开始时「机器上有一个已安装版本」保持一致；不想要就 `H:\CCP-Bot\uninstall.exe /S` |
| 运行目录 `C:\Users\Damon\CCP-Bot` | **已删除**（我这次的测试数据，含占位 key） |
| 进程 / 端口 | `ccpbot-desktop` 0、`bun` 0、`postgres` 0、3010 空闲 |

---

## 26. 未验证 / 边界（v0.2.9）

1. **macOS 没跑**：只有 arm64 机型有安装包（`aarch64.dmg`），本次没有 Mac 可用；Intel Mac 目前没有资产可下。
2. **msi（`CCP-Bot_0.2.9_x64_en-US.msi`）没跑**：只验证了 exe/NSIS 这条。
3. **容器路线（有 Docker 时）没跑**：本机装了 Docker，向导默认也确实是容器路线，但本次全程走「Run it on this computer instead」。
4. **模型凭据是占位串**：`sk-verify-0.2.9-xai-placeholder` 与 `sk-verify-0.2.9-openai-placeholder` 都不是真 key，所以只证明「栈能起、Bot 能监听」，**没有真的发一次对话**给模型；`local-server.log` 里的 `model-check-unreadable` 就是它去问 OpenAI 时打的。
5. **Intelligence 真账号没验证**：Project key 与「Sign in to CopilotKit」两条路径都没真的走完（本轮刻意留空）。用真凭据时那些 `intelligence-*-unavailable` 是否消失，未验证。
6. **应用内 Stop 的成功路径未验证**（因为 B3 每次都报错）；「关掉窗口」也不会停栈（24.4）。
7. **Recorder（浏览器录制扩展）未验证**。
8. **第 3 步选「登录 OpenAI/Anthropic 计划」那条分支未验证**（本轮选的是 API key 分支）。
9. 本轮所有点击都是按「窗口内偏移」算屏幕坐标的（窗口 916×679，原点每次启动现取），界面文字以截图为准；截图时把应用窗口临时提到最前（TOPMOST）拍的，本机屏幕 2560×1440、DSH 窗口会盖住应用窗口。

---

## 27. 复现命令（PowerShell，v0.2.9）

```powershell
# 0. 工作目录
$t = 'C:\Users\Damon\AppData\Local\Temp\ccpbot-verify'; New-Item -ItemType Directory -Force $t | Out-Null

# 1. 下载并核对安装包
gh release download v0.2.9 --repo DamonZS/CCP-Bot --pattern "CCP-Bot_0.2.9_x64-setup.exe" --dir $t --clobber
(Get-Item "$t\CCP-Bot_0.2.9_x64-setup.exe").Length                    # 4783834
(Get-FileHash "$t\CCP-Bot_0.2.9_x64-setup.exe" -Algorithm SHA256).Hash # A1B57C73…24CE482D

# 2. 静默安装（不需要管理员）
(Start-Process "$t\CCP-Bot_0.2.9_x64-setup.exe" -ArgumentList '/S' -Wait -PassThru).ExitCode   # 0
Get-Item 'H:\CCP-Bot\ccpbot-desktop.exe' | Select-Object Length, @{n='Ver';e={$_.VersionInfo.ProductVersion}}  # 0.2.9

# 3. 双击启动，确认「它自己什么都不起」
Start-Process 'H:\CCP-Bot\ccpbot-desktop.exe'; Start-Sleep 8
netstat -ano | Select-String ':3010\s'      # 空
Test-Path 'C:\Users\Damon\CCP-Bot'          # False

# 4. 界面上走向导：欢迎页点「Run it on this computer instead」
#    Step1 Continue → Step2（Nothing to install on this computer）Continue
#    → Step3 选一个 provider 填 key → Step4（Intelligence 留空）点「Start CCP-Bot」
#    6 秒后会看到 B1：That did not finish / Could not remember the local choice.

# 5. 越过 B1
New-Item -ItemType Directory -Path 'C:\Users\Damon\CCP-Bot' -Force
#    再点一次 Start CCP-Bot；等到 local-bot.log 出现 B2 那句话（约 5 分钟）

# 6. 越过 B2
Add-Content 'C:\Users\Damon\CCP-Bot\.env' 'OPENAI_API_KEY=sk-verify-0.2.9-openai-placeholder'
#    再点一次 Start CCP-Bot；约 12 秒

# 7. 验收
(Invoke-WebRequest 'http://127.0.0.1:3010/health' -UseBasicParsing).Content           # {"status":"ok"}
Get-Content 'C:\Users\Damon\CCP-Bot\logs\local-bot.log'                              # agent-bot listening on http://127.0.0.1:<bot_port>/ag-ui
Get-Content 'C:\Users\Damon\CCP-Bot\logs\local-computer.log'                         # agent-computer listening on http://127.0.0.1:<computer_port>
Get-Content 'C:\Users\Damon\CCP-Bot\.env'
Get-ChildItem 'C:\Users\Damon\CCP-Bot\workspace'                                     # Bot 的默认工作文件夹
Get-ChildItem 'C:\Users\Damon\CCP-Bot\agent-bot\node_modules' | Select-Object -First 5
Test-Path 'C:\Users\Damon\CCP-Bot\node_modules\@ag-ui\encoder'                       # False（隔离布局）

# 8. 卸载与清理
Get-Process ccpbot-desktop, bun, postgres -EA SilentlyContinue | Stop-Process -Force
(Start-Process 'H:\CCP-Bot\uninstall.exe' -ArgumentList '/S' -Wait -PassThru).ExitCode  # 0
Remove-Item 'C:\Users\Damon\CCP-Bot' -Recurse -Force                                    # 程序目录外的运行目录要自己删
```

---

## 28. 给 v0.2.9 的三条修复建议（按优先级）

1. **B1**：`local_start` 里把 `local::remember` 换成「先 `create_dir_all(root)` 再写标记」，或者把 `remember` 挪到 `local::start` 之后 —— 一句话的位置问题，却让全新机器 100% 起不来。
2. **B2**：给 `LocalStartRequest` 加模型字段，或让本地路线也走 `start_stack_credential` + `ccpbot_env::compose` + `vault::split`；否则第 3 步收集的凭据永远到不了内建 Bot（`OPENAI_API_KEY` 是唯一入口）。
3. **B3**：本地路线也要写 `<root>\.logs\host-pids.json`（并在退出时清理），否则窗口永远打不开自己的应用、Stop 永远报 compose 所有权错误。

*Part 2 结束。所有界面文字、日志、命令输出均为本次验证的原样记录；引用源码的地方均标注了文件与行号。*

---

# Part 3 · v0.3.2（2026-10-31 23:36 – 2026-11-01 00:45）

验证对象：Windows 安装包 `CCP-Bot_0.3.2_x64-setup.exe`（GitHub Release `v0.3.2`）

这一轮验的是「全新机器、什么都不手工插手」：先把测试用的运行目录 `C:\Users\Damon\CCP-Bot` 整个删掉，再从向导点一次 Start。

---

## 29. 一句话结论

**装完之后，一个人只需要提供一样东西：模型 API key（或登录一个 AI 方案）。** 在 Intelligence 三项全空、没有登录任何 CopilotKit 的情况下，向导第 4 步的「启动 CCP-Bot」就是可点的深色按钮；点下去 **8 分 21 秒**后 `http://127.0.0.1:3010/health` 返回 200，窗口自己也把应用显示了出来。

与 Part 2（v0.2.9）对照，上一轮的两个 blocker 都在真机上证伪为「已修」：

| 上一轮的 blocker | 0.3.2 真机结果 |
| --- | --- |
| **B1**：空机器上第一次 Start 六秒即失败（`Could not remember the local choice.` / os error 3） | 运行目录被整个删掉后 Start 依旧成功；`.ccpbot-local` 的时间戳 = 点击那一秒，目录是应用自己建的 |
| **B2**：第 3 步填的模型 key 到不了内建 Bot | key 落进 `<root>\.env` 的 `OPENAI_API_KEY`；`logs\local-bot.log` 里不再有 `OPENAI_API_KEY is not set…` |
| （0.2.9 的第三条死因）`Cannot find module '@ag-ui/encoder'` | 消除：`<root>\agent-bot\node_modules` 41 项，根 `<root>\node_modules` 只有 9 项、且连 `@ag-ui` 目录都不存在 |

仍然存在的两条，如实记录（**不作为本轮失败判据**，另有任务在修）：

1. **Stop 的文案**：菜单 → Stop CCP-Bot 会弹「未能完成 / CCP-Bot could not finish stopping. Try Stop CCP-Bot again.」，**但进程真的全停了**（3010、bun、postgres、59043/59044/59045 全部归零）。文案失败 ≠ 没停。
2. **窗口重新加载后认不出自己正在跑的本机栈**：点完 Start 后窗口被导航到应用页，按 Alt+Left 回来是一次全新加载，显示的是 Welcome 而不是「正在运行」屏 —— 所以**第 4 步那个 running 屏上的 Stop 按钮实际到不了**，Stop 只能从菜单走。根因能在代码里对上，见 §38。

---

## 30. 安装包身份与安装结果

```
gh release view v0.3.2 --repo DamonZS/CCP-Bot --json tagName,publishedAt,isDraft,assets
```
发布 `2026-10-31T15:10:38Z`，`isDraft=false`，四个资产：

| 资产 | 字节 | Release 记录的 digest |
| --- | --- | --- |
| `CCP-Bot_0.3.2_x64-setup.exe` | **4,786,873** | `bc14797c282e56a61808fabacfcd27c2b773b71abc25667ec049453886043483` |
| `CCP-Bot_0.3.2_x64_en-US.msi` | 6,995,968 | — |
| `CCP-Bot_0.3.2_aarch64.dmg` | 9,638,594 | `316597e26022cb3b541846af4a808d0c14fadcb822ad7b2921112768c70cceaf` |
| `container-images.json` | 3,063 | `b791c747e0f7271824ebf5ed4fc9f66bd76dd41b7125c64bb7d95c3ae3559269` |

（注意：0.2.9 的 Release **没有** `container-images.json`，0.3.2 又有了。）

```
gh release download v0.3.2 --repo DamonZS/CCP-Bot --pattern "CCP-Bot_0.3.2_x64-setup.exe" --dir C:\Users\Damon\AppData\Local\Temp\ccpbot-verify --clobber
Get-Item C:\Users\Damon\AppData\Local\Temp\ccpbot-verify\CCP-Bot_0.3.2_x64-setup.exe | Select-Object Length,VersionInfo
Get-FileHash C:\Users\Damon\AppData\Local\Temp\ccpbot-verify\CCP-Bot_0.3.2_x64-setup.exe -Algorithm SHA256
```
```
bytes: 4786873   FileVersion: 0.3.2   ProductVersion: 0.3.2
SHA256 BC14797C282E56A61808FABACFCD27C2B773B71ABC25667EC049453886043483   ← 与 Release digest 一致
```

静默安装（当前用户，不提权；`elevated shell: False`）：

```
$p = Start-Process -FilePath .\CCP-Bot_0.3.2_x64-setup.exe -ArgumentList '/S' -Wait -PassThru
$p.ExitCode ; (Get-Date)
```
```
0        （耗时 0.7 秒，全程没有管理员提示）
```
安装位置 **`H:\CCP-Bot`**（安装器自己选的，机器上此前没有已安装记录）。

```
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CCP-Bot'
```
```
DisplayName     : CCP-Bot
DisplayVersion  : 0.3.2
InstallLocation : H:\CCP-Bot
UninstallString : H:\CCP-Bot\uninstall.exe
Publisher       : ccpbot
EstimatedSize   : 19128
```
`HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CCP-Bot` 与 WOW6432Node 下的同名项 **都不存在** → 按用户安装。快捷方式：`C:\Users\Damon\Desktop\CCP-Bot.lnk` = True，开始菜单 `…\Start Menu\Programs\CCP-Bot.lnk` = True，`C:\Users\Public\Desktop\CCP-Bot.lnk` = False。

```
Get-Item H:\CCP-Bot\ccpbot-desktop.exe | Select-Object Length,VersionInfo
Get-FileHash H:\CCP-Bot\ccpbot-desktop.exe -Algorithm SHA256
```
```
Length 19508224   FileVersion 0.3.2   ProductVersion 0.3.2
SHA256 74C7F3959EB45A68505709A353A25AD3E5AF5152291CFF5F06C7C15E419F4BBB
```
`H:\CCP-Bot\uninstall.exe` 79,319 B。

**装之前先卸了 0.2.9**（上一轮我留在机器上的那份）：

```
(Start-Process 'H:\CCP-Bot\uninstall.exe' -ArgumentList '/S' -Wait -PassThru).ExitCode
```
```
0      （0.3 秒；HKCU/HKLM 卸载项、桌面与开始菜单快捷方式、%LOCALAPPDATA%\CCP-Bot 全部 False）
```
唯一没被删掉的是 `H:\CCP-Bot` 目录本身 —— 因为里面有**别人跑出来的**一份部署布局（`.ccpbot-local` 6 B @23:21:34、`.ccpbot-deployment` 228 B @23:21:39、`container-images.json`、`ccpbot-engine\`、`postgres\`、`agent-bot`…`worker` 等目录，时间戳 23:21–23:22）。那不是我这次安装产生的（我上一轮装 0.2.9 后该目录只有 `ccpbot-desktop.exe` + `uninstall.exe`），**不是安装器的净载**，我没动它。

---

## 31. 时间线：一次 Start，8 分 21 秒

点 Start 之前的状态（干净机器）：

```
3010 listeners: 0    bun: 1    postgres: 0    root exists: False
```
`root exists: False` 是我自己删的 —— 上一轮首启残留把 tarball 解包进了这个目录，删掉它才能验「空机器上的第一次 Start」。

```
00:14:21.320  CLICK 启动 CCP-Bot
00:22:45      health=200   ← 距点击 +501 秒（8 分 21 秒）
00:22:53      READY health=200 at +511s body={"status":"ok"}
```

采样（后台采样器每 10 秒一行，节选；`logs=[…]` 是 `Get-ChildItem` 的即时读数，写者持有时长度显示为 0，内容以 §35 的 `Get-Content -Raw` 为准）：

```
[00:14:34] i=1  t=+10s  health=err l3010=0 bun=1 pg=0  env=-B    ports=[]                                  dirs=[ccpbot-engine]
[00:15:14] i=4  t=+50s  health=err l3010=0 bun=1 pg=0  env=-B    ports=[]                                  dirs=[ccpbot-engine]
[00:20:46] i=29 t=+381s health=err l3010=0 bun=1 pg=6  env=655B  ports=[bot=59044 computer=59045 postgres=59043]  dirs=[bot computer postgres\data ccpbot-engine]
[00:22:19] i=36 t=+475s health=err l3010=0 bun=1 pg=6  env=655B  ports=[bot=59044 computer=59045 postgres=59043]  dirs=[agent-computer\node_modules app\dist bot computer postgres\data ccpbot-engine]
[00:22:32] i=37 t=+488s health=err l3010=0 bun=0 pg=6  env=655B  ports=[…]                                  dirs=[agent-bot\node_modules agent-computer\node_modules app\dist .secrets bot computer postgres\data ccpbot-engine]
[00:22:45] i=38 t=+501s health=200 l3010=1 bun=4 pg=30 env=655B  ports=[bot=59044 computer=59045 postgres=59043]  dirs=[agent-bot\node_modules agent-computer\node_modules app\dist workspace .secrets bot computer postgres\data ccpbot-engine]
```

运行目录自己的时间戳（`Get-ChildItem <root> | Sort-Object LastWriteTime`）：

| 时间 | 目录/文件 | 对应阶段 |
| --- | --- | --- |
| 00:14:21 | `.ccpbot-local` 6 B | `remember()` 建目录并写标记 —— **B1 修复生效**（没人手工建过） |
| 00:14:25 | `examples/ patches/ scripts/` | release tarball 解包 |
| 00:14:28 | `container-images.json` 3063、`.ccpbot-deployment` 228 | 部署清单落盘 |
| 00:20:36 | `ccpbot-engine\` | 运行时（bun 1.4.3）+ 便携 PostgreSQL 17.6（约 330 MB）+ vector 扩展下载完 |
| 00:20:42 | `postgres/ bot/ computer/` | 数据库集群初始化、端口预分配 |
| 00:20:44 | `.env` 655 B、`server/ worker/ shared/ toolkit/ extension/` | 写 `.env` + 各子项目就位 |
| 00:21:04 | `node_modules/` | 根 `bun install` |
| 00:22:17 | `app/` | 界面构建（`app\dist\index.html`） |
| 00:22:18 | `agent-computer/` | 「手」的依赖安装 |
| 00:22:24 | `agent-bot/` | **内建 Bot 的依赖安装（新步骤）** |
| 00:22:40 | `.secrets/` | 六个 DPAPI 秘密落盘 |
| 00:22:41 | `workspace/ logs/` | Bot 的默认工作文件夹 + 五个 `local-*.log` |
| 00:22:45 | `health=200`（采样器） | 服务起来 |

（`bun.lock`、`package.json`、`tsconfig.base.json`、`docker-compose.yml`、`bunfig.toml` 的 mtime 是 tarball 里的 2026/10/31 23:06:15，不是解包时间。）

运行期间的第 4 步屏幕截图是 `prog32-11.png`（33,471 B，点击后 +143 秒），起来之后窗口的截图是 `v32-ready.png`（173,137 B）；两张都在 `C:\Users\Damon\AppData\Local\Temp\ccpbot-verify`，正文里在 §32 与 §37 说明它们的内容。

---

## 32. 向导逐屏原样文字（0.3.2 界面是中文）

**首屏（Welcome）**

```
你自己的 AI 同事，就在这台电脑上。
它们回答问题，使用你连接的各类工具，还能替你在浏览器里工作。
[设置 CCP-Bot]
需要几分钟。CCP-Bot 会先安装所需内容，然后请你登录你已有的 AI 方案。
[改为在本机运行]        ← 安静按钮
```

**第 1 步，共 4 步**

```
你的第一个 Bot
CCP-Bot 会帮你完成设置。如果你写代码，可以在下面选择 Agent 框架。
▸ 选择 Agent 框架
[返回] [继续]
```

**第 2 步，共 4 步** —— 这一屏是「本机路线」的判据：

```
本机无需安装任何内容
这一步不下载任何内容。首次启动时它会自行准备运行时、便携数据库、界面及其数据结构，然后从该文件夹提供服务。
CCP-Bot 的位置   C:\Users\Damon\CCP-Bot
[返回] [继续]
```
**没有**「使用 Docker 用于本地服务。」脚注，**没有**镜像下载/引擎准备行，前进按钮就是「继续」（不是「继续登录」）。

**第 3 步，共 4 步**

```
连接你的 AI
使用受支持的订阅方案或 API key 连接你的服务商。
OpenAI          Sign in with ChatGPT Plus, Pro, Team or Enterprise.
Anthropic       Sign in with a Claude Pro, Max, Team or Enterprise plan.
Google Gemini   Use a Google AI Studio key or sign in for Gemini API access.
xAI             Use an xAI API key or sign in to your xAI account.
[返回] [继续]
```
点 OpenAI 行展开：`使用我的方案登录` / `Use an API key` 两个 chip；切到 API key 后是 `使用已保存的 OpenAI API 密钥` + 字段 `OpenAI API 密钥`。填了一个**占位** key（`sk-verify-0.3.2-openai-placeholder`）后「继续」变深色 —— 向导**不做凭据校验**，非空即可过。

**第 4 步，共 4 步** —— 本轮最重要的一条：

```
第 4 步，共 4 步
Run CCP-Bot on this computer
Installation is complete. This stack runs on this computer, and the model you chose is enough to start it — a CopilotKit connection is optional here.
在本机为可选操作：连接 CopilotKit，把对话保存在那里。不连接也能启动 CCP-Bot。
[登录 CopilotKit] [使用已保存的连接]
▸ 指向你自己的 Intelligence 服务器
▸ 通过你的组织登录
▸ 安装选项
[返回] [启动 CCP-Bot]
```
**这时 Intelligence 三项（Project key / API URL / Gateway WebSocket URL）全空、没有登录任何账号，而「启动 CCP-Bot」已经是可点的深色按钮。** 这就是「装完只需配一个模型 key」的正面证据。

两条顺带记录：① 语言混排 —— 这一屏标题与首段是英文、其余是中文；第 3 步的行副标题、第 2 步的详情行也是英文。② 运行期间这一屏仍在，进度行就长在这屏里（见 §31 里的 `prog32-11.png`），「启动 CCP-Bot」按钮保持深色（与空闲时外观一致；我没有再点它）。

---

## 33. 干净机器首启是 Welcome；残留 profile 会从中断处继续

0.3.2 装完后的**第一次启动**，窗口直接停在第 2 步「Install CCP-Bot」，脚注还是「使用 Docker 用于本地服务。」，并且**在我没点任何东西的情况下**把 release tarball 解包进了 `C:\Users\Damon\CCP-Bot`（23:45:30–23:45:33，16 个目录/文件）。也就是说：容器路线那一屏被自动跑了一遍。

原因不是产品行为，而是 WebView2 配置目录里残留的前端状态被恢复。把那一份 profile 移开后重启，首屏回到 Welcome：

```
Get-Process ccpbot-desktop | Stop-Process -Force
Move-Item "$env:LOCALAPPDATA\app.ccpbot.desktop" "$env:LOCALAPPDATA\app.ccpbot.desktop.bak-235036"
Start-Process H:\CCP-Bot\ccpbot-desktop.exe
```
```
→ 首屏 = Welcome（你自己的 AI 同事，就在这台电脑上。）
   遥测文件 %LOCALAPPDATA%\app.ccpbot.desktop\telemetry\telemetry-state.json 的 last_step 从 "install" 变回 "welcome"
```
**结论**：全新机器首启是 Welcome；残留的 WebView2 profile 会让向导从中断的那一步继续（并且可能在你没点的情况下开始解包部署）。移开那份 profile 是恢复首启状态的可靠办法。`%APPDATA%\app.ccpbot.desktop` 在 0.3.2 全程为空（0.2.9 时代写过的 `last-launched-root.json` 0.3.2 不再写）。

---

## 34. 判据核对

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| `/health` 返回 200 | ✅ | `health: 200 application/json body={"status":"ok"}`（+501 秒） |
| 步骤链走到 `[ready]` | ✅（以界面进度行 + 目录时间戳为准） | 进度行 `database · 进行中 · 2m 5s 已用时`；`.env`→`node_modules`→`app`→`agent-computer`→`agent-bot`→`.secrets`→`workspace`→`logs` 依序出现；`local-server.log` 有 `CCP-Bot server listening on http://127.0.0.1:3010` |
| `[bot]` 步骤成功、`<root>\agent-bot\node_modules` 存在 | ✅ | `agent-bot\node_modules` = True，41 项；根 `node_modules` = 9 项且 `node_modules\@ag-ui\encoder` / `node_modules\@ag-ui` 均 **False** |
| `local-computer.log` 与 `workspace\` 有证据 | ✅ | `agent-computer listening on http://127.0.0.1:59045`；`<root>\workspace` 存在（本次为空） |
| **窗口自己**能显示应用 | ✅ | 起来后窗口直接变成应用页面（见 §37） |
| **除模型 key 外没人被要求配置** | ✅ | 第 4 步零 CopilotKit 字段即可点 Start；`/api/capabilities` 里 `authProviders: []`、`ssoRequired: false` |
| （第 4 条，另测）强杀应用后本机栈的命运 | ⏸ **本轮未复测**（转 0.4.0） | 0.2.9 已实测「强杀窗口后栈还活着」（Part 2）；修它的代码尚未落地，复测放在 **task-23** 修好后的 0.4.0 轮，判据与命令见 §39 |

---

## 35. `.env` 逐键表、`.secrets`、模型 key 到底落在哪

```
Get-Content C:\Users\Damon\CCP-Bot\.env -Raw
```

```
# Written by CCP-Bot Desktop. Anything else in this file is left alone.
ANTHROPIC_API_KEY=
BOT_PROVIDER=
CCPBOT_MODEL_OAUTH_FILE=
CHATGPT_AUTH_FILE=
CHATGPT_OAUTH_TOKEN=
CLAUDE_CODE_OAUTH_TOKEN=
OPENAI_API_KEY=sk-verify-0.3.2-openai-placeholder
OPENAI_BASE_URL=
OPENAI_CONTAINER_BASE_URL=

# Written by CCP-Bot local mode.
DATABASE_URL=postgres://ccpbot@127.0.0.1:59043/ccpbot
PORT=3010
SERVER_PORT=3010
APP_DIST_DIR=C:\Users\Damon\CCP-Bot\app\dist
CCPBOT_SINGLE_USER=true
SERVER_INTERNAL_URL=http://127.0.0.1:3010
NODE_ENV=
MANAGED_AGENT_AG_UI_URL=http://127.0.0.1:59044
AGENT_COMPUTER_URL=http://127.0.0.1:59045
AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true
```

| 键 | 谁写的 | 值从哪来 |
| --- | --- | --- |
| `OPENAI_API_KEY` | **应用写的**（`# Written by CCP-Bot Desktop.` 块） | **我第 3 步在向导里填的那个 key** —— B2 修复的落点 |
| `ANTHROPIC_API_KEY` / `BOT_PROVIDER` / `CCPBOT_MODEL_OAUTH_FILE` / `CHATGPT_AUTH_FILE` / `CHATGPT_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_BASE_URL` / `OPENAI_CONTAINER_BASE_URL` | 应用写的（同一块） | 空值占位：我这轮只选了 OpenAI API key，其余留空 |
| `DATABASE_URL` | 应用写的（local 块） | 便携 PostgreSQL 的随机空闲端口 59043 |
| `PORT` / `SERVER_PORT` | 应用写的 | 固定 3010 |
| `APP_DIST_DIR` | 应用写的 | `<root>\app\dist` |
| `CCPBOT_SINGLE_USER` | 应用写的 | `true` —— 身份提供方**不需要人配**（`server/src/auth/dev-actor.ts:66-83` 只在没有 provider 且没有这个开关时才拒绝启动） |
| `SERVER_INTERNAL_URL` | 应用写的 | `http://127.0.0.1:3010` |
| `NODE_ENV` | 应用写的 | 空 |
| `MANAGED_AGENT_AG_UI_URL` | 应用写的 | Bot 的地址 `http://127.0.0.1:59044` |
| `AGENT_COMPUTER_URL` | 应用写的 | 「手」的地址 `http://127.0.0.1:59045` |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | 应用写的 | `true` |
| `INTELLIGENCE_API_URL` / `INTELLIGENCE_GATEWAY_WS_URL` / `INTELLIGENCE_API_KEY` / `CPK_INTELLIGENCE_API_KEY` | **没有出现在文件里** | 本机模式把它们作为**进程环境变量**注入给 server（`local.rs` 的 `server_environment` 在 `.env` 里没有这两个 key 时补 `http://127.0.0.1:9/api`、`ws://127.0.0.1:9/gateway`、占位 key），所以 `server/src/config.ts` 那条「没有 Intelligence 就拒绝启动」在本机路线上不会触发，同时也不会污染 `.env`（向导会读 `.env` 回显，写了会误判成"已连接"） |

`<root>\.secrets`（六个 352 B 的 DPAPI 文件，**没有模型 key**）：

```
AGENT_TOOL_TOKEN.dpapi    COMPUTER_TOKEN.dpapi      KEY_ENCRYPTION_KEY.dpapi
MANAGED_AGENT_TOKEN.dpapi SUPERVISOR_TOKEN.dpapi    WORKER_SHARED_SECRET.dpapi
```

**结论（回答「装完还要配几样」）**：导向用户的答案只有一样 —— **模型 API key（或登录一个 AI 方案）**；本轮的模型 key 落在 `<root>\.env` 的 `OPENAI_API_KEY`（明文，出厂 0.3.2 就是这样；把它收进 vault 是后续任务）。Intelligence 三项由应用自己兜住，身份用 `CCPBOT_SINGLE_USER=true`，`KEY_ENCRYPTION_KEY` 等六个秘密应用自己生成。

---

## 36. Bot 的「手」：`computer` 与它的工作文件夹

```
Get-Content C:\Users\Damon\CCP-Bot\logs\local-computer.log -Raw
```
```

$ bun agent-computer/src/index.ts
{"type":"computer-sandbox","sandbox":"off","note":"Chromium runs without its own sandbox, which is the only thing that works under a default container seccomp profile. Set COMPUTER_SANDBOX=on where the host allows it."}
{"type":"computer-browser-mode","mode":"headless","display":null}
agent-computer listening on http://127.0.0.1:59045
```
默认工作文件夹 = **`C:\Users\Damon\CCP-Bot\workspace`**（`local.rs` 的 `WORKSPACE_FOLDER = "workspace"`，没选过文件夹时用它）。本次该目录**存在但为空**，`<root>\workspace.txt` = False（说明没人通过「Choose the folder a Bot works in」改过）。改过的文件夹会记在 `workspace.txt` 里。

---

## 37. 界面可用性：窗口自己就能显示应用

起来之后**窗口本身**变成了应用页面（不需要浏览器）：

```
每个 Bot 都有自己的浏览器和文件
[继续]
```
对照：同一时刻用无头 Edge 打开 `http://127.0.0.1:3010/`（全新 profile，所以停在应用自己的第 1 步）：

```
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --headless=new --disable-gpu --no-first-run `
  --user-data-dir="$env:TEMP\edge-profile32" --window-size=1400,900 --virtual-time-budget=15000 `
  --screenshot="$env:TEMP\ui-3010-032.png" 'http://127.0.0.1:3010/'
```
```
欢迎来到 CCP-Bot
[ Hand off tasks to your team of Bots          ↑ ]
[继续]
```
两者是同一套应用界面（同一个 `继续`、同一套 orb/输入框语言）。0.2.9 那句 `CCP-Bot could not verify its app on port 3010 belongs to this installation. Try starting CCP-Bot again.` **这一轮没有出现在屏幕上** —— 代码里它还在（`main-v0.3.2.rs:3019`），但本机路线现在先走 `local_app_url()` 回退（`main-v0.3.2.rs:3219-3225`：有 `.ccpbot-local` 标记且 `127.0.0.1:3010/health` = 200 就显示本机应用），所以窗口显示成功。菜单里的 `Open CCP-Bot` 走的是同一个 `show_ccpbot`。

---

## 38. Stop 的实际表现（文案、进程真相、以及那个到不了的按钮）

**我怎么触发 Stop 的**：菜单栏 `CCP-Bot` → 三项

```
Open CCP-Bot
Stop CCP-Bot
Quit            Ctrl+Q
```

点 `Stop CCP-Bot` 之后，窗口弹卡（原样）：

```
未能完成
CCP-Bot could not finish stopping. Try Stop CCP-Bot again.
▸ 技术详情
获取设置帮助
```
**但进程真的全停了**（点完 2.5 秒后实测）：

```
health3010: err
3010: 0   bun: 0   postgres: 0   bot59044: 0   computer59045: 0   pg59043: 0
```
→ **文案失败 ≠ 没停**。文案本身来自 `main-v0.3.2.rs:4437`（`stop_from_menu` → `stop_everything` 返回 Err 时构造的 `Problem`）。

**为什么我只能从菜单点**：点完 Start，`show_ccpbot` 把窗口导航到应用页；按 `Alt+Left` 回来时窗口是**一次全新加载**（`running=false`、`step=welcome`），屏幕上只有 Welcome，而 Stop 按钮只长在「第 4 步 + running=true」那一屏上（`App-v0.3.2.tsx:1603-1631`：`{running ? (Show CCP-Bot)(Stop CCP-Bot) : (启动 CCP-Bot)}`）。全新加载后 shell 会去问 `already_running`，而它对本机路线**必然为 false**：

```
main-v0.3.2.rs:3206  fn already_running_now(app, root) -> bool {
                       !recovery_required_or_pending_quit_notice(&shell, &root)
                         && ccpbot_env::Ports::read(&root).is_ok_and(|ports| already_running_at(&root, &ports))
                     }
main-v0.3.2.rs:3214  fn already_running_at(root, ports) -> bool { owned_app_url(root, ports).is_some() }
main-v0.3.2.rs:3227  fn owned_app_url(root, ports) -> Option<String> {
                         if !already_running_on(root, ports.server, stack::recorded_server_owns_port)
                            || !stack::recorded_process_owns_port(root, "app", ports.app).unwrap_or(false)
                         { return None } …
                     }
```
`recorded_process_owns_port` 读的是 `<root>\.logs\host-pids.json`（`stack.rs:1342-1344`），而本机路线**从不写这个文件**：本次运行后 `<root>\.logs` = **False**（只有 `<root>\logs` 里五个 `local-*.log`）。所以 `already_running` 返回 false，shell 认不出自己正在跑的本机栈 → 显示 Welcome。**这就是「本机路线没有所有权记录」这一条，真机与代码对得上。**

（另注：`already_running` 的本地兜底只加在 `show_ccpbot` 那条链上（`main.rs:3016-3017` 的 `.or_else(|| local_app_url(&root))`），**没有**加在 `already_running_at` 里 —— 这解释了为什么"能显示应用"和"认不出在运行"会同时成立。0.3.2 自带的两个测试名也点明了这个设计意图：`already_running_returns_false_when_ownership_is_unproven`（`main-v0.3.2.rs:9755`）。）

Stop 之后的收尾状态：窗口回到 Welcome，安静按钮在「**正在本机运行**」与「**改为在本机运行**」之间来回跳 —— 它跟的是 `<root>\.ccpbot-local` 在不在，不是栈在不在（所以栈已经停了它也可能显示"正在本机运行"）。`<root>` 里的 `.ccpbot-local`、`.ccpbot-deployment`、`bot\port`、`computer\port`、`postgres\port` 都还在（Stop 不动这些记账文件）。

---

## 39. 第 4 条：强杀应用后本机栈的命运 —— **本轮未复测**（转 0.4.0）

**一句话：这一条这次没有跑，不作为 0.3.2 的判据。**

**为什么没跑**（lead 裁定，2026-11-01）：按本轮流程，验收跑完之后我已经把 0.3.2 卸载、并删掉了运行目录 `C:\Users\Damon\CCP-Bot`，所以复测它得**重装 + 冷启动约 8 分钟**（运行时与便携 PostgreSQL 要重新下载）。这 8 分钟会用来**复测一个已知缺陷**，而不是验证修复 —— 修它的代码还没落地。留到修好之后验「修好之后还会不会留进程」，那才是有价值的证据。

**已知缺陷的原始观测（Part 2 · v0.2.9，2026-10-31 22:00–22:25 那一轮实测）**：

- 强杀窗口不带走栈：`Get-Process ccpbot-desktop | Stop-Process -Force` 之后 4 秒 → `bun=4`、`postgres=30`、**3010 仍在监听**；要手工 `Get-Process bun,postgres | Stop-Process -Force` 才归零。
- 也就是说：**窗口退出（含强杀）不会停掉本机栈**。（对照：窗口里的 Stop 按钮 / 菜单 Stop 是「文案失败、进程真停」，见 §38。）

**谁、什么时候、按什么判据补**：

- **归属**：**task-23**（修「窗口没了、本机栈不停」），排在 task-12 之后。
- **复测时机**：**0.4.0 的候选安装包**出来时，由安装包验证这一轮按同一套流程在真机上复测（不由写修复的人自证）。
- **判据（三条，缺一不可）**：
  1. 起栈 → `Get-Process ccpbot-desktop | Stop-Process -Force` → `Start-Sleep -Seconds 5` → **`3010 监听 = 0`、`bun = 0`、`postgres = 0`**（窗口没了，栈自己停）；
  2. 同一轮里再走一次正常退出（`Quit` / `Ctrl+Q`），同样三条读数归零；
  3. 无论修没修好，**Stop 的文案与进程真相都要照 §38 那样如实记录**（0.3.2 的现状是「文案报未能完成、进程真的全停」）。
- **复测用的命令**（本次没跑的那三步，原样留给 0.4.0 那一轮）：

```powershell
# 1) 起栈（0.4.0 上同样是「向导第 4 步 → 启动 CCP-Bot」；冷启动要等运行时 + 便携 PostgreSQL 下完）
# 2) 不点 Stop，直接强杀窗口，然后立刻看进程
Get-Process ccpbot-desktop | Stop-Process -Force
Start-Sleep -Seconds 5
"3010: $((Get-NetTCPConnection -LocalPort 3010 -State Listen -EA SilentlyContinue|Measure-Object).Count)  bun: $((Get-Process bun -EA SilentlyContinue|Measure-Object).Count)  postgres: $((Get-Process postgres -EA SilentlyContinue|Measure-Object).Count)"
# 3) 再起一次，改用正常退出（菜单 Quit / Ctrl+Q），重复第 2 步的三项读数
```

---

## 40. 卸载与机器还原

卸载命令（与 Part 2 相同，按用户、静默）：

```
Get-Process ccpbot-desktop, bun, postgres -EA SilentlyContinue | Stop-Process -Force   # 先让栈停下
(Start-Process 'H:\CCP-Bot\uninstall.exe' -ArgumentList '/S' -Wait -PassThru).ExitCode
Remove-Item 'C:\Users\Damon\CCP-Bot' -Recurse -Force
```

本轮（0.2.9）实测过的行为可以直接引用：`uninstall.exe /S` → **ExitCode 0**，卸载项、桌面与开始菜单快捷方式、`%LOCALAPPDATA%\CCP-Bot` 全部清掉，**`H:\CCP-Bot` 只有在目录为空时才会被删掉**，而**运行目录 `<root>`（`C:\Users\Damon\CCP-Bot`）卸载器完全不碰**，要自己删。

**0.3.2 这一轮的实测结果**（先只停我自己的进程，开发检出那份栈没动）：

```
Get-Process ccpbot-desktop | Stop-Process -Force
Get-Process postgres | Where-Object { $_.Path -like 'C:\Users\Damon\CCP-Bot*' } | Stop-Process -Force
Get-Process bun | Stop-Process -Force
(Start-Process 'H:\CCP-Bot\uninstall.exe' -ArgumentList '/S' -Wait -PassThru).ExitCode
Remove-Item 'C:\Users\Damon\CCP-Bot' -Recurse -Force
```
```
uninstall ExitCode: 0
install dir H:\CCP-Bot:                     True       ← 目录没被删（下面解释）
HKCU uninstall key:                         False
HKLM uninstall key:                         False
desktop lnk / start menu lnk / public:      False / False / False
%LOCALAPPDATA%\CCP-Bot:                     False
HKCU …\Chrome\NativeMessagingHosts\app.ccpbot.recorder: False
root exists after delete:                   False
ccpbot-desktop / bun / 我这轮的 postgres:    0 / 0 / 0
3010 listeners:                             0
%APPDATA%\app.ccpbot.desktop:               0 个文件
```
`H:\CCP-Bot` 仍存在，里面有 **21 个条目**（`agent-bot`、`agent-computer`、`app`、`ccpbot-engine`、`examples`、`extension`、`patches`、`postgres`…）—— 那是 §30 里说的**别人跑出来的那份部署布局**，不是安装器装的，也不是我这次安装留下的；卸载器只在目录为空时才删目录，所以它留着。我没有删它（不是我的东西）。

**给用户的还原结论**：卸载器清得干净（注册表、快捷方式、`%LOCALAPPDATA%\CCP-Bot`、Recorder 的浏览器宿主键全没了），**但不会删掉运行目录 `<root>`、也不会删掉别人塞进安装目录的东西** —— 想彻底回滚，得自己删 `C:\Users\Damon\CCP-Bot`（以及确认 `H:\CCP-Bot` 里没有别的遗留物）。

---

*Part 3 结束。所有界面文字、日志、命令输出均为本次验证的原样记录；引用源码的地方均标注了文件与行号。*

---

*报告结束。所有界面文字、日志、命令输出均为本次验证的原样记录；引用源码的地方均标注了文件与行号。*