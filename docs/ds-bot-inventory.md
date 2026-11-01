# DS-Bot → CCP-Bot: portability inventory

Read-only survey of `D:\DS-Bot-main` (DS-Bot, Apache-2.0) against `D:\Project\CCP-Bot` (CCP-Bot, MIT).
Every claim below carries `path:line`. Claims I could not verify are marked **未验证** with the command that would settle them.
This is a survey, not a promise: the DSH-runtime-bound items in §4 and §7 are multi-week ports.

## 1. 摘要（中文）

DS-Bot 是 **Electron 外壳 + 固定版本 DeepSeek Harness (DSH 0.2.1-rc.2) + `ds-bot` 插件** 三层结构：外壳只管窗口、托盘、自更新与数据目录（`app/src/main.mjs:710` 加载的其实是 DSH 自己的 Web 前端），产品能力全在插件里——host 半约 1.64 万行（`ds-bot/src/host/**`，46 个模块），client 半约 1.79 万行（`ds-bot/src/client/**`）。

**最重要的可移植性事实**：二者之间的契约是 **一个 POST 端点加一条 SSE 流**，不含任何 DSH 专有传输。`POST /api/bot`，请求体 `{endpoint, payload}`，响应 `{ok:true, value}` 或 `{ok:false, error:{code,message,details}}`（`ds-bot/src/host/channel.js:33-34`、`:556-566`）；实时侧是 `GET /api/bot/feed` 的 SSE，只有 `revision` / `live` / `message` / `stream` 四种事件（`ds-bot/src/host/feed.js:9`、`:51-77`）。客户端甚至不用 EventSource，只用 `fetch` 读 `body.getReader()`（`app/ui/src/api.js:18-55`），唯一依赖是「浏览器 + 同源 cookie」。

DS-Bot 自己已证明这条 seam 可脱离 DSH：`app/ui/` 是一个直接 import 插件 client 模块、只用 `api/bot` 与 `api/bot/feed` 通信的 React 窗口（`app/ui/src/main.js:3-16`、`app/ui/src/api.js:1-2`）。该窗口目前 **on hold、未构建未打包**（`app/README.md:146,148`），但它是可复用的直接证据。

**建议第一阶段**：在 CCP-Bot 的 Hono 服务器上实现 `/api/bot` + `/api/bot/feed` 的最小可运行子集（`state`、`set-prefs`、`chat`、`send`、`create-bot`/`update-bot`），数据先落一个 JSON 文件并映射到已有的 agents；再用 DS-Bot 的 `client.js` 在一个开发路由里跑起来验证契约。一到两周即可证明「契约可承载」，且不触碰 DSH 运行时。

**三处风险**：① DS-Bot 引用的 `NOTICE` 在本 checkout 中**不存在**，且源码**没有任何 SPDX/版权头**（§6），照抄前须自行补归属；② CCP-Bot 根目录**也没有 LICENSE 文件**（尽管 `package.json:4` 写着 MIT、README 声称保留），混入 Apache-2.0 代码前必须先补；③ 产品前端在 `app/`（463 个 tsx），**不在** `desktop/src/`（那只是 16 个 tsx 的 Tauri 引导壳）。

## 2. How DS-Bot is put together

Three layers, three code locations, one process tree.

| Layer | Code | Runs where | Owns |
|---|---|---|---|
| Electron shell | `app/src/*.mjs` (24 modules, 3,874 lines), `app/src/preload.cjs`, `app/ui/` (dormant) | Electron main + renderer | Window, tray, single-instance, data-location move, import from the user's DSH, self-update, Bot browser webviews, cookie import, frameless Windows chrome |
| DSH profile + Host | `app/src/profile.mjs`, `app/src/host.mjs`, `app/engine/` (dormant) | A child process in Electron's Node mode (`app/src/host-process.mjs`) | Boots profile `ds-bot`, mounts `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `ds-bot`, serves the Web UI on a loopback port |
| `ds-bot` plugin | `ds-bot/index.js` + `ds-bot/src/host/**` (host half), `ds-bot/src/client/**` → `ds-bot/client.js` (client half), `ds-bot/src/shared/**` | Host half inside the DSH process; client half in the DSH Web UI | The Bot team: roster, group chats, bot-to-bot messages, memory, secrets, capabilities, schedules, browser, usage, approvals |

**The shell never renders the team.** `app/src/main.mjs:692-710` loads `http://127.0.0.1:<port>/` — first with a one-use launch URL that trades its token for the Host cookie (`app/engine/index.js:8-18`), then the plain origin. `app/src/main.mjs:604-605` sets only `preload.cjs`; there is no `loadFile` of `app/ui/dist` anywhere in `main.mjs`. `app/README.md:3` says it plainly: *"Its window shows DSH's Web front end with the plugin, as DSH Desktop does."*

**The profile is the mounting contract.** `app/src/profile.mjs:7` — `BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot']`; `claimBundles` (`app/src/profile.mjs:23-28`) force-places these three at the head of `profiles/ds-bot`'s bundle list and drops the retired `deepseek-bot-engine`. `INSTALL_ANCHOR` is the app's own `package.json` (`app/src/profile.mjs:16`) because DSH imports plugins only from the installation's dependency graph. `app/README.md:42,44` names what each bundle contributes.

**Plugin-provided vs DSH-provided.** `ds-bot/index.js:44` declares what the host half takes from DSH:

```
export const inject = ['llm','tools','systemPrompt','sessionController','sessions',
                       'sessionTitle','workspaceRegistry','connection']
```

Its client half declares its own set: `ds-bot/src/client/index.js:47` — `['sessions','uiWorkspace','uiConversation','slots','theme','layout']`.

