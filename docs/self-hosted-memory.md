# 自建长期记忆 / 知识库 / 会话保持：服务端现状与改动清单

只读调查报告。目标：把 CCP-Bot 服务端「硬要求 CopilotKit Intelligence」这件事查清到可以直接动手改，
并说清去掉 Intelligence 后到底少什么、哪些代码今天已经是自建的、以及逐条改动落点。

- 调查对象：`server/`、`toolkit/`、`shared/`，外加 `.env.example`、`docker-compose.yml`、`charts/` 的共用键。
- 快照：git HEAD `76ebc2f35255f3d64e0e3258f6ff1aa487335554`（2026-10-31 23:56:05 +0800，`ci(pgvector): an asset release must not become the latest release`）。
- 方法：只读。结论一律给 `file:line` + 原文引用。没查到的写「未查到」，不猜。
- 本机快照期间 `git status` 显示别的队友正在改 `desktop/src-tauri/src/local.rs`、`desktop/src/App.tsx`、
  `desktop/src/App.test.tsx`、`docs/local-mode.md`；本文引用这些文件时基于当时工作树，可能已漂移（见 Open questions）。
- 本次调查没有跑构建、没有跑测试（任务禁止），所以「可编译性」类判断都是源码推断。

## 0. 结论速览

1. **今天没有任何「非 Intelligence 模式」**。`RuntimeCapabilities` 只有一个成员（`server/src/config.ts:30-34`），
   `loadConfig` 三个值缺一个就拒绝启动（`server/src/config.ts:1017-1021`）。
   仓库里唯一的「本机无连接」实现是**伪造**而不是取消：桌面本地模式把三个占位值塞进子进程环境
   （`desktop/src-tauri/src/local.rs:151-168`、`:1432-1448`）。
2. **断开 Intelligence 后真正会残的只有三件**：durable threads（会话历史与会话保持）、
   Intelligence 那半长期记忆、以及 Intelligence Channels / runner（渠道与 Bot 间 hop）。
   其余功能要么有本地回退（记忆表），要么与 Intelligence 无关（语音、转写、生成式 UI 开关、自托管横幅）。
3. **知识库的本地索引已经不存在了**：`chunks` / `documents` / `embedding vector(1536)` / `CREATE EXTENSION vector`
   全部在 `server/drizzle/0010_drop_the_document_index.sql:15-26` 被 drop，
   而 `server/src` 今天**没有任何 embedding 计算代码**（grep 命中全是无关的流式 chunk）。
4. **上游 SDK 自带离线模式**，这是这次改造最大的杠杆：`CopilotSseRuntime`（`mode: "sse"`、`intelligence?: undefined`）
   + `InMemoryAgentRunner`，见 `node_modules/@copilotkit/runtime/dist/v2/runtime/core/runtime.d.mts:212-233`、`:373-378`。
   代价：该 runner 重启后不保留 thread（同文件 `:225-226`），且 **Channels 在 SSE 模式下明确不可用**（`:231-232`）。
5. **长期记忆已经是「本地表为主、Intelligence 为镜像」**：`server/src/memory/store.ts:94-111` 明说没有 Intelligence 时
   「the tables are the whole store」，`mirror()` 第一步就是 `if (!intelligence) return 0`（`:209-210`）。
   去掉 Intelligence 只需不再构造那个可选依赖；只有「只存在于 Intelligence 的记忆」会变成 503（`store.ts:483-484`、`:517-519`）。
6. **前端不读 `mode` / `durableHistory`**：`app/src/lib/deployment/queries.ts:11-34` 的类型与 `:63-81` 的解析只有
   `generativeUi`/`selfHostBanner`/`localEvaluation`/`transcription`/`voice`。所以改 `mode` 对浏览器零影响（测试除外，见 §5.7）。

## 1. Q1：服务端硬要求 Intelligence 的位置

### 1.1 类型层：只有一个模式

`server/src/config.ts:30-34`：

```ts
export type RuntimeCapabilities = {
  mode: "intelligence";
  durableHistory: true;
  intelligence: IntelligenceSettings;
};
```

`server/src/config.ts:36-42` 的注释说明这份契约的形状：

```ts
/**
 * The Intelligence contract. Three values are required; see runtimeCapabilities.
 *
 * `licenseToken` is optional. Managed Intelligence derives entitlement from the project key, and
 * `@copilotkit/runtime` declares `licenseToken` optional with a `COPILOTKIT_LICENSE_TOKEN` fallback
 * of its own. A deployment that still holds one keeps passing it; nothing here requires it.
 */
```

`server/src/config.ts:43-53`：`IntelligenceSettings = { apiUrl; gatewayWsUrl; apiKey; licenseToken?; browserGatewayWsUrl? }`。
`licenseToken` 已经不是必需项——`server/src/config.ts:996-999`：「COPILOTKIT_LICENSE_TOKEN IS NO LONGER ONE OF THEM … It is still read and still forwarded when a deployment sets one, which is what a self-hosted Intelligence with its own licence needs.」

### 1.2 启动闸门：三个值必须同时给，缺一即 throw

`server/src/config.ts:988-999` 是这条闸门的设计意图：

```
 * The three addressing values are required together. A partial set is the more dangerous shape than
 * none at all: it means somebody intended to configure Intelligence and got it wrong, so failing on
 * the partial set alone (as this did) let a completely unconfigured deployment through as if that
 * were a choice.
```

`server/src/config.ts:1001-1021`（**入口行**，三个键的取值与 throw）：

```ts
function runtimeCapabilities(environment: Environment): RuntimeCapabilities {
  const settings = {
    apiUrl: url(environment, "INTELLIGENCE_API_URL"),
    gatewayWsUrl: url(environment, "INTELLIGENCE_GATEWAY_WS_URL"),
    apiKey: intelligenceApiKey(environment),
    licenseToken: optional(environment, "COPILOTKIT_LICENSE_TOKEN"),
  };

  const missing = Object.entries({
    INTELLIGENCE_API_URL: settings.apiUrl,
    INTELLIGENCE_GATEWAY_WS_URL: settings.gatewayWsUrl,
    "CPK_INTELLIGENCE_API_KEY (or INTELLIGENCE_API_KEY)": settings.apiKey,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `CopilotKit Intelligence is required and is not configured. Missing: ${missing.join(", ")}`,
    );
  }
```

