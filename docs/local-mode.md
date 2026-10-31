# 本地模式：装完就能用的 CCP-Bot（不需要 Docker，也不需要 WSL 或虚拟机）

## 背景

CCP-Bot 桌面端一路走来都是「容器里的栈」：它自己挑一个容器引擎（Docker Desktop 或 Podman），把 compose 起起来，再把界面挂上去。这条路线有几个代价，而且都落在**第一次打开的人**身上：

- Windows 上 Podman 那一半要走 WSL，于是要么管理员权限，要么一台已经配好的机器；我们的桌面端此前甚至会直接拦一屏「This account cannot install Windows components」。
- Docker Desktop 那一半要先装 Docker、打开一次（第一屏是它的条款页），再等引擎预热。
- 两条路都要拉一堆镜像（GB 级），第一次「打开」到能用是十几分钟的量级。

而主人要的是 Claude / Codex / Cursor 那种体验：**装完双击就能用**。所以本地模式要做的事很直接——把这套栈作为**本机普通进程**跑起来，不碰容器、不碰虚拟机、不要管理员。

## 目标

- 引擎选择里增加「本地（本机进程）」并作为默认；选了它，Windows 的 WSL/管理员关卡**不出现**。
- 首次运行一次性准备好：便携版 PostgreSQL（下载一次、解包一次）、数据簇初始化一次、建库、写 `.env`、装依赖、构建界面、跑迁移、起 server 与 worker，等到 `/health` 通过，然后把界面挂上去。
- 之后每次启动复用数据簇与已装依赖，只做「起数据库 → 起进程 → 等健康」。
- 停止是干净的：端口不再监听，进程树里不留孤儿的 `postgres`。
- 每一步都有可读的进行中/失败说明；离线、端口被占、initdb 失败各有自己的句子，并且都指向下一步动作。
- 只绑回环地址：页面 `127.0.0.1:3010`，PostgreSQL 绑 `127.0.0.1` 上的空闲端口。

## 非目标

- 不改动容器路线：Docker / Podman 仍然可选，行为不变。
- 不在这一轮把**智能体进程**（agent-computer 的浏览器、agent-bot、agent-langgraph、supervisor、SPIRE）本机化——它们仍由容器路线提供；本地模式这一轮的交付是「数据库 + API + worker + 界面」这条主干可用，也就是「页面上能用起来」。
- 不做安装包签名。
- 不把 PostgreSQL 二进制塞进安装包（安装包体积会翻几倍）：首次运行下载一次，之后复用。

## 用户视角

1. 装好 CCP-Bot，双击。
2. 窗口里不再问 WSL 或 Docker，而是显示正在准备：本机运行时 → 本地数据库（首次会下载一次） → 依赖 → 界面 → 数据库结构 → 启动。
3. 十几秒到一两分钟后，窗口里就是 CCP-Bot 的界面，地址 `http://127.0.0.1:3010`。
4. 关掉再打开：跳过下载与初始化，只起进程。

## 功能要求

