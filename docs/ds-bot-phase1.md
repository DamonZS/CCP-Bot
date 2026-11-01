# DS-Bot Phase 1: the contract served from CCP-Bot's own data

中文摘要：这一阶段把 DS-Bot 的两条路由（`POST /api/bot` 与 `GET /api/bot/feed`）做成了 CCP-Bot 服务端的一个模块
（`server/src/bot-channel/**`），数据全部来自 CCP-Bot 自己的 store：Bot 取自 `AgentProfileStore`，对话取自
`ThreadStore`，偏好与 revision 存在 `users.preferences` 的 `dsBot` 命名空间里（本阶段不加新表）。没有实现的 endpoint
一律如实回答 `bot/not-found` 并带上 endpoint 名，不伪造任何值。`app/src/routes/_authed/ds-bot-harness.tsx` 是一个
明确标记的开发 harness：它逐字节加载 DS-Bot 自己的客户端 bundle（`app/vendor/ds-bot/client.js`）对着这两条路由跑，
证书 1/2/3 因此不只停在协议层——DS-Bot 自己的侧边栏（`sidebar.workspaces`）已经用本部署的数据渲染出来了。
三项与本机环境有关的偏差、以及 harness 哪些服务是「完整实现 / 最小实现 / 根本没有」，都在下面逐条写明。

## 1. Scope

Phase 1 is the seam, not the product: two routes, the arms the client needs to boot, and evidence. It is
not parity — the whole point is that every unimplemented endpoint answers `bot/not-found` with its own
name, so the next phase is "implement one more arm" rather than "make the port look finished".

Nothing here reads or calls CopilotKit Intelligence. The deployment it was verified on boots in
`mode: "sse"` (no `INTELLIGENCE_*` set) and serves everything from its own PostgreSQL.

## 2. The routes

`server/src/bot-channel/` — mounted at `/api/bot` in `server/src/app.ts` behind the same `requireUser`
middleware `/api/memory` and `/api/threads` use, and wired in `server/src/index.ts` from the deployment's
own stores:

| File | What it holds |
|---|---|
| `envelope.ts` | `ok`/`fail`, `bot/invalid`, and the error classifier (`bot/…` passthrough, `TypeError\|ReferenceError\|RangeError\|SyntaxError` or `/^E[A-Z_]+$/` → `bot/internal`, everything else `bot/refused`) |
| `feed.ts` | the SSE feed: `hello`/`revision`/`live`/`message`/`stream`, 20 s keepalive *intent*, 512-frame queue cap, 150 ms `live` debounce, `text/event-stream; charset=utf-8` + `no-store` |
| `document.ts` | the `dsBot` document in `users.preferences` (`{version:1, mainBotIds:[], prefs:{}, revision:N}`), read and written inside a `for update` transaction |
| `prefs.ts` | `set-prefs` validation, copied key by key from DS-Bot (`channel.js:100-137`) including delete-by-null and the exact messages |
| `state.ts` | the team snapshot: Bots, their Sessions, prefs, revision, `live()`, and the short-circuit |
| `chat.ts` | `ThreadStore.messages()` → the `{kind, text}` items the client renders |
| `send.ts` | a turn through the *same* runtime the browser uses, with the caller's cookies forwarded |
| `routes.ts` | `POST /` dispatch and `GET /feed` |

Implemented arms: `state`, `set-prefs`, `chat`, `send`, `create-bot`, `update-bot`. Everything else —
including `usage`, `rooms`, `answer-question`, `view-reply` — answers `{"ok":false,"error":{"code":"bot/not-found","message":"Unknown endpoint <name>","details":{}}}`.

## 3. Where the data comes from

- **Bots** — `AgentProfileStore`, the same store `/api/agents` manages, so a Bot made in the app is in the
  roster here. `state` maps `role`→`title`, `instructions`→`roleDescription`, `avatar`→`avatarSeed`.
- **Conversations** — `ThreadStore` (`server/src/threads/store.ts`). Each Bot's `sessionId` is its most
  recent thread; a Bot with none gets an empty conversation recorded on first look, which is DS-Bot's own
  `bootstrap()`. `chat` reads that thread's messages; `send` runs into it.