`server/src/config.ts:1023-1044`：`INTELLIGENCE_BROWSER_GATEWAY_WS_URL` 是可选第二地址
（注释 :1026-1028「The server in CCP-Bot Desktop's container does: it reaches local Intelligence at `host.docker.internal`, and the window on the host reaches the same gateway at `localhost`」），
返回值固定在 `:1036-1043`：

```ts
  return {
    mode: "intelligence",
    durableHistory: true,
    intelligence: {
      ...(settings as IntelligenceSettings),
      ...(browserGatewayWsUrl ? { browserGatewayWsUrl } : {}),
    },
  };
```

key 的解析顺序在 `shared/intelligence-key.ts:1-10`：`CPK_INTELLIGENCE_API_KEY?.trim() || INTELLIGENCE_API_KEY?.trim() || undefined`
（CPK_ 优先，注释「The CLI key is authoritative after reconnecting」）。

### 1.3 三个值全缺时，启动会依次炸在哪几处

`loadConfig` 的求值顺序在 `server/src/config.ts:1395-1485`。三个 Intelligence 值全缺时，按执行顺序先炸的是别的必需项：

1. `server/src/config.ts:1420` `const deploymentKey = keyEncryptionKey(environment);`
   → `server/src/config.ts:506-507` `const value = required(environment, "KEY_ENCRYPTION_KEY");`
   → `server/src/config.ts:453-457` `required` 抛 `` `${name} must be configured` ``，即 **`KEY_ENCRYPTION_KEY must be configured`**。
   （另有 `:510-511` 的长度/编码校验与 `:518-527` 的 `.env.example` 占位键判据：production 抛错，其它环境 `console.warn`。）
2. `server/src/config.ts:1430` `databaseUrl: required(environment, "DATABASE_URL")` → **`DATABASE_URL must be configured`**。
3. `server/src/config.ts:1449` `runtime: runtimeCapabilities(environment)` → **`CopilotKit Intelligence is required and is not configured. Missing: INTELLIGENCE_API_URL, INTELLIGENCE_GATEWAY_WS_URL, CPK_INTELLIGENCE_API_KEY (or INTELLIGENCE_API_KEY)`**。
4. 还没到 `singleUser`：`server/src/config.ts:1468-1470` 的 `singleUserAllowed(...)`（注释 :1463-1467 说明
   `organizationAuthUrl` 短路且顺序 load-bearing）排在 runtime 之后；它内部会走到
   `server/src/auth/dev-actor.ts:81-83` 的 **`No identity provider is configured. Set GOOGLE_OAUTH_*, … or set CCPBOT_SINGLE_USER=true …`**。
   即「没有身份提供方也没开单用户」这条错误**排在 Intelligence 之后**，先看到的是 Intelligence 报错。

对照实验（别人已验证过，与我读到的代码一致）：`docs/local-mode.md:122`「分别是 `KEY_ENCRYPTION_KEY must be configured`（`server/src/config.ts:507`）与 `CopilotKit Intelligence is required and is not configured. Missing: …`（`config.ts:1018`）」；
`docs/local-mode.md:110` 记录把三项补进进程环境后「配置这一关就过了，随后只因库没起而报 `ERR_POSTGRES_CONNECTION_CLOSED`」。

### 1.4 `mode: "intelligence"` 被谁读、gate 住了什么

- 投影给前端：`server/src/app.ts:493-521` 的 `/api/capabilities`，`:495` `mode: config.runtime.mode`、`:496` `durableHistory: config.runtime.durableHistory`。
  `:490-492` 注释说明为什么不整对象返回：「config.runtime carries the Intelligence contract, including INTELLIGENCE_API_KEY and the licence token」。
- 运行时的构造：`server/src/copilot.ts:1869-1878`，注释即契约：

  ```ts
  const runtime = new CopilotRuntime({
    // `mode` is inferred from the presence of `intelligence`; passing it is a type error.
    //
    // identifyUser is NOT optional in practice. Threads and memory are scoped to the user it
    // returns, so omitting it puts every person in the deployment in the same thread space and one
    // person's conversations become another's.
    identifyUser,
    // The subclass, not the base: a thread nobody has run yet reads as empty rather than as a 500.
    // See IntelligenceKnowingANewThread.
    intelligence: intelligenceClient,
    licenseToken: intelligence.licenseToken,
  ```

  即**模式由「有没有传 intelligence」决定**——这正是把它变成可选的技术基础（见 §5.4 与 §6.1）。
- 头注释（`server/src/config.ts:1-5`）写明这条 gate 的哲学：
  「There is exactly one answer because CopilotKit Intelligence is required for durable threads and memory. Configuration the product cannot function without belongs at the boot boundary.」
- **改这里的「地标」已经被仓库自己标好了**：`server/src/index.ts:740-748`：

  ```
   * Built from `config.runtime.intelligence`, which is required and not optional — `RuntimeCapabilities`
   * has exactly one mode and every Intelligence field with it (`config.ts:10-22`), and `loadConfig`
   * refuses to boot without them — so there is no not-in-Intelligence-mode branch to write here. If a
   * second mode is ever added, THIS is the line that has to grow a guard, and the routine runner must
   * then be left off `createApp` entirely.
  ```

  对应代码 `server/src/index.ts:754-760`（`routineIntelligence`）、`:1761-1794`（`routineAgentRunner` + `routineRunner`）、
  `:2561`（把 `routineRunner` 传进 `createApp`）。
- 其余硬读 `config.runtime.intelligence` 的点（每一处都要按模式分叉）：
  `server/src/index.ts:314-316`（learning 探针自己的 client）、`:322-328`（`learningApiOrigin`）、`:329-331`（`learningCanCreate`，注释 :317-321 说「never the runtime key」）、`:333-351`（`learningCredentials`）、`:551`（`gatewayUrl`）、`:1333-1337`（`personalMemoryStore`，注释 :1330-1332 指到 `memory/store.ts`）、`:1840`（`mountCopilotRuntime`）、`:2465`（`duringRecording` 的 `gatewayUrl`）、`:2491-2493`（自托管横幅自己的 client）；
  `server/src/app.ts:1992-1999`（`/api/threads` 的 reader）；
  `server/src/self-host-banner.ts:1-6`、`server/src/memory/intelligence.ts:1-15`（类型取自 `@copilotkit/runtime/v2` 的 `CopilotKitIntelligence`）。