- **引擎选择**：`local` 为默认；已保存过别的引擎的老机器不自动改（避免把正在用 Docker 的人的栈换掉）。
- **一次性准备**（首次运行）：
  - 便携 PostgreSQL：EDB 的 Windows 二进制 zip（约 315 MB），解包到 `<root>/postgres/pgsql`，**按 SHA-256 钉住**再解包——版本号是期望，digest 才是实际跑过的东西。
  - **pgvector**：迁移文件的第一句就是 `CREATE EXTENSION IF NOT EXISTS vector;`，而 EDB 的便携版**不带**这个扩展（容器路线是从 `pgvector/pgvector` 镜像里拿到的）。所以还要下载一次很小的扩展包（约 170 KB，同样按 SHA-256 钉住），把 `vector.dll` 放进 `pgsql/lib`、`vector.control` 与升级脚本放进 `pgsql/share/extension`；`vector.control` 在不在是「装没装」的判据。**少了它，第一次迁移就停在 `extension "vector" is not available`，后面全新的步骤一个都不会跑**——这是真机跑出来的，不是推测。
  - 数据簇：`initdb -U ccpbot -A trust -E UTF8`，落在 `<root>/postgres/data`；只监听回环，所以用 trust（不走网络就无所谓密码，也就没有第二份要保管的凭据）。
  - 建库：`createdb ccpbot`；库已存在算成功。
  - `.env`：**合并**写法——只覆盖我们要管的键（`DATABASE_URL` / `PORT` / `SERVER_PORT` / `APP_DIST_DIR` / `SINGLE_USER` / `NODE_ENV`），保留文件里其它键与注释。
  - 依赖与界面：`bun install`；`bun run --filter app build` 产出 `app/dist`（界面由 server 的 `serveStatic` + SPA 兜底提供，见 `server/src/app.ts:2016-2035`）。
  - 迁移：`bun run db:migrate`（在 `server/` 下跑，读 `../.env`）。
  - 进程：server 与 worker 各一个子进程，输出追加到 `<root>/logs/local-*.log`；Windows 上打 `CREATE_NO_WINDOW`，不弹控制台。
  - 健康：轮询 `GET http://127.0.0.1:3010/health` 直到 200。
- **复用**（第二次起）：数据簇已初始化就不再 `initdb`；`app/dist/index.html` 已在、依赖已在就不再装（有明确的「缺失才做」判据）。
- **停止**：先停 server/worker（进程树），再 `pg_ctl -m fast stop`；数据目录原地保留。
- **端口**：数据库端口选一次后写在 `<root>/postgres/port`，之后沿用（否则每次启动都会让 `.env` 里的连接串变化）；占用时换一个空闲端口。
- **错误**：下载失败（离线/被掐断）→ 说明可以重试、或改用容器路线；`initdb` 失败 → 把 `initdb` 的原始输出带出来；端口占用 → 换端口并说明。

## 技术约束

- 只用既有依赖与外部程序：`bun`（既有的 `install::ensure_bun`）、`powershell`（解包 zip，与仓库既有的做法一致）、PostgreSQL 自带的 `initdb`/`pg_ctl`/`createdb`。**不新增 crate**。
- 所有命令都用绝对路径 + `CREATE_NO_WINDOW`，不经 shell 拼接。
- 日志只落在 `<root>/logs/`，不写系统目录。
- 不碰容器路线的文件与状态。

## 交付范围

- `desktop/src-tauri/src/local.rs`（新）：布局、取得 PostgreSQL、初始化、起停、健康等待、编排，以及单测。
- `desktop/src-tauri/src/lib.rs`：注册模块。
- `desktop/src-tauri/src/main.rs`：`local_start` / `local_stop` / `local_status` 三个命令；本地模式存档时 `windows_blocker` 返回空；启动路径按存档引擎分派。
- `desktop/src-tauri/src/install.rs`：把 `fetch_verified` / `digest_of` 放宽到 crate 内可见，供本地模式下载用。
- `desktop/src/`：向导里的引擎选择与文案（本地为默认）。
- 验证与证据：本机（Windows、标准账号、**Docker daemon 停着**）从冷启动到 `/health` 200 与页面可用的实测；`cargo test` 全量。
- `desktop/src-tauri/src/local.rs` 里的扩展部分：`vector()` / `vector_installed()` / `ensure_vector()` / `place_vector()` / `copy_files()`，以及「已装就不再下载」「只放库与 control、不放头文件」两条单测。
  - `desktop/src-tauri/src/local.rs` 里的扩展部分：`vector()` / `vector_installed()` / `ensure_vector()` / `place_vector()` / `copy_files()`，以及「已装就不再下载」「只放库与 control、不放头文件」两条单测。
- 密钥与 Intelligence：`deployment_secrets()`（复用 `vault` + `env::minted`，与容器路线同一条判据）、`write_intelligence()`、`SERVER_INTERNAL_URL` 写进 `.env`；单测「同一目录两次调用铸出同一套密钥」「`.env` 只覆盖自己的键、注释与别人的键原样保留」。
- 无引擎的机器默认走本地：`LocalStatus.supported`（只有 Windows 为真），窗口在 `detect_engine` 与 `local_status` 都回来之后、且确认没有任何引擎时才默认选中本地（「改用 Docker」仍然可以赢回来）。
- `desktop/src/LocalRun.tsx` + `desktop/src/LocalRun.test.tsx`（新）：本地模式那三行事实、当前步骤、启动/停止按钮；四条界面测试。