| Capability | Provided by |
|---|---|
| Model catalog, provider keys, `llm` service | DSH (`app/README.md:42`; keys in `.credentials.yaml`, providers in the profile's `cordis.patch.yml` — `app/README.md:34`) |
| Sessions (one Bot = one root Session), session storage/format/query/titles | DSH (`ds-bot/index.js:2-3`; `app/package.json` deps `@deepseek-ai/dsh-session-*`) |
| Tools registry, prompt sections, compaction, sandbox, jobs, skills, goals, subagents, token meter | DSH (`app/engine/cordis.patch.yml:66-68` keeps their registries on the host plane) |
| Settings UI, plugin management, sign-in | DSH (`app/README.md:42`; `ds-bot/src/client/sidebar.js:436 openHarnessSettings()`) |
| The team itself: roster, Main Bots, group chats, relays, bot-to-bot messages, handoffs, side chats, memory files, secrets, capabilities, schedules, browser sessions, usage ledger, approvals, feedback, about | `ds-bot` |

**Host-plane vs per-Session tooling.** `app/engine/cordis.patch.yml:70-142` disables the base rows that compose one agent's tools/prompt on the host plane (`tool-bash`, `tool-fs`, `tool-jobs`, `tool-skill`, `tool-todo`, `tool-web`, `tool-subagent*`, `workflow-ptc`, `tool-workflow`, `plan-mode`, `compaction-basic`, `tool-result-pruner`, `agent-instructions`, `command-goal`, `tool-goal`, `command-compact`, `tool-ralph`, `tool-plugin-manager`) and mounts `@deepseek-ai/dsh-agent-preset-registry` with `default: standard` (`:144-148`). Every Session mounts a preset instead. This file is **dormant** (`app/README.md:146` — "On hold, not installed"), but it documents which DSH rows the shipped profile inherits from `dsh-web-app`'s own bundle patch, and it carries the MIT/NOTICE attribution comment at `:7`.

## 3. The seam

This is the section to reimplement. Everything here is plain HTTP + JSON + SSE; nothing is DSH-specific.

### 3.1 Transport

| Route | Method | Body / headers | Response |
|---|---|---|---|
| `/api/bot` | POST | `{ endpoint: string, payload: object\|null }`, `content-type: application/json`, session cookie | `200` + `{ ok:true, value }` or `{ ok:false, error:{ code, message, details } }` — always `200`, errors are in the body |
| `/api/bot/feed` | GET | session cookie, `cache: 'no-store'` | `200` + `text/event-stream; charset=utf-8`, `cache-control: no-store` |

Registration, host side: `ds-bot/src/host/channel.js:556-566` for the POST (via `ctx.connection.fetch.register`, path `ROUTE` = `/api/bot`, `methods:['POST']`, `requestBody:'buffered'`, comment `:555` *"An exact Fetch route on the shared /api channel; the browser authenticates with its session cookie."*), and `ds-bot/src/host/feed.js:85-102` for the GET on `` `${ROUTE}/feed` ``.
Client side: `ds-bot/src/client/api.js:4` — `const ROUTE = 'api/bot'`, **relative on purpose**: *"Document-relative so the Web UI keeps working under a mounted base path."*

### 3.2 Envelope, error codes and the polling core

- Success/failure constructors: `ds-bot/src/host/channel.js:33-34`.
- Code classification: `ds-bot/src/host/channel.js:19-22` — an `error.code` starting `bot/` passes through; otherwise `instanceof TypeError|ReferenceError|RangeError|SyntaxError` or `/^E[A-Z_]+$/` becomes `bot/internal`, everything else `bot/refused`.
- Codes in use: `bot/error`, `bot/internal`, `bot/refused`, `bot/invalid`, `bot/read-only`, `bot/not-found`, `bot/browser-off`, `bot/stale`, `bot/unavailable`, `bot/forbidden`.
- The client shows `bot/refused`, `bot/invalid`, `bot/read-only`, `bot/not-found`, `bot/browser-off` as plain user-facing messages and does **not** report them to diagnostics (`ds-bot/src/client/api.js:6`); `bot/internal` gets `' Settings → Feedback has the details.'` appended (`ds-bot/src/client/api.js:8-42`).
- **Read-only mode**: a second DSH host holding `<home>/state.lock` makes the first answer only the endpoints in `READS` (`ds-bot/src/host/channel.js:98`); everything else returns `fail(readOnly, 'bot/read-only')` at `:139`. The message names the holder's pid and host (`ds-bot/src/host/store.js:59-64`).
- **The short-circuit that makes polling cheap**: `ds-bot/src/host/channel.js:146-152` (the `case 'state'` arm) — when `body.since === state.revision && (body.models === undefined || body.models === modelsKey())` it returns `ok({ revision, unchanged: true, ...live() })`. The client polls `state` every 1500 ms visible / 10000 ms hidden (`ds-bot/src/client/index.js:186-201`), and the desktop window instead holds the SSE feed.

### 3.3 Every client→host call

Dispatch is one `switch` in `ds-bot/src/host/channel.js:145-546`; `default:` returns `fail(\`Unknown endpoint ${endpoint}\`, 'bot/not-found')`. Delegated families route to `rt.folderEndpoint`, `rt.secretEndpoint`, `rt.connectorEndpoint`, `rt.capabilityEndpoint`, `rt.scheduleEndpoint`, `rt.memoryEndpoint`, `rt.browserChannel`.

| Endpoint | Payload | Returns / does |
|---|---|---|
| `state` | `{ locale, since, models }` | The whole team snapshot (`ds-bot/src/host/channel.js:38-82`) plus the `live()` half (`:88-95`), or `{ revision, unchanged:true, ...live() }` |
| `models` | — | Cached model catalog (`ds-bot/src/host/models.js`) |
| `efforts` | `{ ref }` | Reasoning-effort rows for a model ref |
| `thinking` | `{ sessionId, turn }` | Thinking time for a turn (`ds-bot/src/host/thinking.js:7,35`) |
| `providers`, `provider-models` | `{}` / `{...}` | DSH provider rows (`ds-bot/src/host/providers.js:9,51`) |
| `provider-add`, `provider-key`, `provider-remove` | `{...}` / `{ provider, value\|null }` / `{ provider }` | Add/remove a provider; set or clear its key |
| `set-prefs` | `{ theme, accent, motion, layout, width, flatWidth, thinking }` | Validates and writes `state.prefs` (`ds-bot/src/host/channel.js:100-137`); `null`/`''` deletes a key |
| `create-bot`, `update-bot`, `delete-bot`, `duplicate-bot` | `{ name, role, color, instructions, brief, avatar, model, effort, workDir }` / `{ id, ... }` | Bot lifecycle (`ds-bot/src/host/roster.js`, `agents.js`, `tools.js:297,332`) |
| `set-main` | `{ id, main, primary, replace }` | Main-Bot flags (`state.mainBotIds`) |
| `set-flags` | `{ id, ... }` | Per-Bot switches |
| `create-room`, `update-room`, `delete-room`, `room-continue` | `{ members, name, admin, greet }` / `{ id, name, notice, mode, admin, members, add, remove, workDir, permission, relayLimit }` / `{ id }` / `{ roomId }` | Group chats (`ds-bot/src/host/groups.js:133`) |
| `chat`, `earlier` | `{ botId, cursor }` / `{ sessionId, cursor }` | Paged chat history for a Bot's own chat / a Session |
| `exchange`, `exchange-text` | `{ a, b }` / `{ id }` | The bot-to-bot message dialog and its full text (`ds-bot/src/host/parts.js`) |
| `run-stats`, `room-progress` | `{ botId }` / `{ roomId }` | `RUN_STATS = ['sessionStats','tokenUsage','contextPressure']` (`ds-bot/src/host/channel.js:12`) |
| `usage` | `{ timeZone }` | Hourly usage rows from `<home>/usage.sqlite` (`ds-bot/src/host/usage.js:230`) |
| `send` | `{ sessionId, text }` | `ctx.sessionController.prompt({ requestId: randomUUID(), sessionId, mode:'queue', content:[{type:'text',text}] }, AbortSignal.timeout(30_000))` after `rt.ensureCapabilities` |
| `answer-question` | `{ sessionId, questionId, answer }` | Claims the question by deleting `state.questions[sessionId]` **before** queueing (so a second answer is refused), then `followup(createUserMessage(...))` + `ctx.sessions.flush`, restoring the question on error |
| `view-reply` | `{ sessionId, viewId, action, values }` | Same shape via `validateViewAnswer` / `viewReply` (`ds-bot/src/host/parts.js:92`) |
| `approval-answer` | `{ id, choice }` | Answer a permission prompt (`ds-bot/src/host/approvals.js:9`) |
| `stop-member-work` | `{ roomId, botId }` | Stop one member's turn in a group |
| `dismiss-question`, `dismiss-view` | `{ sessionId }` | Drop a card |
| `secret-set`, `secret-allow`, `secret-cancel`, `secret-update`, `secret-delete` | via `rt.secretEndpoint` | Secrets (`ds-bot/src/host/secrets.js:89,419,468`) |
| `connector-connect`, `connector-disconnect`, `connector-retry` | via `rt.connectorEndpoint` | GitHub connector (`ds-bot/src/host/connectors.js:24,41`) |
| `capability-save`, `capability-delete`, `capability-approve`, `bot-capability` | via `rt.capabilityEndpoint` | Capability library (`ds-bot/src/host/capabilities.js:51`) |
| `schedules`, `schedule-create`, `schedule-delete` | via `rt.scheduleEndpoint` | Scheduled tasks (`ds-bot/src/host/schedules.js:71`) |
| `memory-view`, `memory-ask`, `memory-forget` | via `rt.memoryEndpoint` | Memory (`ds-bot/src/host/memory.js:463` root = `<home>/memory`) |
| `folders`, `folder-pick`, `folder-list` | via `rt.folderEndpoint` | Folder chooser (`ds-bot/src/host/folders.js:20`; needs DSH's directory-picker service) |
| `team-workspace` | `{ path }` | Move the team workspace; the plugin tells the shell, which writes `locations.json` (`app/README.md:30`) |
| `avatar-library`, `avatar-import`, `avatar-delete` | `{ offset, limit }` / `{ items }` / `{ id }` | Avatar library (`ds-bot/src/host/avatar-library.js:18`) |
| `add-agent`, `agent-session`, `agent-adopt`, `agent-archive`, `agent-rename`, `remove-agent` | `{ agentId, workspaceId \| sessionId \| title }` | The team's one "DSH Agent" (`ds-bot/src/host/agents.js:7`) |
| `btw-delete` | `{ sessionId, cardId }` | Delete an aside card (`ds-bot/src/host/btw.js`) |
| `side-new`, `side-ask`, `side-cancel`, `side-close` | `{ sessionId }` / `{ sessionId, chatId, recent, text }` / `{ chatId, entryId }` / `{ chatId }` | Side chats (`ds-bot/src/host/side.js:44`) |
| `update-check`, `update-install`, `dsh-update-install`, `repo-stars` | `{ fresh }` / — | DS-Bot's own npm update, DSH's update, and the repo's star count (`ds-bot/src/host/update.js:9-13`, `dsh-update.js:22`) |
| `browser-wait`, `browser-result`, `browser-takeover`, `browser-give-back`, `browser-stop` | `{ clientId, open }` / `{...}` / `{ botId }` / `{ botId, outcome: 'done'\|'skip'\|'returned', callId }` / `{ botId }` | `browser-wait` is a **long poll** against `rt.browserChannel`; it fails `bot/browser-off` when the channel is absent and `bot/invalid`-style "A browser poll needs a clientId" when empty (`ds-bot/src/host/channel.js`, `ds-bot/src/host/browser.js:24`) |
| `diagnostics`, `diagnostics-log`, `diagnostics-clear` | `{...}` | Client error report (`ds-bot/src/host/diagnostics.js:114`) |

**Argument defaults**: `handle` opens with `const body = payload ?? {}` (`ds-bot/src/host/channel.js:139`), so every payload is optional and validation happens per-endpoint.

### 3.4 Every host→client push

`ds-bot/src/host/feed.js` is the whole realtime surface. Four event names, all `data:` JSON:

| Event | Data | Emitted from |
|---|---|---|
| `hello` | `{ revision }` | On every (re)connect — the client catches up from here (`feed.js:85-102`) |
| `revision` | `{ revision }` | `rt.stateSaved` hook (`feed.js:35-37`) — "the team was saved: ask for `state` again" |
| `live` | `{}` | Debounced 150 ms (`LIVE_DELAY_MS`) from `ctx.on('agent/status')` when the agent is one of ours (`feed.js:47-49`) and from `session/event` on `tool/call` (`feed.js:51-57`) |
| `message` | `{ botId, sessionId, item }` | Per display item of a `session/event` whose session is a Bot's own chat (`feed.js:51-57`) |
| `stream` | `{ botId, sessionId, attemptId, turn, phase:'start'\|'end', text? }` | `ctx.on('agent/assistant-stream')`: `start` only when the turn is **not** in `state.exchangeTurns` (a turn answering another Bot is hidden), `chunk` with `chunk.type === 'text-delta'` carries `text`, `end` closes (`feed.js:61-77`) |

Connection hygiene: keepalive comment `: keepalive\n\n` every 20 s (`KEEPALIVE_MS`), `MAX_QUEUED 512` — a window that stops reading is dropped and reconnects, catching up from `hello` (`feed.js:9-13`, `:104-114`).

**Realtime is SSE and only SSE.** There is no WebSocket anywhere in `ds-bot/src/host/**` — the client's poll loop (`ds-bot/src/client/index.js:186-201`) is the fallback for a host whose feed is not consumed. Note that CCP-Bot's realtime is a **WebSocket** (`server/src/channels/socket.ts:11`, `server/src/http-server.ts:8,27-29`), so a port must either serve SSE alongside it or translate.

### 3.5 Storage

All of it under the plugin's home; `home = config.home ?? join(dshHome, 'bot')`, `dshHome = folders.dshHomeOf(process.env.DSH_HOME)` (`ds-bot/index.js:56-71`, `ds-bot/src/host/folders.js:18`). With the desktop app, `DSH_HOME` is the data location the user picked at first start (`app/src/main.mjs:186`).

| Path | Shape | Written by |
|---|---|---|
| `<home>/state.json` | **One JSON file, the whole team** — `{ version:1, mainBotIds:[], bots:{}, rooms:{}, agents:{}, capabilities:{items:{}}, exchanges:[], exchangeTurns:{}, works:{}, requests:{}, questions:{}, views:{}, prefs:{}, switching:{}, revision:0 }` (`ds-bot/src/host/store.js:22`) | `store.js` — written whole on every save; migrate-on-read via `adopt()` (`:106-200`) |
| `<home>/state.lock` | Lock file with `pid` (+ optional `host`) and a 60 s stale / 15 s beat heartbeat | `ds-bot/src/host/home-lock.js:25` via `store.js:45-58` |
| `<home>/state.json.broken-<ts>` | Backup of a file that failed `JSON.parse` (`store.js:66-102`) | `store.js` |
| `<home>/usage.sqlite` | Hourly rows `[hour, owner, model, kind, input, cacheRead, cacheWrite, output, calls]` (`ds-bot/src/client/usage-data.js:3-6`) | `ds-bot/src/host/usage.js:230` |
| `<home>/secrets.json` | Secret names, values, purposes, per-Bot grants; `SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/`, values 4…16384 chars; injected to tools as env `DSH_SECRET_<NAME>` (`ds-bot/src/host/secrets.js:12-23,91`) | `secrets.js:89` |
| `<home>/memory/team/MEMORY.md` + `<home>/memory/bots/<botId>/MEMORY.md` and topic files | Markdown with `[key: value; …]` metadata; limits 300/entry, 4,000/`MEMORY.md`, 16,000/topic, 40 topics per scope (`ds-bot/src/host/memory.js:41`, `:6,43,463`) | `ds-bot/src/host/memory.js` |
| `<home>/pending.json` | Memory writes awaiting a turn boundary (`ds-bot/src/host/memory-pending.js:17,25`) | `memory-pending.js` |
| `<home>/btw/` | Aside ("by the way") cards, one directory per conversation part (`ds-bot/src/host/btw.js:205`; migration comment at `store.js:165-166`) | `btw.js` |
| `<home>/chat-index.sqlite` | Full-text index `lines(text, session, seq, time, who)` for `read_own_chat` / `read_group_chat` search (`ds-bot/src/host/chat-index.js:25,42,48`) | `chat-index.js` |
| `profiles/ds-bot/cordis.patch.yml`, `.credentials.yaml`, `.env` | Provider rows and keys — **DSH's** files, not the plugin's (`app/README.md:34,46`) | DSH |

**Truncation is a deliberate design constraint**: `state.json` is written whole on every save, so a long bot-to-bot message or group line keeps only its first 2000 characters (`TEXT_KEPT`) there; the rest stays in the Session it was delivered to or in a file of its own — a message past `MESSAGE_INLINE_MAX` (20,000) goes as a DSH file and keeps `LONG_HEAD` = 1000 characters (`ds-bot/src/host/constants.js:24-26` and the `TEXT_KEPT`/`MESSAGE_INLINE_MAX`/`LONG_HEAD` block).

### 3.6 What a Hono host must supply

To run DS-Bot's client UI against a CCP-Bot server, the server needs, in order of blocking-ness:

1. `POST /api/bot` + `GET /api/bot/feed` on the same session cookie as the rest of the app.
2. `state` — the snapshot shape at `ds-bot/src/host/channel.js:38-95`, including `revision`, `mainBotIds`, `bots[].sessionId`, `prefs`, `colors`, `models`, `modelsKey`, `readOnly`.
3. `set-prefs` with the same validation and the same delete-by-`null` semantics (`:100-137`).
4. `chat` + `send` + `answer-question` + `view-reply` — i.e. a conversation store and a way to start a turn.
5. `message` and `stream` feed events, which need a per-turn event source. On CCP-Bot that is `server/src/channels/*` (its WebSocket carries channel activity — `server/src/http-server.ts:15`), so the port is an adapter, not a rewrite.
6. Optional at first: `browser-wait` (the long poll) — only the desktop shell's webview bridge calls it (`ds-bot/src/client/index.js:251-272`).

## 4. Capability inventory

Portability classes: **as-is** (framework-agnostic, reusable verbatim) · **rewrite** (logic reusable, view rebuilt in React/TS) · **runtime** (needs a DSH/cordis capability CCP-Bot does not have — named in the row).

| Capability | What it does for the user | Host | Client | Depends on | Data | Class |
|---|---|---|---|---|---|---|
| **通用 settings** — theme, accent, motion, message layout, bubble width, show-thinking | Settings → General; picks the look and the conversation shape | `ds-bot/src/host/channel.js:100-137` (`set-prefs`), `:38-82` (`prefs`) | `ds-bot/src/client/settings.js:29` (`SETTINGS_PAGES`), `:230` (`SettingsDialog`); `themes.js:58,61,118,123,125`; `motion.js:3-10,45-48` | Nothing | `state.json` → `prefs` | **rewrite** — the whole validation + delete-by-null semantics is reusable as a route handler; DS-Bot's view is raw `h()` + `bt-` CSS classes, so the view is a fresh React form |
| **Theme tokens into the shell** | The Bot surface repaints DSH's own chrome | `ds-bot/src/client/index.js:305-350` (`installTheme`) | `themes.js:58` (`themeCss`), `:61` (`shellTokens`) | `ctx.theme.overrideTokens` | `prefs.theme/accent` | **runtime** (`theme` service) for the shell tokens; the plugin's own palette and `themeCss` output are **as-is** |
| **经典 Agent 模式切换** | Withdraws the whole Bot surface so the raw Harness UI returns | `ds-bot/src/client/surface.js:1-94` (whole file), mounted via `ds-bot/src/client/surface.js:23-58` (`surfaceGroups`) | `ds-bot/src/client/index.js:64`, `:788-863` (all `shadow(...)` registrations) | `ctx.slots` register/inject + `ctx.layout` | `localStorage` `STORAGE.surface` (`surface.js:88-93`) | **runtime** — this *is* the DSH slot system; with no second shell to fall back to it has no meaning. CCP-Bot's equivalent is its skins |
| **位置 / 总工作区** | Move the data location and the team workspace | `ds-bot/src/host/folders.js:12,18,20` (`within`, `dshHomeOf`, `install`); `team-workspace` endpoint | `ds-bot/src/client/settings.js` general page | DSH directory-picker service (`app/engine/cordis.patch.yml:53-55`) + the Electron shell's `move-data` (`app/src/move-data.mjs`, `app/README.md:30`) | `locations.json` in the app's own data | **rewrite** — the *rules* (neither folder inside the other or inside the user's DSH data, staging-folder copy, old folder always stays) are plain filesystem logic from `app/src/move-data.mjs`; the picker dialog is platform work (CCP-Bot has Tauri dialogs and `vault.rs`) |
| **Harness 设置** | Opens DSH's own settings UI | — | `ds-bot/src/client/sidebar.js:436` (`openHarnessSettings`), `:447` (`openHarnessOnboarding`), `ds-bot/src/client/index.js:583-596` | DSH settings slots + `pluginNavigation.openBundle` | DSH's | **runtime** (DSH settings UI); CCP-Bot has no DSH to hand over to |
| **主 Bot / Bot 列表 / 新建 Bot** | The roster, the Main Bot, creating and editing Bots | `ds-bot/src/host/roster.js:42`, `agents.js:7`, `tools.js:297,332` (`create_bot`/`update_bot`), `channel.js` `set-main`/`set-flags`/`duplicate-bot` | `ds-bot/src/client/sidebar.js:251` (`TeamSidebar`), `:626` (`FooterAccount`); `create-bot.js:22`; `bot-settings.js:20-58,83,178`; `details-drawer.js:175` | `ctx.sessions` (one Bot = one root Session), `ctx.sessions.create`, model catalog | `state.json` → `bots`, `mainBotIds` | **rewrite** — the record shape and the tool contracts port cleanly; the Session-per-Bot mapping has to become CCP-Bot's `agents` |
| **Bot 动画 安静/正常/活泼** | How lively the Bots look | — | `ds-bot/src/client/motion.js:3-48`, `ds-bot/src/client/index.js:305-350` (`document.body.dataset.btMotion`) | CSS only | `prefs.motion` | **as-is** (the CSS/springs); **rewrite** for the picker |
| **群聊（房间）** | "几个 Bot 和你一起做一件事": several Bots in one room, with modes | `ds-bot/src/host/groups.js:133` (`install`), `:39` (`defaultRelayLimit`), `:87` (`mentionsIn`), `:574,682` (`group_relay`, `read_own_chat`), `:738` (`read_group_chat`); `channel.js` `create-room`/`update-room`/`room-continue`/`stop-member-work` | `ds-bot/src/client/group-settings.js:11,17,68,152`; `member-status.js:18-49,104` (`MemberDock`), `:164` (`StopMemberWork`); `cells.js` (room rows) | `ctx.sessionController.prompt`, `ctx.sessions`, per-Session events, `state.rooms[].log` | `state.json` → `rooms`; long lines overflow to files (`constants.js:24-26`) | **rewrite** for the model; **runtime** for the turn engine (it drives real DSH Sessions and reads their events) |
| **Bot 之间互相发消息 + 交接** | One Bot messages another; a Bot hands work over and the next part picks it up | `ds-bot/src/host/tools.js:142` (`message_bot`), `:270` (`stop_bot`); `handoffs.js:19`; `ds-bot/src/host/requests.js:19-140` (idempotent `request_id`); `delivery.js:7`; `parts.js:107` (`handoffReply`) | `ds-bot/src/client/handoff-card.js:39,85,97,109`; `exchange.js:13` (`ExchangeDialog`) | DSH Session followup + `ctx.sessions.flush`; `state.exchangeTurns` to hide answer turns from the chat | `state.json` → `exchanges`, `exchangeTurns`, `requests` | **runtime** — it is built on DSH's `sessionController.prompt` + session event stream. `requests.js` (idempotency) is **as-is** and worth lifting on its own |
| **旁路问答（BTW / aside）** | Ask a Bot something without polluting the conversation; the answer sits under the turn | `ds-bot/src/host/btw.js` (`rt.stateSaved`, `anchorProjection`, `snapshotOf`, `openTurnAt`) | `ds-bot/src/client/btw-model.js`, `ds-bot/src/client/cells.js` (`BtwTurnTail`), `ds-bot/src/client/index.js:846` (`BtwDock`) | DSH **projections** (`projections.register`, `conversation.openTurn`) + `agent/assistant-stream` | `<home>/btw/` per conversation part | **runtime** (DSH projection API) — the storage format is reusable, the anchoring is not |
| **侧边对话（side chat）** | A separate short conversation off to the side | `ds-bot/src/host/side.js:15` (`SIDE_MARKER`), `:30` (`promptFor`), `:44` (`install`) | `ds-bot/src/client/side-chat.js:37,79`, `side-model.js` | DSH `ctx.sessions` + `agent/assistant-stream` | `state.json` → in-memory chats (`sideChats` in `state`) | **runtime** |
| **卡片 / 控件（widgets, cells）** | A Bot shows a form, a chart, a table and takes the answer back | `ds-bot/src/host/tools.js:610` (`ask_user`), `:667` (`show_view`); `parts.js:47,69,92,131` (`viewCardText`, `questionReply`, `viewReply`, `readReply`); `ds-bot/src/shared/views.js` (685) validates | `ds-bot/src/client/widget-cell.js:324,361,412,435,459,468,486`; `widget-chart.js`; `widget-html.js`; `questions.js:141-218` | DSH `conversation.chat.node` / `conversation.composer` slots | `state.json` → `views`, `questions` | **rewrite** — `ds-bot/src/shared/views.js` is framework-agnostic validation (**as-is**); the mounting is DSH slots (**runtime**) |
| **权限询问 / approvals** | A tool that needs permission asks; the user picks once / always / skip | `ds-bot/src/host/permissions.js:8`, `approvals.js:9`, `channel.js` `approval-answer` | `ds-bot/src/client/permission-picker.js`, `approvals/approval-notices.js:6` | DSH tool-permission hooks | `state.json` → `works` | **runtime** (DSH permission hooks) |
| **记忆（memory）** | A Bot remembers across conversations; a team memory shared by all | `ds-bot/src/host/memory.js` (1,748 lines): `:41` limits, `:88-181` parse/format/link, `:249` `wordsOf`, `:463` root, `:927,931` prompt sections; `memory-pending.js:17,25`; `channel.js` `memory-view`/`memory-ask`/`memory-forget` | `ds-bot/src/client/memory-panel.js:24,38,209` | DSH `systemPrompt` sections + the tool registry; OCR for images | `<home>/memory/team/MEMORY.md`, `<home>/memory/bots/<botId>/` + topics; `<home>/pending.json` | **rewrite** — the file format, limits and retrieval are **as-is** and could sit on CCP-Bot's `server/src/memory` (pgvector + `knowledge/`); the prompt-section wiring is **runtime** |
| **密钥（secrets）** | A Bot asks for a key once; the value never leaves the host | `ds-bot/src/host/secrets.js:12-23` (name/value rules), `:38` (`redactor`), `:65` (`redactDeep`), `:89` (install), `:419,468` (`request_secret`, `list_secrets`) | `ds-bot/src/client/secret-card.js:38,82,154,175,283` | DSH tool env injection; redaction on every outgoing string | `<home>/secrets.json`; injected as `DSH_SECRET_<NAME>` | **as-is** for the store, rules and redactor; **rewrite** for the card |
| **能力（capabilities）** | A saved, shareable ability a Bot can be given | `ds-bot/src/host/capabilities.js:10,18,51`, `:305` (`c.skills.register`), `channel.js` capability family | `ds-bot/src/client/capability-settings.js:112,153` | **DSH skills registry** for the runtime half | `state.json` → `capabilities.items` | **rewrite** for the library; **runtime** for `c.skills.register` |
| **定时任务** | A recurring job | `ds-bot/src/host/schedules.js:16,32,43,71`; `channel.js` schedule family | `ds-bot/src/client/schedules.js:19` (`useSchedules`), `:53` (`timingText`), `:180,203,221` | Cron-ish selector (`selectorOf`) + DSH Session followup | `state.json` → schedules | **rewrite** — CCP-Bot already has `server/src/routines/*` with a real scheduler; the host half here is small |
| **连接器** | Connect an outside account (GitHub) so Bots can use it | `ds-bot/src/host/connectors.js:12,13,24,41` | `ds-bot/src/client/connectors.js:8,60` | Plain HTTPS + the secrets store | `state.json` → connectors; token in `secrets.json` | **rewrite** — CCP-Bot's `server/src/plugins` (Composio, MCP, OAuth, Arcade) is far ahead of this; a port is a downgrade |
| **浏览器** | A Bot browses, clicks, fills; risky actions ask first; the user can take over | `ds-bot/src/host/browser.js:24` (`createBrowserChannel`), `:246,257` (`read_browser` tool); `browser/session.js:91,120` (Playwright); `browser-plugins.js:12,62,114`; `browser/task.js`, `browser/refs.js` | `ds-bot/src/client/browser-pane.js:20-160,566,788`, `bot-browsers.js`, `browser-settings.js:28` | DSH directory roots, a **desktop webview** (`webviewTag`, `app/src/bot-browser.mjs`), Playwright with a persistent profile | Grants in `state.json`; each Bot's profile on disk under the app's own data | **runtime + rewrite** — the capability model and the 已允许的操作 table are reusable; the webview lease bridge (`ds-bot/src/client/index.js:251-272` → `window.dsBotApp.browser`) is host-specific, and CCP-Bot's `server/src/browser` + `agent-computer` + `desktop/src-tauri/src/local_browser.rs` is a different (server-side) design |
| **用量** | Tokens and calls per hour, per Bot, per model | `ds-bot/src/host/usage.js:32,53,96,108,134,196,228` (`sqliteLedger` at `:134`, path at `:230`) | `ds-bot/src/client/usage-page.js:397,594`; `usage-data.js:3-6,12-30` (`RANGES`, `hourMs`, `dayKey`) | `sessionStats` / `tokenUsage` projections from DSH sessions | `<home>/usage.sqlite` | **as-is** for the ledger, folding and timezone bucketing; **rewrite** for the 758-line page |
| **反馈** | Report a problem; the report has the version and recent errors | `ds-bot/src/host/diagnostics.js:14,18,19,39,56,64,92,101,114` | `ds-bot/src/client/feedback.js:28,60,139,156`; `diagnostics.js:11-72` (client-side capture) | GitHub issue URL | client errors in memory; nothing persisted | **as-is** — `reportMarkdown` + `cleanText` (redaction, home-path scrubbing) are pure functions |
| **关于 DS Bot** | Version, DSH version, star count, update state | `ds-bot/src/host/update.js:9-13,22,42,63,65,73,86,99,106`; `dsh-update.js:22`; `channel.js` `update-check`/`repo-stars` | `ds-bot/src/client/about.js:36` (`ownAppRow`), `:61` (`AboutPage`), `:134` | npm registry (`registry.npmjs.org` / `npmmirror.com`), GitHub releases API | none | **as-is** — plain HTTPS + version comparison |
| **新版本 badge / 自更新** | A badge when a new DS-Bot or DSH is available; install and restart | `update.js` (`CHECK_TTL_MS = 10 min`, phases `checking/available/downloading/downloaded/installed/updated/failed`), `dsh-update.js` | `about.js:36-51` (`ownAppRow`); the badge in `sidebar.js` / `usage-page.js` | The Electron shell's `electron-updater` (`app/src/updates.mjs`, `app/README.md:84-90`) via `window.dsBotApp.updates` (`app/src/preload.cjs:87,93-96`) or DSH Desktop's `window.dshDesktop.updates` (`ds-bot/src/client/index.js:225-247`) | shell state | **rewrite** — CCP-Bot has **no updater at all** (`grep -rln "updater" desktop/src-tauri/src` → no hits) |
| **成员状态 / 谁在忙** | Which group member is thinking, which tool it is running, who is waiting | `ds-bot/src/host/roster.js:42`, `groups.js` (`roomWorkView` in `channel.js:88-95`), `channel.js` `waitingView`/`turnsView`/`steeredView` | `ds-bot/src/client/member-status.js:18-49,104,153,164`; `activity-row.js:16-106`; `feed.js` `live` event | `agent/status` + `session/event` (DSH) | derived, in memory | **runtime** (DSH agent/status events); the presentation is **rewrite** |
| **@ 提及菜单** | Type `@` to address a Bot or cite a conversation | `ds-bot/src/host/groups.js:87` (`mentionsIn`), `:98` (`referenceNote`); `ds-bot/src/shared/mentions.js` | `ds-bot/src/client/at-menu.js:9,10,25,43,65,74`; `ds-bot/src/client/index.js:751-777` | DSH `inputTriggers` + `ctx.sessions` | — | **runtime** (`inputTriggers`); `mentionsIn` + `shared/mentions.js` are **as-is** |
| **语音 / 朗读** | Talk to a Bot; hear replies | `ds-bot/src/host/` (voice is client-driven) | `ds-bot/src/client/voice.js:60` (`VoiceMode`), `speech.js:4,7,15,38,48,103,112` (`VOICE_BUNDLE`, capture, transcribe, turn detection) | `@deepseek-ai/dsh-experimental-voice-input-bundle` (`speech.js:4`) + `ctx.get('remote.speech')` | — | **runtime** (an experimental DSH bundle) |
| **图片 / OCR** | Paste an image; its text is read into the conversation | `ds-bot/src/host/images.js:12,31`; `constants.js` `OCR_PROMPT`, `OCR_TIMEOUT_MS`, `OCR_RETRY_MS`, `OCR_CACHE_MAX` | attachment rendering in `cells.js` | The `llm` service for the OCR call | in-memory cache (max 500) | **runtime** for the model call; the prompt and cache policy are **as-is** |
| **头像库** | Pick a look or upload a photo | `ds-bot/src/host/avatar-library.js:18`, `avatar.js:90,98` (`avatarBytes`, `readAvatar`); `channel.js` avatar family | `ds-bot/src/client/avatar-library.js:11,35,57,66,145`; `characters.js`; `mark.js` | Filesystem read of a chosen image; `MAX_AVATAR_IMAGE = 160_000` | `state.json` → avatars; library files on disk | **rewrite** |
| **诊断（一个窗口看全部）** | A page listing recent host and client errors | `ds-bot/src/host/diagnostics.js:114`; `channel.js` `diagnostics`/`diagnostics-log`/`diagnostics-clear` | `ds-bot/src/client/diagnostics.js:11-72` | Nothing | ring buffer, `KEEP = 200`, `REPORT_ENTRIES = 20` | **as-is** |

### 4.1 The two dozen Bot tools

`TEAM_TOOLS` (`ds-bot/src/host/constants.js:64-71`) is the exact tool surface a Bot sees. Registered at:

| Tool | Line |
|---|---|
| `list_bots` | `ds-bot/src/host/tools.js:58` |
| `message_bot` | `ds-bot/src/host/tools.js:142` |
| `stop_bot` | `ds-bot/src/host/tools.js:270` |
| `create_bot`, `update_bot` | `ds-bot/src/host/tools.js:297`, `:332` |
| `list_bot_models` | `ds-bot/src/host/tools.js:407` |
| `create_group`, `update_group`, `delete_group` | `ds-bot/src/host/tools.js:449`, `:478`, `:539` |
| `post_to_group` | `ds-bot/src/host/tools.js:556` |
| `ask_user` | `ds-bot/src/host/tools.js:610` |
| `show_view` | `ds-bot/src/host/tools.js:667` |
| `list_capabilities`, `save_capability`, `delete_capability` | `ds-bot/src/host/tools.js:776`, `:800`, `:830` |
| `group_relay` | `ds-bot/src/host/groups.js:575` |
| `read_own_chat` | `ds-bot/src/host/groups.js:683` |
| `read_group_chat` | `ds-bot/src/host/groups.js:738` |
| `request_secret`, `list_secrets` | `ds-bot/src/host/secrets.js:420`, `:469` |
| `read_browser` | `ds-bot/src/host/browser.js:258` |
| `remember`, `forget`, `recall` | `ds-bot/src/host/memory.js` (tool registrations in the same module) |
| `attach_capability`, `detach_capability` | `ds-bot/src/host/capabilities.js` |

`constants.js:62-63`: *"`read_browser` only exists in the Desktop profile, so a restriction filters this list down to registered names."* That is the one tool whose availability differs by profile.

## 5. What CCP-Bot already has

Line 1 of each row is the honest verdict. **CCP-Bot is a much larger product than DS-Bot** — 65,317 lines of tsx in `app/` and a server with 55 top-level modules — so most capabilities exist in some form; the question is always whether the *semantics* match.

| Capability (§4) | Verdict in CCP-Bot |
|---|---|
| 通用 settings | **partial** — `app/src/lib/settings/message-list.ts:36` has `messageListEmphasis ?? "thread"` and the preference type lives in `shared` (re-exported at `message-list.ts:13`); `app/src/lib/settings/mutations.ts` and `queries.ts` are the mutation/query pair. There is **no** theme+accent palette, bubble-width, or show-thinking preference. |
| Theme tokens / 主题 | **partial** — four skins, not a theme matrix: `app/src/skins/registry.ts:13-20` registers `ccpbot`, `openduet`, `opendots`, `openmuse`; `app/src/skins/skin-picker.tsx`, `types.ts:15` (`SkinId`), `store.ts` |
| 经典 Agent 模式 | **absent** — DS-Bot's mode is an escape hatch back to the raw DSH UI; CCP-Bot has no second shell to escape to. Its `s`/skins system is the nearest analogue. |
| 位置 / 总工作区 | **absent** as a user-facing move. The local stack's own directories are managed in Rust (`desktop/src-tauri/src/local.rs`, `env.rs`, `supervise.rs`); the `vault.rs` dialog plumbing exists to build one. |
| Harness 设置 | **partial** — `desktop/src/HarnessPicker.tsx`, `desktop/src-tauri/src/harness.rs`; "Harness" here means the upstream checkout, not a settings surface handed to DSH. |
| 主 Bot / Bot 列表 | **present, different model** — `app/src/components/bots/bot-roster.tsx`; routes `app/src/routes/_authed/_app/bots.index.tsx`, `bots.$agentId.{index,activity,approvals,memory,reach,responsibilities,routines,setup,sharing,access}.tsx`; cards in `app/src/components/agents/agent-card.tsx`, `agent-profile.tsx`. There is no single "Main Bot"/Chief and no `set-main`. |
| 新建 Bot | **present** — `app/src/components/agents/new-bot-sheet.tsx` (968 lines), `proposed-bot.tsx`, `abstract-avatar.tsx`; server side `server/src/agents/*` + `app.ts:1471 "/api/agents"` |
| Bot 动画 安静/正常/活泼 | **absent** — `grep -rln "lively\|quiet" app/src` finds nothing in this sense. |
| 群聊 | **present** — `app/src/routes/_authed/_app/group/new.tsx`, `group/$channelId.tsx`, `channel/new.tsx`, `channel/$channelId.tsx`; `server/src/channels/group.ts`, `server/src/db/schema/group.ts`, `app.ts:1686 "/api/groups"`. CCP-Bot's channels are membership-scoped (`server/src/team-bots/team-bots.ts:11-12`), which DS-Bot's rooms are not. |
| Bot 互相发消息 / 交接 | **present** — a whole subsystem: `server/src/agents/handoff.ts`, `handoff-delivery.ts`, `handoff-runner.ts`, `handoff-signing.ts`, `handoff-tool.ts`, `handoff-wiring.ts`, `escalation.ts`; UI at `app/src/components/agents/handoff-panel.tsx`, `callback-token-panel.tsx`. No `request_id`-style idempotency receipt — DS-Bot's `ds-bot/src/host/requests.js` is a real gap here. |
| 旁路问答（BTW） | **absent** — no aside/anchored-question surface. |
| 侧边对话 | **absent** — `grep -rln "side-chat\|sideChat" app/src` returns unrelated hits only. |
| 卡片 / 控件 | **present, different shape** — `server/src/components/{store,functions,headless,sandboxed,sandboxed-routes,routes}.ts`; `app.ts:1785 "/api/components"`; gallery at `app/src/routes/_authed/settings/components-gallery/{index,$name}.tsx` and `app/src/components/gallery/{charts,table,cards}.tsx`. DS-Bot's `ds-bot/src/shared/views.js` is a *declarative* form/table/chart validator; CCP-Bot's components are sandboxed code. Different trade-off, same user need. |
| 权限询问 / approvals | **present and deeper** — `server/src/approvals/{service,policy,store,types,execute,questions,question-resume,resume-sweep,person-response-sweep,wiring,routes}.ts`; UI `app/src/routes/_authed/_app/approvals.tsx`, `app/src/routes/_authed/settings/approvals.tsx`, `app/src/components/approvals/`. |
| 记忆 | **present and deeper** — `server/src/memory/{store,ingestion,intelligence,tools,types,defaults}.ts`, `server/src/memory/embedding/{config,provider}.ts`, `server/src/memory/knowledge/{chunk,store,routes}.ts` (pgvector); UI `app/src/routes/_authed/_app/memory.tsx`, `bots.$agentId.memory.tsx`, `capabilities.memory.tsx`, `app/src/routes/_authed/settings/memory.tsx`, `app/src/components/memory/sources.tsx`. DS-Bot's `MEMORY.md` + topics file format has no equivalent. |
| 密钥 | **present** — `server/src/credentials.ts`, `app.ts:1205-1279` (`/api/admin/credentials`, `:credentialId/rotate`, `/revoke`); UI `app/src/routes/_authed/admin/credentials.tsx`, `credentials_.new.tsx`, `app/src/lib/credentials/`; the desktop vault is `desktop/src-tauri/src/vault.rs`. DS-Bot's model — a *Bot asks the user for a key mid-conversation and the value never leaves the host* (`secrets.js:419`) — is a nicer UX than admin-managed credentials. |
| 能力 | **present** — `app/src/routes/_authed/_app/capabilities.index.tsx`, `.memory.tsx`, `.skills.tsx`, `capabilities.tsx`; `app/src/components/capabilities/capabilities-shell.tsx`; `server/src/admin/capabilities.ts:27,81,111` (`teamBots` is one of the capabilities in this sense). |
| 定时任务 | **present and deeper** — `server/src/routines/{store,schedule,runner,sweep,routes}.ts`; `app/src/routes/_authed/_app/routines.tsx`, `bots.$agentId.routines.tsx`, `app/src/components/routines/routines-list.tsx`; `server/src/plugins/builtin-routines.ts`. |
| 连接器 | **present and far deeper** — `server/src/plugins/{composio,composio-client/*,arcade,mcp,oauth,broker,catalogue,app-access,google-drive-rest,route-groups/*}.ts`; UI `app/src/routes/_authed/_app/connections.index.tsx`, `connections.$key.tsx`, `app/src/routes/_authed/settings/connected-accounts/{index,$key}.tsx`, `admin/plugins/*`. DS-Bot has GitHub only (`connectors.js:12`). |
| 浏览器 | **present, different architecture** — `server/src/browser/{bot-browser,host,egress,person,address,routes}.ts`, `app/src/routes/_authed/_app/browser.tsx`, `app/src/components/browser/{browser-bar,browser-nav-item,recording}.tsx`, `app/src/routes/_authed/settings/browsers.tsx`, `desktop/src-tauri/src/local_browser.rs`, `agent-computer/`. CCP-Bot's is server-side through a bot-browser host; DS-Bot's is a desktop webview the user watches and can take over. |
| 用量 | **absent for the person** — no personal usage page (`grep -rln "usage" app/src/components/settings app/src/routes/_authed/settings` → nothing); what exists is telemetry (`server/src/telemetry/otel.ts`, `scrub.ts`) and an admin view (`app/src/routes/_authed/admin/enterprise.tsx`). |
| 反馈 | **absent** — no feedback page; `server/src/audit.ts` is audit, not user reports. |
| 关于 | **partial** — nothing at `app/src/routes` corresponds to DS-Bot's About + star count + three update rows; the desktop onboarding shows versions (`desktop/src/App.tsx`, `Welcome.tsx`). |
| 新版本 badge / 自更新 | **absent** — `grep -rln "updater" desktop/src-tauri/src` → no hits; no `tauri.conf.json` updater block. The only "update" strings are about remote computers (`app/src/lib/computers/queries.ts`). |
| 成员状态 | **present** — `server/src/channels/{thread-status,working,stall-guard,turn-watchdog}.ts`; the thread reader is `server/src/channels/thread-routes.ts`. |
| @ 提及菜单 | **present** — `app/src/components/channels/composer/composer.tsx:134` documents *"Agents that `@` can address. Empty means the mention menu reports an empty channel."* |
| 语音 / 朗读 | **present** — `server/src/voice/{provider,sessions,session-routes,summary,config,routes}.ts`, `server/src/dictation/{provider,config,routes}.ts`, `app.ts:675 "/api/audio"` and `:684 "/api/voice"`, UI `app/src/lib/voice/`, `app/src/lib/dictation/`, `MACOS_MICROPHONE.md`. |
| 图片 / OCR | **partial** — attachments and modalities exist (`app/src/lib/channels/attachments.ts`, `app/src/components/channels/chat-messages.tsx`); no dedicated OCR path was found. |
| 头像库 | **partial** — `app/src/components/agents/abstract-avatar.tsx` and the `boring-avatars` dependency; no avatar library with upload/pick. |
| 诊断 | **present, differently placed** — the desktop telemetry files (`server/src/desktop-telemetry.ts`, `desktop/src/telemetry.ts`) and `Problem.tsx` / `problem.rs` for failures; no in-app error list like `ds-bot/src/client/diagnostics.js`. |
| **Realtime seam** | **present but a different transport** — `server/src/channels/socket.ts:11` (`createBunWebSocket`), `server/src/http-server.ts:8,27-29` (Bun takes exactly one WebSocket handler; the app proxies some sockets and terminates others). A `/api/bot/feed` SSE route is an addition, not a conflict — but the client↔server push model has to be bridged. |
| **Front-end stack** | `app/`: React 19.2 + TanStack Router 1.170 + TanStack Query 5.101 + Tailwind 4.3 + Vite 7.1, `@copilotkit/react-core` 1.83, `streamdown` for Markdown; `app/package.json`. DS-Bot's client is React too, but written with bare `createElement as h` and a 124 KB hand-written CSS string (`ds-bot/src/client/styles.js`), so **the views do not drop in** — a port is a re-implementation against CCP-Bot's design system (`app/src/components/ui/`, shadcn). |

## 6. Licence and attribution

### 6.1 What the source actually declares

| Fact | Evidence |
|---|---|
| `ds-bot` is Apache-2.0, full licence text present | `ds-bot/LICENSE` (head verified: *"Apache License / Version 2.0, January 2004 / http://www.apache.org/licenses/ / TERMS AND CONDITIONS FOR USE, REPRODUCTION AND DISTRIBUTION"*); `ds-bot/README.md:255-257` (`## License` → `[Apache-2.0](LICENSE)`) |
| SPDX field on every package | `ds-bot/package.json` `"license": "Apache-2.0"`; `app/package.json` `"license": "Apache-2.0"`; `app/engine/package.json` `"license": "Apache-2.0"` |
| **No root `LICENSE` and no root `NOTICE`** | `ls -la D:\DS-Bot-main\NOTICE LICENSE README.md` → *"cannot access 'NOTICE': No such file or directory"*, same for `LICENSE` and `README.md`; `find . -maxdepth 2 -iname "notice*" -o -maxdepth 2 -iname "license*"` (excluding `node_modules`) → only `./ds-bot/LICENSE` |
| **Nothing carries a per-file header** | `grep -rl "SPDX-License-Identifier" app ds-bot browser-plugins` → **0 files**; `grep -rl "SPDX-License-Identifier\|Copyright (c)\|Licensed under the Apache" app/src app/engine ds-bot/src ds-bot/index.js browser-plugins scripts` → no output |
| **The checkout is not a git repository** | `git status --porcelain` in `D:\DS-Bot-main` → *"fatal: not a git repository"*; `git ls-files` likewise. So no header or authorship can be recovered from history here. |
| MIT-derived code is attributed **only in prose comments**, to a file that does not exist | `app/src/host.mjs:4` *"Follows DeepSeek Harness apps/desktop-host/src/index.ts (MIT); see NOTICE."*; `app/engine/cordis.patch.yml:7` *"The rows follow @deepseek-ai/dsh-web-app's bundle patch (MIT; see NOTICE)."*; `app/README.md:157` *"Some files adapt code from DSH Desktop (MIT); see [NOTICE](../NOTICE)."* — `../NOTICE` is absent |

### 6.2 What copying costs us

Apache-2.0 §4, applied to files we copy out of `ds-bot/`:

- **(a)** Give the recipients a copy of the Licence — a top-level `LICENSE-APACHE-2.0` (or the existing `ds-bot/LICENSE` text) in the CCP-Bot repository, since the repo currently has no root licence file at all.
- **(b)** *"You must cause any modified files to carry prominent notices stating that You changed the files."* — every copied-and-edited file needs a changed-notice. That is a concrete instruction, not a formality: add a header such as `// Adapted from ds-bot/src/host/channel.js (Apache-2.0, Fei2411/DS-Bot); modified for CCP-Bot.` to each ported file.
- **(c)** Retain all copyright, patent, trademark and attribution notices from the source. Here the source has **none in the files**, so the practical obligation is to state the origin: project `Fei2411/DS-Bot` (`app/package.json` `homepage`), component `ds-bot`, version 0.2.3 (`ds-bot/package.json`), licence Apache-2.0.
- **(d)** If the source has a `NOTICE` file, reproduce its contents. This checkout has none — and DS-Bot's own comments say one should exist. **Do not invent a NOTICE on DS-Bot's behalf**; write a third-party notices file that records what we actually know, and flag the gap.

The DSH-derived portions are a second, separate obligation: `app/src/host.mjs`, `app/engine/cordis.patch.yml`, and whatever else was adapted from DSH Desktop. Those files say MIT. An MIT notice (copyright + permission text) has to accompany them too. **未验证**: which exact files are DSH-derived beyond the three that say so — the comment at `app/engine/cordis.patch.yml:8-10` implies a comparison against that DSH version's `dsh-web-app` bundle patch is needed to tell inherited rows from authored ones. Verifying this requires the DSH 0.2.1-rc.2 `dsh-web-app` tarball.

### 6.3 What a mixed MIT + Apache-2.0 repository needs

| Requirement | Why |
|---|---|
| Add the **missing root `LICENSE`** (MIT) before adding any Apache-2.0 file | `package.json:4` says `"license": "MIT"` and `README.md:36` says *"MIT，见 `LICENSE`"* and `:13` claims *"上游链接、LICENSE 与 CHANGELOG 原样保留"*, but `ls -la LICENSE` → *"cannot access 'LICENSE'"* and no root licence file exists anywhere (`find . -iname "license*" -o -iname "notice*"`, excluding `node_modules`, finds none at the root). The repo currently over-claims. |
| Add a third-party notices file (e.g. `THIRD-PARTY-NOTICES.md`) | Lists `ds-bot` (Apache-2.0, Fei2411, v0.2.3) and DSH Desktop (MIT) with what was taken and what changed |
| Keep the licences **per file or per directory**, never merged | Apache-2.0 requires its notices retained; MIT-licensed CCP-Bot code cannot be relicensed as Apache-2.0 by absorption, and vice versa. A `LICENSE` at the root plus a per-directory header on ported files is the least ambiguous arrangement |
| Do not describe ported files as MIT in `package.json` alone | The package-level `"license"` field describes the package, not files copied into it from an Apache-2.0 project |
| Keep `ds-bot/LICENSE`'s text with the copy | That is the only place the licence text exists in the DS-Bot checkout |

**One more thing worth deciding deliberately:** the two projects currently carry *different* licences for code that will sit in the same repository, and CCP-Bot's own licence file is missing. Fixing that is a prerequisite to the port, not a follow-up.

## 7. Recommended phases

Ordered "usable soon" first. Each phase names what it delivers, the work per layer, the risks, and the evidence that would let us call it done. The DSH-runtime-bound work is last and priced honestly.

### Phase 1 — The seam, on Hono (1–2 weeks)

**Delivers:** `POST /api/bot` and `GET /api/bot/feed` served by CCP-Bot, carrying `state`, `set-prefs`, `chat`, `send`, `create-bot`, `update-bot` and the `revision`/`live`/`message`/`stream` events — enough to boot DS-Bot's own client against CCP-Bot.

- **`server/**`**: a new `server/src/bot-channel/` with the envelope (`ok`/`fail`, `ds-bot/src/host/channel.js:33-34`), the error-code classifier (`:19-22`), the `READS`/read-only gate (`:98`, `:139`), the `state` snapshot (`:38-95`) and the SSE route. Storage: a single `state.json`-shaped document to start with (`ds-bot/src/host/store.js:22` is the schema). Map `bots` onto `server/src/agents/*` — one Bot is one agent, `sessionId` maps to a thread (`server/src/threads/store.ts`).
- **`app/**`**: one development route that loads `ds-bot/client.js` and installs it, mirroring `app/ui/src/main.js:3-31` and `app/ui/src/app.js`. This is a **verification harness**, not a shipping UI.
- **`desktop/src-tauri/**`**: nothing.
- **Risks**: (i) the relative `ROUTE` (`ds-bot/src/client/api.js:4`) assumes the page is served from the same origin as the API — CCP-Bot's `app/serve.ts` and Vite dev proxy must agree; (ii) the client needs DSH's client-store primitives (`ds-bot/src/client/index.js:47` injects `sessions`, `uiWorkspace`, `uiConversation`, `slots`, `theme`, `layout`) — a stub per service is the work, and `slots` is the expensive one; (iii) **the user's 用量 `请求失败 HTTP 404` reproduces this class of failure**: `ds-bot/src/client/team-actions.js:129` calls `call('usage', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })`, and the client turns a non-OK HTTP response into code `HTTP_${status}` (`ds-bot/src/client/api.js:8-42`) — i.e. the *route* `/api/bot` itself 404'd on their build, which means the plugin's host half was not mounted, not that `usage` was missing. **未验证**: the exact build; verifying requires reading the diagnostics entry (`ds-bot/src/client/diagnostics.js:16`) or `GET /api/bot/feed` returning 404 on that install.
- **Evidence to call it done**: a CCP-Bot dev route shows the roster and the 通用 settings, `set-prefs` round-trips (theme, accent, motion, layout, width, flatWidth, thinking), a message sent from the UI reaches an agent and arrives as `stream` + `message` events, and `/api/bot/feed` stays open for 5 minutes with keepalives.

### Phase 2 — The team model: roster, groups, member status (2–4 weeks)

**Delivers:** 主 Bot + Bot 列表 + 新建 Bot, 群聊 (create, list, members, modes `everyone`/`admin`, relay limit, notice, 继续), member status and stop-member-work.

- **`server/**`**: port `ds-bot/src/host/groups.js` (1,023 lines) — `defaultRelayLimit`, `mentionsIn`, `referenceNote`, `isPass`, `stripOwnName`, the transcript and the turn loop; port `roster.js:42`; keep `read_own_chat`/`read_group_chat` on `server/src/channels`' existing text search. Reuse `server/src/channels/{working,stall-guard,turn-watchdog}.ts` instead of inventing a round loop. The relay/turn engine that drives real DSH Sessions (`ctx.sessionController.prompt`, `ctx.sessions.flush`) has to become CCP-Bot's turn runner.
- **`app/**`**: React views for the team sidebar, the bot picker (新建 Bot / 新建群聊 / 添加 DSH Agent), room settings and the member dock — rebuilding `ds-bot/src/client/{sidebar,create-bot,group-settings,member-status}.js` against `app/src/components/ui/`.
- **`desktop/src-tauri/**`**: nothing.
- **Risks**: the two products disagree on scope — DS-Bot's rooms are open to every member the admin names, CCP-Bot's channels are membership-scoped (`server/src/team-bots/team-bots.ts:11-12`). Picking one semantic and documenting it is part of this phase. The turn loop is the real cost; `ROOM_REPLY_TIMEOUT_MS = 240_000` and `ROOM_STEP_GAP_MS = 30_000` (`ds-bot/src/host/constants.js`) exist because a group turn is slow and bursty.
- **Evidence**: a three-member group answers a plain message in order, admin mode routes to the admin and @mentions bring others in, `stop-member-work` stops one member without stopping the round, and a member's status shows thinking/tool/waiting while it works.

### Phase 3 — Data surfaces: memory, secrets, capabilities, schedules, connectors, usage (3–5 weeks)

**Delivers:** 记忆, 密钥, 能力, 定时任务, 用量, 反馈, 关于.

- **`server/**`**: secrets on `server/src/credentials.ts` + `vault.rs` semantics, keeping DS-Bot's *ask-in-conversation, value never leaves the host* flow (`secrets.js:419`) and lifting `redactor`/`redactDeep` verbatim (`secrets.js:38,65`). Memory: choose between DS-Bot's `MEMORY.md` + topics format (portable, human-readable, `memory.js:41` limits) and CCP-Bot's pgvector store (`server/src/memory/store.ts`) — they are different products, and mixing them will produce two memories. Schedules map onto `server/src/routines/*` directly. Usage is the cheapest win: `ds-bot/src/host/usage.js` (the `sqliteLedger` at `:134`) and `usage-data.js`'s folding/timezone bucketing are framework-agnostic, so a personal 用量 page is close to free once the ledger is fed.
- **`app/**`**: pages for each, modelled on `app/src/routes/_authed/_app/{memory,routines,capabilities.*}.tsx` rather than on DS-Bot's `bt-`-classed markup. The 用量 page is the one place DS-Bot's own charts (`usage-page.js:397`, `widget-chart.js`) are worth reusing as a design reference.
- **`desktop/src-tauri/**`**: nothing, unless the secret store is moved to `vault.rs`.
- **Risks**: two memories and two credential stores would be worse than either alone — decide before building. `memory.js` is 1,748 lines and its review/ask/forget flows are user-visible.
- **Evidence**: a Bot remembers across two conversations; a secret requested mid-conversation reaches the tool as `DSH_SECRET_<NAME>` and never appears in an API response; a routine runs on schedule and its run history is visible; the 用量 page shows hourly rows for a real session.

### Phase 4 — Browser, approvals and cards, on CCP-Bot's existing engines (4–8 weeks)

**Delivers:** 浏览器 with the permission model (free browsing/clicking/filling; publish/upload/download/delete ask first; payments always the user's), the 已允许的操作 list (Bot + website + action + 1小时/今天/7天/永久), approvals, and Bot-authored cards (forms, tables, charts).

- **`server/**`**: put DS-Bot's *capability* model on top of `server/src/browser/*` — the action taxonomy and the grant durations live in the plugin's grant handling (`ds-bot/src/host/browser-plugins.js:48` `grantAllows`, `:62` `handoffHold`) and are worth porting as policy, not as code. Cards: `ds-bot/src/shared/views.js` (685 lines) is a self-contained declarative validator and can be lifted into `server/src/components/` as an alternative to sandboxed components.
- **`app/**`**: a browser pane in React (reference: `ds-bot/src/client/browser-pane.js`, 909 lines — do not port its markup), the permission picker, the 已允许的操作 table, the approval notices, and the card renderer.
- **`desktop/src-tauri/**`**: this is the phase where the shell matters. DS-Bot's browser is a **desktop webview the user watches and can take over** (`app/src/bot-browser.mjs`, `ds-bot/src/client/index.js:251-272` bridging to `window.dsBotApp.browser`), leased per Bot with cookie imports. CCP-Bot's `desktop/src-tauri/src/local_browser.rs` and `server/src/browser/host.ts` are server-side. Making the pane *watchable* means either exposing the server-side browser's frames (`app/src/components/computer/live-screen.tsx` already does this for computers) or adding a Tauri webview lease. Decide early; it changes both sides.
- **Risks**: this is the biggest divergence between the two products, and the payment/upload safety wording is user-facing policy that must survive the port intact. If the webview route is chosen, cookie import (`app/src/cookie-parse.mjs`, 515 lines, three formats) comes with it.
- **Evidence**: a Bot browses and clicks without asking; a download asks first and the answer is remembered for the chosen duration; the 已允许的操作 list shows Bot + site + action + expiry; a card collects an answer and the answer reaches the conversation; taking over from the Bot works and giving back resumes it.

### Phase 5 — The DSH-runtime-bound pieces (multi-week each; the honest end of the roadmap)

Everything here needs a capability CCP-Bot does not have. Two routes: **(A)** run a DSH host inside CCP-Bot's local stack (CCP-Bot already supervises `bun`, `agent-bot`, `agent-computer` and the server — `desktop/src-tauri/src/stack.rs`, `supervise.rs`, `local.rs`), or **(B)** reimplement each on CCP-Bot's agent runtime. (A) buys fidelity and inherits a pinned upstream; (B) buys independence at a much higher cost.

| Piece | Needs | Cost |
|---|---|---|
| `stream` events with real token deltas, and `message` items shaped like `chat` returns | DSH's `agent/assistant-stream` and per-Session events (`ds-bot/src/host/feed.js:51-77`) | (A) small — it is the same seam; (B) needs CCP-Bot's channel stream to emit the same item shape |
| 旁路问答 (BTW) | DSH **projections** (`ds-bot/src/host/btw.js`: `projections.register`, `conversation.openTurn`, `snapshotOf`) | (A) medium; (B) large — the anchoring model has no CCP-Bot analogue |
| 侧边对话 | DSH session creation off the main thread (`ds-bot/src/host/side.js:44`) | (A) medium; (B) medium |
| Bot 互相发消息 / 交接 with `request_id` idempotency | DSH followup + `ctx.sessions.flush`; `ds-bot/src/host/requests.js` is portable and should be lifted regardless | (A) small; (B) medium |
| 成员状态 / live activity | DSH `agent/status` + per-Session events | (A) small; (B) medium — CCP-Bot has `server/src/channels/working.ts` to build on |
| @ 提及菜单 (at-menu) | DSH `inputTriggers` (`ds-bot/src/client/index.js:756-777`) | (A) small; (B) medium — CCP-Bot's composer already addresses agents (`composer.tsx:134`) |
| 经典 Agent 模式切换 | The whole DSH slot system (`ds-bot/src/client/surface.js`, `index.js:788-863`) | (A) free — it is DSH's own UI; (B) meaningless without a second shell. Recommend dropping it and offering CCP-Bot skins instead |
| Provider/model registry and 模型菜单 | DSH `llm` service + `cordis.patch.yml` provider rows (`ds-bot/src/host/providers.js:9,51`) | (A) small; (B) large — CCP-Bot's `server/src/routing/*` is its own resolver |
| 语音 / 朗读 | `@deepseek-ai/dsh-experimental-voice-input-bundle` (`ds-bot/src/client/speech.js:4`) | (A) small but experimental; (B) **skip** — CCP-Bot already has `server/src/voice/*` and `server/src/dictation/*`, which is the better product |
| 位置 / 总工作区 move, Harness 设置 | Electron shell + DSH settings UI (`app/src/move-data.mjs`, `sidebar.js:436`) | (A) medium — needs a Tauri equivalent of a staged cross-volume copy with rollback (`app/README.md:30`); (B) the same |
| 定时任务 on DSH Sessions, capability `c.skills.register` | DSH skills registry (`ds-bot/src/host/capabilities.js:305`) | (A) small; (B) medium — `server/src/admin/skills.tsx` + skills pages already exist |

**Additions this survey argues for, independent of any port** (these are gaps in CCP-Bot that DS-Bot fills and that a Phase-1-shaped effort would close cheaply):

1. **A root `LICENSE` and a third-party notices file** — currently missing, and a blocker for any copying (§6.3).
2. **A personal 用量 page** — DS-Bot's ledger and folding are framework-agnostic and CCP-Bot has no per-person usage view at all (§5).
3. **A 反馈 page with host+client diagnostics in the report** — `ds-bot/src/host/diagnostics.js:39,56,64` (`cleanText` redaction, `entryLine`, `reportMarkdown`) plus the client ring buffer are ~400 lines of pure functions, and §5 shows CCP-Bot has nothing equivalent.
4. **An application updater** — `grep -rln "updater" desktop/src-tauri/src` finds nothing; DS-Bot's update phases (`update.js`) and its `latest.yml` / release-asset contract (`app/README.md:84-90`) are a working design to copy.
5. **Request-id idempotency for agent-to-agent messages** — `ds-bot/src/host/requests.js` (141 lines) solves a problem CCP-Bot's `server/src/agents/handoff*.ts` does not appear to address: a message that was read but whose answer was lost must not be delivered twice. **未验证**: whether CCP-Bot has an equivalent under another name — checking would mean reading `server/src/agents/handoff-delivery.ts` and `handoff-runner.ts` in full.

### What I did not verify

- **未验证** the exact DSH-derived file set in `app/` beyond the three files that say so (`app/src/host.mjs:4`, `app/engine/cordis.patch.yml:7`, `app/README.md:157`). Verifying requires the DSH 0.2.1-rc.2 `dsh-web-app` bundle patch and `apps/desktop-host/src/index.ts` to diff against.
- **未验证** why the user's 用量 page returns `HTTP 404`. Phase 1 lists the hypothesis and the two checks that would settle it.
- **未验证** DS-Bot's `schedules.js` host dependency (whether it uses a DSH scheduling service or its own timer) — I read its public shape (`:16,32,43,71`) but not its body. Verifying requires reading `ds-bot/src/host/schedules.js` in full.
- **未验证** whether `D:\DS-Bot-main` was checked out without its `NOTICE`/`LICENSE`, or whether those files never existed. Verifying requires the upstream repository (`github.com/Fei2411/DS-Bot`) — `https://github.com/Fei2411/DS-Bot/blob/main/NOTICE`.
- **未验证** CCP-Bot's own licence history — the root `LICENSE` is missing from this checkout, which may mean it was never committed or was removed locally. Verifying requires `git -C D:\Project\CCP-Bot log --oneline -- LICENSE`.

*Survey conducted read-only. Nothing in `D:\DS-Bot-main` or `D:\Project\CCP-Bot` was modified except this file; no build, test, dev server, container or commit was run.*