### 1.5 生成式 UI / 自托管横幅 / 单用户：与 Intelligence 无关

- `server/src/config.ts:1311-1314` `generativeUiEnabled` 读 `CCPBOT_GENERATIVE_UI`，规则 `!== "false" && !== "0"`（默认开）。
- `server/src/config.ts:1317-1320` `selfHostBannerEnabled` 读 `CCPBOT_SELF_HOST_BANNER`，同规则；
  `:1491-1496` `learningAutoAssignEnabled` 是同一套「默认开、显式 false/0 才关」的规则（另有 `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` 存在即 false）。
- `app/src/lib/deployment/queries.ts:20-33` 的注释确认 `generativeUi` / `selfHostBanner` / `localEvaluation` 三者语义，`localEvaluation` 就是服务端的 single-user。

## 2. Q2：身份 / 登录路线

### 2.1 单用户（本地）分支

`server/src/auth/dev-actor.ts:24-28`：

```ts
export const DEV_ACTOR: AuthenticatedActor = {
  id: "dev-local-user",
  email: "dev@ccpbot.local",
  role: "admin",
};
```

`:6-21` 注释说明为什么是 admin、为什么 id 固定：
「The actor is an administrator so admin surfaces can be reached too, and its id is fixed so Intelligence threads and memory stay attached to the same person across restarts.」
（注意这句把「threads/memory 挂在固定 user 上」当作目的之一——自建 threads/memory 时这条理由要重新表述。）

`:32-56` `initializeDevActorUser(database, enabled)`：enabled 时 upsert 一行 `users`（冲突时更新 email 与 `updatedAt`）。
`:86-94` `createDevRequireUser()`：中间件直接把 `DEV_ACTOR` 塞进 `context.set("actor", …)`，注释「Only ever mounted when singleUserEnabled()」。

`:58-84` `singleUserEnabled(environment, hasProvider)`：

- `:70` `if (hasProvider) return false`（**真提供方永远赢**，不允许半登录）。
- `:75-79` `CCPBOT_SINGLE_USER === "true"` 或旧名 `CCPBOT_DEV_NO_AUTH === "true"`。
- `:81-83` 两者都没有则抛：
  `No identity provider is configured. Set GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_* with BETTER_AUTH_SECRET and BETTER_AUTH_URL, or set CCPBOT_SINGLE_USER=true to run with one administrator and no sign-in. Refusing to start rather than serving a deployment where every visitor is an administrator.`

### 2.2 地址判据

`server/src/config.ts:142-151` `configuredAuthProviders(auth)`：无 auth 返回 `[]`，顺序固定 google→microsoft→okta（按钮顺序，见 `:135-141`）。

`server/src/config.ts:557-589` `singleUserAllowed(environment, hasProvider)`：
`:561` 先 `if (!singleUserEnabled(environment, hasProvider)) return false`；
`:563-574` 收集 `CCPBOT_PUBLIC_URL` / `CCPBOT_APP_URL` / `TRUSTED_ORIGINS`，凡 `reachOf(value) === "public"` 抛
`CCPBOT_SINGLE_USER admits every request as one administrator with no sign-in, so it cannot be combined with an address the public internet reaches: …`；
`:581-586` 私网地址放行但 `console.warn`；`:588` return true。
`config.ts:540-556` 注释解释为什么**不用 `NODE_ENV`** 判（Dockerfile 与 chart 都设 production，chart 自己的 `validation.yaml` 还广告这个模式，CI 的 image-boot job 就跑这个组合）。

### 2.3 `CCPBOT_SINGLE_USER=true` 到底改变了什么

只有两件事：

1. 免登录单管理员：`users` 里落一行 `DEV_ACTOR`，`requireUser` 换成 `createDevRequireUser()`（`dev-actor.ts:86-94`）。
2. `config.singleUser === true` → `/api/capabilities.localEvaluation === true`（`server/src/app.ts:521`），
   前端 onboarding 读它解释 CCP-Bot 跑在哪（`app/src/routes/_authed/onboarding.tsx:348`、`:278-293`）。

**它不改 Intelligence 的任何行为**：容器 / 云端路线走真提供方（Better Auth + OAuth），`singleUser` 为 false，
Intelligence 三项照旧必需。反过来，改成 standalone 也不要求单用户——两者是正交的。

### 2.4 转写 / 语音：已经是自托管形状（与本议题无关，但别顺手改）

- 转写 `server/src/dictation/config.ts:3-45` 只读 `TRANSCRIPTION_PROVIDER` / `TRANSCRIPTION_BASE_URL` / `TRANSCRIPTION_MODEL` / `TRANSCRIPTION_API_KEY`；
  `:15` 全空返回 undefined，`:19` 缺 baseUrl 或 model 抛错。请求在 `server/src/dictation/provider.ts:24-28`
  （`${config.baseUrl}/audio/transcriptions` + `authorization: Bearer ${config.apiKey}`）。
- 语音 `server/src/voice/config.ts:4-26` 只读 `VOICE_PROVIDER` / `VOICE_MODEL` / `VOICE_API_KEY`；
  请求在 `server/src/voice/provider.ts:140`、`:252`。`server/src/voice/summary.ts:69-83` 另有
  anthropic(`x-api-key`)/openai(`Bearer`) 分支。
- `/api/capabilities` 只暴露布尔（`server/src/app.ts:522-523`）。

## 3. Q3：没有 Intelligence 时具体少什么（对得上四条真机日志）

真机四条日志在 `docs/install-verified.md:973-976`，原样：

```
{"type":"intelligence-entitlement-unreadable","reason":"Runtime entitlement request failed"}
{"type":"self-host-banner-entitlement-unavailable","reason":"Runtime entitlement request failed"}
{"type":"model-check-unreadable","provider":"openai","model":"gpt-5.6-terra","reason":"The operation timed out.","fix":"Could not ask openai whether gpt-5.6-terra is available. This is often temporary."}
{"type":"intelligence-memory-unavailable","reason":"PlatformRequestError","timestamp":"2026-10-31T14:01:33.020Z"}
```