## 实测证据（2026-10-30，本机 Windows 10.0.26100、标准账号 `damon\damon`、Docker daemon 停着、无 WSL 发行版可用）

- 端到端 live 用例：`cargo test -p ccpbot-desktop --manifest-path desktop/src-tauri/Cargo.toml --lib -- local::tests::live_start --include-ignored --nocapture`
  → `test result: ok. 1 passed; 0 failed; … finished in 12.54s`，步骤依次为
  `[runtime] Preparing the local runtime…` → `[database] Preparing the local database (downloaded once, then reused)…` → `[database] Preparing the database extension (downloaded once, then reused)…` → `[database] Starting the database…` → `[schema] Updating the database schema…` → `[server] Starting the services…` → `[ready] CCP-Bot is running on this computer (/health 200).`
  同一次运行打印 `local stack up on http://127.0.0.1:3010 with database port 63133`，用例自身断言 `/health` 为 200、`/` 返回的就是界面、步骤里出现过 `ready`。
- `logs/local-server.log` 里的服务器侧证据：迁移跑过之后 `CCP-Bot server listening on http://127.0.0.1:3010`，以及 `No identity provider is configured, so every request is treated as dev@ccpbot.local (administrator).`（即 `CCPBOT_SINGLE_USER=true` 生效）；`logs/local-worker.log` 里是例程巡检在跑（`{"type":"routine-sweep","offered":[],"considered":0,"fired":[],"skipped":[]}`）。
- `logs/local-postgres.log`：`LOG: starting PostgreSQL 17.6 on x86_64-windows` 与 `LOG: listening on IPv4 address "127.0.0.1", port 63133`，停止时走 `pg_ctl -m fast -w stop`，无残留进程。
- 单元与集成：`-- local::` → 22 passed / 0 failed / 1 ignored（含上述 live 为 ignored）；桌面端 `bun run --cwd desktop typecheck` 无输出；`bun test desktop/src/LocalRun.test.tsx` → 4 pass / 0 fail。

## 真机跑出来的四个坑（都已修，写在代码注释里）

1. **`pg_ctl start` 的管道会被 postmaster 继承** → 用 `.output()` 等它会在数据库已经起来之后仍然挂住（现场：测试进程 CPU 停住、日志显示 `database system is ready to accept connections`）。改成 `Stdio::null()` + `.status()`，失败原因改读 `<root>/logs/local-postgres.log` 的尾部。
2. **EDB 便携版不带 pgvector** → 第一次迁移停在 `extension "vector" is not available`（`Could not open extension control file … vector.control`）。接入 `andreiramani/pgvector_pgsql_windows` 的 `vector.v0.8.6-pg17.zip`（169,689 字节，SHA-256 钉住），只把 `lib/` 与 `share/extension/` 拷进去。
3. **服务需要密钥与 Intelligence 才能启动** → 分别是 `KEY_ENCRYPTION_KEY must be configured`（`server/src/config.ts:507`）与 `CopilotKit Intelligence is required and is not configured. Missing: INTELLIGENCE_API_URL, INTELLIGENCE_GATEWAY_WS_URL`（`config.ts:1018`）；密钥走 vault + `env::minted`（与容器路线同一条判据，重启复用不轮换），Intelligence 由向导写入 `.env`。
4. **server 必须从 `server/` 目录运行** → 从仓库根启动时租户包默认路径 `../examples/fintech` 解析到仓库外，直接 `ENOENT` 打不开 `brand.yaml`；现在两个服务都以 `server/` 为工作目录，server 读 `--env-file=../.env`、worker 以 `../worker/src/index.ts` 启动（与 compose 一致），worker 只拿它自己的三个变量。