- **Preferences and revision** — `users.preferences` under the `dsBot` key, merged with `||` so CCP-Bot's
  own preference keys survive untouched (tested).
- **Authorization** — every arm narrows to the request's actor: the roster keeps only Bots the actor owns,
  that are system-owned, or that are assigned to them, and a Bot or conversation that is not theirs answers
  `bot/not-found` — **a single code for both "does not exist" and "not yours", deliberately, and never with
  data**. The integration test proves a stranger sees neither the Bot nor its messages.

## 4. Evidence

Every reading below is from the machine this was built on: PostgreSQL `ccpbot` on `127.0.0.1:5432`,
`CCPBOT_SINGLE_USER=true`, no `INTELLIGENCE_*`, Bun 1.4.3 (`%TEMP%\bun143\bun-windows-x64\bun.exe`).
The server booted on 3060 (never 3010, which belongs to the user's own install).

### 4.1 The roster and the generic settings come from this deployment

`POST /api/bot {"endpoint":"state"}` → `200`:

```json
{"ok":true,"value":{"revision":0,"workspaceId":"ccpbot:dev-local-user","mainBotIds":[],"mainBotId":null,
"bots":[{"id":"general-assistant","name":"General Assistant","role":"Everyday Work","sessionId":"ae37bdae-…"},
        {"id":"knowledge","name":"Knowledge","role":"Company Knowledge","sessionId":"f56f9351-…"},
        {"id":"agent_9f3e859b-…","name":"Desk","role":"Runs the desk","sessionId":"5744ffae-…"}],
"prefs":{},"readOnly":false, …}}
```

Those three Bots exist in `agent_profile` and their Sessions are real `threads` rows — nothing is seeded
for the harness. In the browser, DS-Bot's own client reads that same answer (its own `/api/bot` request)
and its sidebar renders inside the harness.

### 4.2 `set-prefs` round-trips and survives a reload

Request `{"endpoint":"set-prefs","payload":{"theme":"midnight","accent":"#12ab34","motion":"quiet","layout":"flat","width":70,"flatWidth":60,"thinking":true}}`
→ `{"ok":true,"value":{ …same seven keys… }}`; a following `state` reads back the same object, and the
browser reload shows them applied. Measured across two separate requests and one page load.

### 4.3 A message reaches a real agent and comes back as `stream` and `message`

`send` forwards the caller's request to `/api/copilotkit/agent/<botId>/run` in-process — same runtime, same
cookies, so `identifyActor` resolves the person who asked. Driven against an AG-UI mock agent:

```
POST /api/copilotkit/agent/agent_9f3e859b-…/run
RUN_STARTED / TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT delta "HARNESS" / TEXT_MESSAGE_END / RUN_FINISHED
```

and on the feed, in order: `stream{phase:"start"}` → `stream{text:"HARNESS"}` → `stream{phase:"end"}` →
`message{kind:"user"}` → `message{kind:"bot"}`. `ThreadStore` holds the two rows afterwards.

### 4.4 The feed stays open with keepalive

A client on `/api/bot/feed` was held for **8 minutes 8 seconds** (488,074 ms):

```
{"atMs":0,"event":"hello","data":"{\"revision\":1}"}
61 × comment frames — first at 8001 ms, last at 488074 ms
GAP_MIN=8000 GAP_MAX=8006 GAP_AVG=8001
```

Eight minutes, not DS-Bot's twenty-second cadence — see §5.1 for why, with the evidence.

### 4.5 Tests and gates

- `bun test server/tests/bot-channel.test.ts server/tests/bot-channel.integration.test.ts` → **25 pass / 0 fail / 75 expect() calls**, 2 files. The unit file covers the envelope, the classifier, framing, the debounce, the short-circuit, the validation refusals and the refusal paths; the integration file drives a real database, a real runtime and a real AG-UI mock through `state`, `set-prefs`, `chat`, `send` and a stranger's attempts.
- `bun run --cwd server typecheck` → exit 0. `bun run --cwd app typecheck` → exit 0.
- `bunx biome lint --error-on-warnings server/src server/tests` → exit 0, `Checked 782 files`, no fixes.
- `bun test app/tests` → 2131 pass / 2 fail. Both are `app/tests/build-cache.test.ts > the startup script
  invokes Vite and refreshes the manifest for a stale build`, a 5 s timeout on a test that really starts
  Vite; the same file is **13 pass / 0 fail** with the runner's own `--timeout 30000`. It reads nothing this
  change touched. Machine, not port.

## 5. Deliberate deviations from DS-Bot's own host

### 5.1 The keepalive is 8 s, not 20 s

DS-Bot's `feed.js` sends `: keepalive` every 20 s. In this deployment that connection is reset after
~10 s: `Bun.serve` closes a request that has sent nothing for 10 s (`server/src/delivery/opentag.ts:400`,
`server/src/browser/routes.ts:125-126` say so in as many words). A 20 s heartbeat can therefore never
arrive. `feed.ts` uses 8 s and says why in the comment. The frames are DS-Bot's; the cadence is this
host's.

### 5.2 `state` ships empty collections instead of omitting them

The first version omitted `rooms`, `agents`, `exchangeTurns`, `questions`, `views`, `secrets`,
`capabilities`, `models` ("absent means none"). DS-Bot's client iterates `value.bots` and `value.rooms`
without a guard (`src/client/sources.js:28-32`), so the page threw `value.rooms is not iterable`. The arm
now sends the empty shapes (`rooms: []`, `agents: []`, `capabilityStatuses: {}`, `models: []`,
`defaultModel: null`, …). Empty is not a lie: none of those exist in this phase.

### 5.3 Chat items carry no `time`

DS-Bot's cells draw a time separator when `Number.isFinite(item.time)` (epoch ms). `ThreadStore.messages()`
returns the AG-UI payload only — `thread_messages.created_at` is not in that shape — so the items have no
timestamp and the separators are missing rather than invented. Closing the gap is one line in
`server/src/threads/store.ts` (return `createdAt` with each message), which is outside this task's write
scope; it is the first thing Phase 2 should pick up.

### 5.4 `send` reports what this machine observed

The `stream`/`message` events after a turn come from the thread's own rows when the runtime wrote them, and
otherwise from the text the caller sent plus the text the agent produced. The fallback is labelled as the
machine's observation in the code; it is not presented as a transcript.

### 5.5 What has no counterpart here

`channel.js:547-552` reports `bot/internal` failures through `rt.noteFailure(...)`. This deployment has no
equivalent sink, so an internal failure is reported to the caller and not to a diagnostics row. The
`readOnly` gate (§`channel.js:139-152`) is not implemented: `state` always answers `readOnly: false`, and
the arms that would be refused under it are the ones that answer `bot/not-found` anyway.

## 6. The harness: stubbed fully, minimally, and not at all

`app/src/routes/_authed/ds-bot-harness.tsx` — a development surface, no navigation entry, explicitly not
the UI the port will ship (the route file says so at the top). It loads `app/vendor/ds-bot/client.js`
verbatim (1,146,111 bytes, sha256 `cef1e280…`, byte-identical to upstream) as a classic script, supplies
`window.__ModuleLoader__`, calls the bundle's factory with `react`, `react-dom` and a minimal
`@deepseek-ai/dsh-client-ui-primitives`, then `apply(ctx)`, and renders every registered slot entry inside
its own error boundary.

**Fully honoured — `slots`.** `register(entry, component)`, `entries(name)`, `subscribe(name, refresh)`,
`inject(name, fn)` (which calls `fn`, the composition primitive), `spec(name)`. The entries arrive with a
host directive, `inject`, which the shell calls and hands to the component as props; that is where
DS-Bot's `useRoster`/`useUi`/`useSurface` and its `actions` come from (`index.js:630`), and a store is
turned into a selector hook the way DS-Bot's own UI shell spells it (`app/ui/src/team.js:248-267`). With
only the first of those two in place the panes threw `useRoster is not a function` — the harness's bug,
not the contract's. Live result: `slot registrations: 10`, and DS-Bot's own components render — the team
sidebar (`sidebar.workspaces`), the brand (`sidebar.brand.name` → `DS Bot`), the settings trigger
(`settings.trigger` → `Settings`) and three `shell.overlay` panes.

**Minimal.** `ctx.sessions.list` is a store whose snapshot is filled from this deployment's own `state`
answer (each Bot's `sessionId`, with `ids` and `retainedBy.mainView`, which is what the sidebar walks);
`ctx.sessions.binding()` returns `undefined`, so DS-Bot's conversation replacements stay off. The other
declared services — `uiWorkspace`, `uiConversation` (a `target('chat')` store that never updates),
`theme.overrideTokens`, `layout` — are the smallest shapes that let `apply` run. `ctx.get` answers
`inputTriggers` with `{registerSource, sessionOf}` and `undefined` otherwise.

**Not provided, on purpose.** The account service behind `actions.accountT` (`index.js:19735`) and
`signInEntry`: the two `AccountLauncher` panes show `TypeError: Cannot read properties of undefined
(reading 'bind')` in their boundary, which is the honest answer — those panes are the sign-in and account
UI, and this deployment has its own. `shortcuts`, `pluginNavigation`, `workspaces`, `remote.speech`,
`sidebarRight*` are absent, so the client takes its own no-such-service paths. The client also logs
`[ds-bot] install conversation TypeError: Cannot read properties of undefined (reading 'registerSource')`
and carries on; the composer's `@` menu is a DSH input-triggers surface this host does not have.

**Not shown.** A Bot's conversation surface. It needs DSH's conversation runtime to mount; what the port
owes it — `chat` and the `stream`/`message` events — is verified over the wire and in the integration test
instead. That is why §4.3 quotes the feed rather than a screenshot.

## 7. What is not committed

The work tree holds the change uncommitted, as asked: `server/src/bot-channel/**` (new),
`server/src/app.ts` + `server/src/index.ts` (the three authorised wiring lines each),
`server/tests/bot-channel*.test.ts` (new), `app/vendor/ds-bot/client.js` (new, verbatim),
`app/src/routes/_authed/ds-bot-harness.tsx` (new), `app/src/routeTree.gen.ts` (regenerated by the router
plugin while the dev server ran), and one line in `THIRD-PARTY-NOTICES.md`.

One gate is not green for a reason that is outside this task's write scope:
`bun run lint` (`biome lint --error-on-warnings .`) reports the vendored bundle is 1.1 MiB, above the
project's 1 MiB cap. The fix is one line in `biome.json` — exclude `app/vendor/ds-bot/client.js` from
`files.includes`, or raise `files.maxSize` — and it belongs to whoever owns that file. Editing the
vendored copy instead would break its byte-for-byte identity and its Apache-2.0 provenance note.

## 8. Open questions

1. **Chat item timestamps.** Return `created_at` from `ThreadStore.messages()` (or a sibling reader) so
   the client's time separators appear. Smallest change, biggest visible difference.
2. **The conversation surface.** Whether CCP-Bot ever hosts a DSH conversation runtime, or whether the
   port grows its own chat surface that renders `chat`/`stream` itself. Phase 1 answers the wire question
   and leaves the screen one.
3. **`rooms`, `capabilities`, `secrets`, `models`.** All shipped empty. Each needs a decision: what is a
   group chat here, what is a capability, does a Bot's model come from the deployment's routing?
4. **`readOnly`.** DS-Bot's read-only host refuses writes with `bot/read-only`. Nothing in this deployment
   sets it yet; if a read-only mode ever exists, every arm needs it.
5. **The account pane.** If DS-Bot's account UI is wanted, the host has to answer `accountT` and
   `signInEntry` honestly (this deployment's own identity), or the pane stays out.
6. **Feed cadence.** 8 s is forced by `Bun.serve`'s idle timeout; if the transport ever changes, revisit.