`docs/install-verified.md:1064` 说明这台的 Intelligence URL 指向 `127.0.0.1:9`（discard 端口），
`/api/capabilities` 却仍报 `mode=intelligence` / `durableHistory=true`——**能力投影说的是「有这个模式」，不是「这个模式可用」**。

### 3.1 `intelligence-entitlement-unreadable`

- 产生点：`server/src/intelligence-entitlement-check.ts:72-88`，catch 里 `:81-86` 打
  `{ type: "intelligence-entitlement-unreadable", reason: error.message }`。
- `:71` 注释：「Ask once and log what was found. Resolves either way and never throws.」
- 启动调用点：`server/src/index.ts:2495-2499`（`void reportIntelligenceEntitlement({ entitlements: () => selfHostBannerIntelligence.getRuntimeEntitlements() })`）。
- **它不阻断启动、不改变任何行为**，就是一行日志。`:3-14` 的注释才是重点：
  自托管但无 licence 时每个 entitlement 读回 `RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED`，
  而被 gate 的功能（memory 第一）**静默**被拒：「conversations still run, nothing fails loudly, and nothing in CCP-Bot's own log says why recall is empty」。
- 去 Intelligence 后的处理：别建 client、别报（见 §5.3）。

### 3.2 `self-host-banner-entitlement-unavailable`

- 产生点：`server/src/self-host-banner.ts:89-117` `refresh()`，失败时 `:99-111` 打
  `{ type: "self-host-banner-entitlement-unavailable", reason }` 并把答案设成 `{ shown: true, expiresAt: now() + failureTtlMs }`。
- `:119-135` `shown()`：`:121` `if (!options.enabled) return false` —— `CCPBOT_SELF_HOST_BANNER=false` 时**根本不问** Intelligence；
  `:127-134` 是冷启动竞速（`COLD_WAIT_MS = 1_000`，`:59`），超时先显示。
- 付费判据 `:31-39` `paysForIntelligence(response)`：非 ready / 非 active 或 `planCode` 不在
  `PAID_PLAN_CODES`（`:15-20` = pro / team / team_self_hosted / enterprise）都判 false ⇒ 显示横幅；
  `source === "awsMarketplaceDeploymentLicense"` 直接 true。常量 `ANSWER_TTL_MS = 10 * 60_000`（`:51`）、`FAILURE_TTL_MS = 60_000`（`:53`）。
- **用户可见后果**：一条可关闭的自托管横幅，功能不受影响。

### 3.3 `model-check-unreadable`

- 产生点：`server/src/model-availability-check.ts:92-139` `reportModelAvailability(...)`：
  `:120-123` 请求带 `AbortSignal.timeout(options.timeoutMs ?? 5_000)`；`:125-136` catch 给
  `type: "model-check-unreadable"` + `reason: error.message` + fix 文案
  `Could not ask ${provider} whether ${model} is available. This is often temporary.`。
  HTTP 分支在 `:79-88`（其它非 2xx/404/401/403）。
- **这条与 Intelligence 完全无关**：它只问模型商自己的 endpoint（`:35-40` = `/v1/models/{model}`），
  设了 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 就 `{kind:"skipped"}`（`:106-110`），没 key 也 skipped（`:115`）。
  `:12-13` 注释：「No key configured yet is also left alone: an administrator may still be about to add one.」「Never blocks start-up and never throws.」
- 真机那条是**占位模型 key + 5s 超时**造成的（`docs/install-verified.md:1196` 记录凭据是 `sk-verify-…-placeholder`）。
- 去 Intelligence 后**这条照旧可能出现**，不要把它算进本次改动。

### 3.4 `intelligence-memory-unavailable`

- 产生点：`server/src/memory/intelligence.ts:100-112` `hold(reason)` → 首次打
  `{ type: "intelligence-memory-unavailable", reason, timestamp }`；`:114-133` `available()` 里
  `entitled = status === "ready" && entitlement.active && entitlement.features.memory === true`
  （`:36` AVAILABLE_TTL 10min / `:38` FAILURE_TTL 60s），catch 时 `hold(error.name)`——真机的 `PlatformRequestError` 就是 `error.name`。
- `:135-159` `guarded(operation, call)`：`if (!(await available())) return undefined`；401/403 落 `hold()`，其它打 `{type:"intelligence-memory-error", …}` 后 rethrow。
- `:178-260` list / recall / create / supersede / remove **全部** catch 后返回 `undefined`（「gone」/404 特判）。
  `:75-84` 注释：Memory 是 licensed Intelligence 功能，CCP-Bot 必须能不带它工作，宁可返回 undefined 也不抛。
- **用户可见后果**：走 `server/src/memory/store.ts` 的本地表；只有「只存在于 Intelligence 的记忆」在编辑/删除时返回 503
  （`store.ts:483-484`、`:517-519` → `memory/routes.ts` 映射 `MemoryUnavailableError` → 503）。
- 记住 `store.ts:94-111` 的头注释（本议题的核心事实）：
  「A person's memory: CopilotKit Intelligence when this deployment is entitled to it, CCP-Bot's own tables when it is not. …
  Without Intelligence memory, nothing here calls the platform, and the store behaves exactly as it did before: the tables are the whole store.」

### 3.5 真正会残的三件（不是日志，是功能）

1. **会话历史 / 会话保持**：对话在 Intelligence 的 threads 里，本地没有对话表（证据见 §4.4）。
2. **Intelligence Channels / runner**：上游明确「Intelligence Channels require the Intelligence runtime; not available in SSE mode」
   （`node_modules/@copilotkit/runtime/dist/v2/runtime/core/runtime.d.mts:231-232`）；CCP-Bot 侧的渠道画布、Bot 间 hop
   （`server/src/agents/handoff-wiring.ts:85-86`、`:129`）都走 runner。
3. **Learning / Skills 容器**：`server/src/index.ts:314-367`、`server/src/learning/ensure-container.ts:41`（`MANAGED_API`），
   无 Intelligence 时应当整体关闭而不是每个请求失败。

## 4. Q4：现有库表、路由、检索、embedding

### 4.1 知识库（chunks / documents / vector）——**已被删除**

`server/drizzle/0010_drop_the_document_index.sql:15-26`：

```sql
DROP TABLE "chunks";
DROP TABLE "document_acls";
DROP TABLE "documents";
DROP TYPE "public"."acl_effect";
DROP EXTENSION IF EXISTS "vector";
```

同文件 `:1-14` 的说明（读一次就够，别去复活它）：

```
 * THIS DESTROYS DATA AND CANNOT BE ROLLED BACK. …
 * There is nothing to migrate them to: the replacement is not another table, it is asking the vendor at
 * the moment of the question, so there is no shape for this content to move into. Take a dump first if
 * the corpus is worth anything to you.
```

`:9-10` 还说明「Nothing has read or written these since the document connector and the worker's sync persistence were removed, so no running deployment loses a working feature.」；
`:19-25` 说明 `vector` 扩展**只为 `chunks.embedding` 存在**，`RESTRICT` 是有意的（自己加过 vector 列的部署会在迁移时失败而不是静默丢列）。

历史形状（题目里那两行）：`server/drizzle/0000_schema.sql:10` `CREATE EXTENSION IF NOT EXISTS vector;`、
`:85-92` 的 `chunks`（`position integer NOT NULL`、`content text NOT NULL`、`"embedding" vector(1536) NOT NULL`）。
=> **自建知识库的 pgvector 迁移需要从零写**（`CREATE EXTENSION` + 新 embedding 列 + 距离索引），没有可复用的现成迁移。

### 4.2 记忆表（今天真正在用的）

- `server/drizzle/0048_coworker_parity.sql:89-103` `memory_sources`；
  `:105-118` `personal_memories`（`content` / `provenance` / `enabled` / `review_state` / `deleted_at` …）。
- `server/drizzle/0054_memory_on_intelligence.sql:1-3` 给 `personal_memories` 加了
  `intelligence_memory_id` / `intelligence_digest` 两列与 btree 索引——**镜像形状的物证**。
- Drizzle 定义：`server/src/db/schema/memory.ts:14-48`（`memorySources`）、`:49-121`（`personalMemories`）。
  `:85-90` 注释写清了分工：
  「Intelligence holds the content and does the recall; this row keeps what Intelligence has no field for (provenance, review, who formed it, which source and Bot may see it). Null while it is local only.」
  `:115-119` 有「一人一 content 只存一行（`formed_by = 'bot'` 部分唯一索引）」的并发保证。
- **写**：`server/src/memory/store.ts`（`create`/`formMemory`/`update`/`remove`）+ `server/src/memory/ingestion.ts:180-451`
  （sources 的 sync，读的是连接器/插件，`:256-292` `sync`、`:362-375` `syncDue`）。
- **读**：`store.ts:346-362` `list()`、`:286-343` `eligibleRows()`（Bot 只能回忆自己形成的 + 来源可用的 + 本人的；limit 40）、
  `:378-410` 附近的 `recall`/`contextFor`（`ingestion.ts` 侧）、给模型用的工具在 `server/src/memory/tools.ts`。
- **路由**：`server/src/app.ts:1722-1730` 只在 `coworker?.memory` 存在时挂 `/api/memory`
  （`createMemoryRoutes(store, ingestion, requireUser)`）；`server/src/memory/routes.ts:19` 统一 `requireUser` + `bodyLimit({maxSize:16_384})`，
  `:20-41` 错误映射（404 / 400 / 503）。前端调用方 `app/src/lib/memory.ts:47-105`。
  => **记忆路由不依赖 Intelligence**，与 `store.ts` 的注释一致。

### 4.3 会话 / 身份表

- `server/drizzle/0000_schema.sql:161-171` `sessions`（`id text PK`、`user_id`、`token UNIQUE`、`expires_at`、`ip_address`、`user_agent`）
  = Better Auth 的登录会话，**不是对话历史**；`:183-188` `user_roles`；`:190-200` `users`；`:202-209` `verifications`。
- `server/drizzle/0000_schema.sql:152-159` `intelligence_channel_mappings`（`user_id`、`channel_id`、`thread_id`，PK(user_id, channel_id)）：
  本地表，但语义是「渠道 ↔ Intelligence thread id」的指针。
  读写方（本节 grep 全量）：`server/src/activity/activity.ts:110-114`、`server/src/approvals/resume-sweep.ts:129-134`、
  `server/src/channels/attachments.ts:101-103`、`server/src/agents/handoff-wiring.ts:104-106`、
  `server/src/channels/group.ts:42`/`:359-385`、`server/src/channels/routes.ts:329`/`:487-503`/`:593-615`/`:924-928`/`:941-945`/`:955-973`、
  `server/src/channels/summary.ts:224-231`、`server/src/index.ts:656-669`、`server/src/passwords/resume.ts:112-117`；
  schema 在 `server/src/db/schema/core.ts:490`。
- `server/src/channels/group.ts:8` 注释：「What the people in the channel read is `group_messages`: the shared transcript, one row per person…」；
  `:398` 注释：「group thread is in `group_bot_threads` rather than `intelligence_channel_mappings`」。
  => **群渠道的转录是本地落库的**，这是现成可参考的「本地会话」形状。
  schema：`server/src/db/schema/group.ts:37-66`（`group_messages`：channel 索引 + status check）。

### 4.4 对话历史今天存在哪（结论：Intelligence，不在本地）

- 读取实现：`server/src/copilot.ts:1943-1961` `history()` → `intelligenceClient.getThreadMessages({ threadId, userId })`，
  失败时 `historyOrEmpty` 给 `{ messages: [] }`。
- 线程状态：`server/src/channels/thread-routes.ts:28-31` 的 `ThreadReader`（`"known" | "unknown"`），
  `:60-93` `GET /:threadId` 只在 `readThread` 存在时注册（`:47-49` 注释：「a route that cannot possibly succeed should not exist」），
  `:56-58` `POST /mint` 只用 `identity.mint()`（本地生成 id，**不需要 reader**）；
  实现 `server/src/channels/thread-status.ts:23-37`（成功 → known，`error?.status === 404` → unknown，其余 rethrow）。
  挂载 `server/src/app.ts:1986-2002`，`:1997-1999` 就是 `createThreadReader(createIntelligenceClient(config.runtime.intelligence))`。
- `server/src/index.ts:740-752` 注释说明 headless 走的是**另一套**（`routineIntelligence` + `IntelligenceAgentRunner`），
  因为 `mountCopilotRuntime` 不把内部的 client / runner 交出来。
- => **自建「会话保持」= 新表 + 新 runner**，没有可复用的本地对话表（除群渠道的 `group_messages`）。

### 4.5 embedding 今天是谁算的？——**没人算**

对 `server/src` 全量 grep `embedding|embeddings|vector\(|pgvector|chunks`，只有 9 处命中，全是无关的流式 stream chunk：
`server/src/audit.ts:111`、`server/src/channels/stall-guard.ts:18`/`:215`/`:245`、
`server/src/channels/turn-watchdog.ts:70`/`:89`/`:135`/`:156`/`:220`。

=> **没有任何 embedding 计算代码，没有向模型商发 embedding 请求的行，没有 pgvector 用法**。
历史写入方随 `0010` 一起没了（`0010:9-10`）；知识库改成「提问时问 vendor」（`0010:5-7`）。
自建方案需要新增：配置键（可对照 §2.4 的 voice/transcription 形状）+ 请求代码 + 存储列 + 索引 + 回填任务。

### 4.6 检索逻辑现状（自建时要替换的那一段）

`server/src/memory/store.ts:318-342` 的 `eligibleRows` 是纯 SQL：owner / enabled / 未删 / 形成者过滤，
`:328-330` 的「检索」是子串匹配：

```ts
narrow.term
  ? sql`strpos(lower(${personalMemories.content}), lower(${narrow.term})) > 0`
  : undefined,
```

`.orderBy(desc(personalMemories.updatedAt)).limit(40)`（`:341-342`）。
=> pgvector 改造的落点就是这一段：**保留过滤条件与 limit，把 term 分支换成向量距离排序**；表结构、去重、provenance 都不用动。

## 5. Q5：让 Intelligence 变可选——逐条改动清单

形状选择先说结论：**建议 mode 名沿用上游的 `"sse"`**，因为 SDK 自己的 `RuntimeMode` 只有两个成员
（`node_modules/@copilotkit/shared/dist/utils/types.d.mts:18-20`：

```ts
type RuntimeMode = "sse" | "intelligence";
declare const RUNTIME_MODE_SSE: "sse";
declare const RUNTIME_MODE_INTELLIGENCE: "intelligence";
```

），且 `CopilotRuntime` 的构造签名把「有没有 `intelligence`」当作模式判据
（`copilot.ts:1870` 注释 + `runtime.d.mts:212-233` `CopilotSseRuntimeOptions.intelligence?: undefined`）。
本仓库自己的类型里再用 `"standalone"` 会多出一次翻译。若坚持用 `"standalone"`，那么 `server/src/app.ts:495`
投影给前端的 `mode` 字段会与 SDK 的 `RuntimeMode` 不同名（前端不读它，影响仅限测试与日志）。

### 5.1 `server/src/config.ts`：把必需改可选（唯一的 gate）

- `:30-34` `RuntimeCapabilities` 改判别联合：
  `{ mode: "sse"; durableHistory: false } | { mode: "intelligence"; durableHistory: true; intelligence: IntelligenceSettings }`。
- `:1001-1021` `runtimeCapabilities`：**保留**「部分配置 = 报错」这条
  （`:991-994` 的「A partial set is the more dangerous shape than none at all」）；只在**三者全缺**时返回无 Intelligence 的形状。
  为了不把「忘了配」静默降级成「本机模式」，建议加一个显式开关（例如 `CCPBOT_INTELLIGENCE=off` 或复用
  `CPKBOT_SELF_HOSTED`），让「全缺 + 无开关」仍旧报同一条错。
- `LicenseToken` / `browserGatewayWsUrl` 的行为不变（`:996-999`、`:1023-1034`）。
- `:1449` 只是调用点，返回值形状变化自动传导。

### 5.2 启动期每一处 `config.runtime.intelligence` 都要 guard

| 位置 | 现状 | 无 Intelligence 时 |
| --- | --- | --- |
| `server/src/index.ts:754-760` `routineIntelligence` | 无条件建 | 不建（注释 `:747-748` 已指明「the routine runner must then be left off `createApp` entirely」） |
| `server/src/index.ts:1761-1764` `routineAgentRunner` | `IntelligenceAgentRunner` | 不建 |
| `server/src/index.ts:1766-1794` + `:2561` `routineRunner` → `createApp` | 无条件传 | 不传（routines 的 headless turn 在 standalone 下没有 runner；`toolkit/src/run-turn.ts:541-577` 的 `createTurnRunner` 需要一个 `intelligence` + 一个 `runner`） |
| `server/src/index.ts:314-367` learning 探测 / 凭据 / auto-assign | 无条件 | 整体关闭（`learningProbeIntelligence`、`learningApiOrigin`、`learningCanCreate`、`learningCredentials`、`learningAutoAssign`） |
| `server/src/index.ts:1333-1337` `personalMemoryStore` | `createMemoryStore(database, { intelligence: createIntelligenceMemory(...) })` | 只 `createMemoryStore(database)`；`store.ts:210`、`:216` 已经是 `if (!intelligence) return 0` |
| `server/src/index.ts:2465` `duringRecording.gatewayUrl` | 读 `gatewayWsUrl` | 需要本地化（或该策略下的录制功能关闭） |
| `server/src/index.ts:2491-2493` + `:2497-2499` 自托管横幅 client + entitlement 报告 | 无条件 | 不建、不报（否则就是 §3.1 那行日志） |
| `server/src/app.ts:1992-1999` `/api/threads` reader | 无条件传 | 不传（`thread-routes.ts:52` 本来就是 optional，`:60-93` 会自动不注册 GET） |

### 5.3 运行时构造：`server/src/copilot.ts` 按模式分叉（最大的一块）

- `:1784` `const { intelligence } = config.runtime;` → 改成 `const intelligence = config.runtime.mode === "intelligence" ? config.runtime.intelligence : undefined;`
- `:1830-1859` `intelligenceClient`：只有 intelligence 模式才构造。
- `:1869-1878` `new CopilotRuntime({...})`：standalone 下**不要传 `intelligence`**（上游靠这个判 `mode: "sse"`），
  并显式给 `runner`（默认 `InMemoryAgentRunner`，见 `runtime.d.mts:212-214` 与其 `runner/in-memory.d.mts:336`）。
  `.d.mts:225-226` 的原文警告必须读：「InMemoryAgentRunner keeps no Threads across a restart」——**这就是「会话保持」必须自建的理由**。
- `:1927-1930` `runnerConnection()` 与 `:1931-1935` `threadLock`：只对 Intelligence 模式下有意义；
  消费者是 `server/src/agents/handoff-wiring.ts:85-86`（`history` / `lock`）与 `:129`（`runnerConnection`），
  standalone 下要么换成新 runner 的连接凭据，要么让 hop 直接不可用。
- `:1943-1961` `history()`：standalone 下改成读本地新表（同一返回形状 `{ messages: [] }` 已在 `:1952-1959` 用过，可复用 `historyOrEmpty`）。
- `:1902-1903` `generativeUi` / `:1886-1901` 注释：与 Intelligence 无关，不动。

### 5.4 上游约束（改了才会踩到的）

`node_modules/@copilotkit/runtime/dist/v2/runtime/core/runtime.d.mts`：

- `:212-233` `CopilotSseRuntimeOptions`：`runner?: AgentRunner`、`identifyUser?`、`intelligence?: undefined`、
  `generateThreadNames?: undefined`、**`channels?: undefined`**（注释 `:231`「Intelligence Channels require the Intelligence runtime; not available in SSE mode」）。
- `:234-236` `CopilotIntelligenceRuntimeBaseOptions`：`intelligence: CopilotKitIntelligence`（必需）。
- `:272` `type CopilotRuntimeOptions = CopilotSseRuntimeOptions | CopilotIntelligenceRuntimeOptions;`
- `:373-378` `CopilotSseRuntime`（`mode: "sse"`）、`:379-393` `CopilotIntelligenceRuntime`（`mode: "intelligence"`）。
- `runner/` 目录下 1.83.0 **只导出** `IntelligenceAgentRunner`、`InMemoryAgentRunner`、`AgentRunner` 基类与
  `LocalThreadEndpointRunner`；`runtime.d.mts:219-227` 提到的 `SqliteAgentRunner` 在这份安装里**只有注释，没有实现**。
  => 「本机 PostgreSQL 会话保持」需要**自己实现一个 `AgentRunner`**（或把转录落到自己的表 + 用内存 runner 并接受重启丢线程）。

### 5.5 不能简单删 / 不能顺手改的地方

- **会写 `.env` 的共用路径**（改动会让向导与容器路线误判「已连接」）：
  `scripts/setup-learning.ts:207` `upsert(current, "INTELLIGENCE_API_URL", apiUrl)`（真的写文件）；
  `desktop/src-tauri/src/env.rs:619`（键清单）、`desktop/src-tauri/src/main.rs:1406`/`:3570`/`:5015`；
  `desktop/src/App.tsx:68`/`:267`/`:377`/`:397`/`:557-558`（向导预填/回填）。
  桌面本地模式对这件事已经给过答案：`desktop/src-tauri/src/local.rs:1427-1431` 注释解释为什么占位值**放环境变量而不写 `.env`**
  （「a placeholder key written there would say this deployment is connected — to the wizard, and to the container route」）。
- **容器 / Helm 要保留可连云语义**：`.env.example:125` `INTELLIGENCE_API_URL=https://api.intelligence.copilotkit.ai`；
  `docker-compose.yml:134` `INTELLIGENCE_API_URL: ${INTELLIGENCE_CONTAINER_API_URL:-${INTELLIGENCE_API_URL:-}}`；
  `charts/ccpbot/templates/_helpers.tpl:412`；`charts/ccpbot/templates/learning/setup-job.yaml:76`。
  => 只放宽 `config.ts`，不要去动这些文件的语义。
- `server/src/self-host-banner.ts`、`server/src/intelligence-entitlement-check.ts`、`server/src/model-availability-check.ts`、
  `server/src/memory/intelligence.ts`、`server/src/intelligence-client.ts` **都不能删**：云端路线仍要用，
  只需在 standalone 下不被构造 / 不发请求（见 §5.2、§5.3）。
- `server/src/learning/ensure-container.ts:41` `MANAGED_API = "https://api.intelligence.copilotkit.ai";` 是托管默认值，保留。
- 桌面那份 `LOCAL_INTELLIGENCE`（`desktop/src-tauri/src/local.rs:151-168`）属于 bot-deps 的文件范围；
  一旦 `config.ts` 真的允许 standalone，它从「必需的填充」降级为「兼容云端配置的过渡」，**不要在本任务里改它**。

### 5.6 测试面（谁会被改红）

改 `RuntimeCapabilities` 会直接打破这些断言（都在 `server/tests/`）：

- `config.test.ts:88-89`（`mode: "intelligence"` / `durableHistory: true`）、`:108`/`:125`（缺键参数化报错）、
  `:135`（`CPK_INTELLIGENCE_API_KEY (or INTELLIGENCE_API_KEY)` 消息形状）、`:210`
  （`toThrow("CopilotKit Intelligence is required and is not configured")`）；`baseEnvironment` 在 `:16`。
- `smoke/journey.test.ts:106-110`（`capabilities.mode === "intelligence"`、`durableHistory === true`）。
- `health.test.ts:43-44`/`:75`；`tests/support/environment.ts:23`；`learning-config.test.ts:7-8`；
  `recorder-*.test.ts`（`recorder-config.test.ts:8-9`、`recorder-single-user.integration.test.ts:25`、
  `recorder-capture-pass.integration.test.ts:55-59`、`recorder-organization.integration.test.ts:70`、
  `recorder-scope.integration.test.ts:281`）；
  `browser-routes.integration.test.ts:473-484`、`bot-browser-routes.integration.test.ts:456`、`browser-real.integration.test.ts:271`；
  `production-loader-boundary.test.ts:30`；`config-github-app.test.ts:12`；
  `intelligence-entitlement-check.test.ts:126`、`model-availability-check.test.ts:64`/`:168`；
  `memory.test.ts:9`/`:147`。
- 建议：新增 standalone 用例而不是改这些既有用例的期望值（既有用例测的正是「云端路线仍必须报错」）。

### 5.7 前端影响：零

`app/src/lib/deployment/queries.ts:11-34` 的类型和 `:63-81` 的解析都不含 `mode` / `durableHistory`；
`app/src/lib/copilot/provider.tsx:28` 注释只说浏览器拿不到服务端 secret。
=> 改 `mode` 不需要动前端。剩余前端影响只有「记忆里 `intelligence:` 前缀条目的文案」（见 Open questions）。

## 6. Q6：可复用资产

1. **上游离线模式**（本次最大的复用）：`CopilotSseRuntime` + `InMemoryAgentRunner` 已经是上游支持的一等模式
   （`runtime.d.mts:212-233`、`:373-378`、`runner/in-memory.d.mts:336`）。CCP-Bot 需要改的是「允许走到这个分支」，
   而不是从零实现一个 runtime；缺的只有「重启后仍在」的 runner（自建 `AgentRunner` 或落表）。
2. **记忆表**：`personal_memories` + `memory_sources`（`server/src/db/schema/memory.ts:14-121`）已经是本地主存储，
   含 provenance / review / 形成者 / 来源可见性 / Bot 形成去重唯一索引；`store.ts:209-210` 天生无 Intelligence 也能跑。
3. **记忆路由与工具**：`server/src/memory/routes.ts`（10 条路由，`:19` 统一鉴权）、`server/src/memory/tools.ts`
   （给 Bot 的记忆工具）、`server/src/memory/ingestion.ts:180-451`（sources 同步 + 连接器鉴权）——全部与 Intelligence 解耦。
4. **检索代码替换点单点化**：`store.ts:318-342` 的 `eligibleRows` 是唯一检索 SQL，改 `:328-330` 那一个分支即可接 pgvector；
   `:341-342` 的 `orderBy/limit` 与全部过滤条件保持不变。
5. **pgvector**：迁移要从零写（`0010:19-25` 已把扩展 drop 了），但历史先例可直接照抄形状：`0000_schema.sql:10` 的
   `CREATE EXTENSION` 与 `:90` 的 `vector(1536)`；维度选择与 embedding 模型挂钩（见 Open questions）。
6. **embedding / 模型商的现成配置形状**：`server/src/dictation/config.ts:3-45` 与 `server/src/voice/config.ts:4-26`
   就是「自带 baseUrl + apiKey + model + 可选」的写法，新增 `MEMORY_EMBEDDING_*` 时照这个形状写，别自创。
7. **本地会话的可参考形状**：`group_messages` / `group_bot_threads`（`server/src/db/schema/group.ts:37-66`、
   `server/src/channels/group.ts:8`、`:398`）+ `intelligence_channel_mappings`（`0000_schema.sql:152-159`）
   说明「转录 + 渠道↔线程映射」这种两表结构在本仓库已经有过一次实现。
8. **`/api/capabilities` 这个投影位**：`server/src/app.ts:493-521` 已经是「只放前端可看的字段」的地方，
   要把 `durableHistory` / 新模式告诉前端，改这里一处即可（`app/src/lib/deployment/queries.ts:57-81` 加字段）。
9. **现成的开关惯例**：`server/src/config.ts:1512-1516` `switchedOn`（「On unless the variable is `false` or `0`, the rule every
   default-on switch here follows」）——新模式的开关键是照这个写。
10. **本地模式的经验记录**：`docs/local-mode.md:110`、`:122`（占位方案的代价与对照实验）、
   `desktop/src-tauri/src/local.rs:153-158`（为什么占位值不能写进 `.env`）。这是仓库里唯一跑通过的「无 Intelligence 启动」路径。

## 7. Open questions

1. **mode 命名**：`"sse"`（与 SDK 的 `RuntimeMode` 一致，推荐）还是 `"standalone"`（与本仓库业务语言一致）？
   若选后者，`/api/capabilities.mode` 的取值就与上游不同名，需要一次显式翻译。
2. **standalone 是否需要显式开关**？我倾向要（否则「忘配 Intelligence」会被静默降级成本机模式，
   与 `config.ts:991-994` 的既有立场相反）。具体键名（`CCPBOT_INTELLIGENCE=off` / `CCPBOT_STANDALONE=true`）未定。
3. **会话保持用哪种 runner**：上游 1.83.0 只有内存 runner（重启丢 thread）。
   自建 PostgreSQL `AgentRunner` 还是「内存 runner + 自己落转录表 + 自己答 thread 状态」？
   两者工作量差别大，需要先定「重启后历史必须还在」是不是硬要求。
4. **`/api/threads` 的 GET 在 standalone 下怎么办**：`thread-routes.ts:60-93` 的设计是「没有 reader 就不注册」，
   浏览器就失去了「我记着的 thread 还在吗」这一问（`:61-68` 注释解释了它在 Intelligence 下的价值）。
   本地实现要给出等价答案（查自己的表）。未查到前端是否有兜底分支。
5. **Intelligence-only 记忆（`intelligence:` 前缀 id）在 standalone 下的用户体验**：
   `store.ts:469-484`、`:517-519` 会返回 503/404。前端文案与空态我没查
   （`app/src/lib/memory.ts` 与相关组件未逐行读），需要 UI 侧确认「这类条目应当隐藏还是显示为不可用」。
6. **embedding 的提供方与维度**：今天完全没有代码（§4.5），所以没有既有约定。
   用什么模型、维度多少、是否随 provider 走（`OPENAI_BASE_URL` 那一套）都要定；
   `0010` 的历史维度是 1536（`0000_schema.sql:90`），但那只是当时的 OpenAI 默认值。
7. **渠道（Channels）在 standalone 下的命运**：上游明确 `channels?: undefined`（§5.4），
   `server/src/channels/**` 的渠道画布依赖 runner 的部分需要逐个确认（本次只查了写读映射与 group 转录，未逐文件确认每个 run 入口）。
8. **本机在没有 Intelligence 时的启动路径未被实测**：任务禁跑构建/测试，本文所有「能起来」的判断均是源码推断；
   `docs/local-mode.md:110` 那次对照实验是别人在补了 LOCAL_INTELLIGENCE 的前提下跑的，不能直接当作 standalone 的验证。
9. **队友并发改动**：撰写时 `desktop/src-tauri/src/local.rs`、`desktop/src/App.tsx`、`desktop/src/App.test.tsx`、
   `docs/local-mode.md` 处于 modified 状态（bot-deps / zero-config 的工作），本文对这四个文件的引用可能已过时。