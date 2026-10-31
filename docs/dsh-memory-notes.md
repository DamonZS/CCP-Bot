# DSH 记忆插件拆解 → CCP-Bot 落地设计

调研对象：本机已安装的 DSH 记忆插件 `@yolk_vat-y/dsh-project-memory@0.6.3`（唯一作者实现，MIT）。
目的：把「它今天怎么做」按可核实证据写清，再把能抄的部分落到 CCP-Bot 自己的 PostgreSQL + pgvector 上。

阅读约定：

- 上半「它今天怎么做」的每条结论都带确切路径与字段名；引文若不是原文会标注「（转述）」。查不到的写 **未查到**，不猜。
- 下半「CCP-Bot 该怎么抄」全部标注 **proposed**，是设计提案，不是现状描述。
- 与 `docs/self-hosted-memory.md`（服务端 Intelligence 硬要求 / 现有库表 / 改动清单）**分工不同**：那份讲「现状与要改哪里」，这份讲「DSH 这套记忆机制怎么运作、哪些机制值得照搬到 CCP-Bot」。本文不重复那份的结论，只在需要衔接处引用它。

---

## 上半：它今天怎么做

### 0. 关键路径速查

| 东西 | 确切路径 |
| --- | --- |
| 插件源码根 | `C:\Users\Damon\.dsh\profiles\desktop\node_modules\@yolk_vat-y\dsh-project-memory\` |
| 插件注册 | `C:\Users\Damon\.dsh\profiles\desktop\package.json`（`"@yolk_vat-y/dsh-project-memory": "0.6.3"`） |
| 生效配置 | `C:\Users\Damon\.dsh\profiles\desktop\cordis.patch.yml` 与插件自带 `cordis.patch.yml` |
| 项目级记忆（本项目） | `D:\Project\CCP-Bot\.dsh-project-memory\` |
| 全局级记忆 | `C:\Users\Damon\.config\dsh-project-memory\global.json` |
| 宿主会话事件日志 | `C:\Users\Damon\.dsh\sessions\--D-Project-CCP-Bot--\<sessionId>\session.v4.jsonl.zstd` |
| 宿主会话投影缓存 | `C:\Users\Damon\.dsh\storages\session_projcache\sessions\<sessionId>.json` |
| DSH 安装本体 | `H:\Deepseek Harness\resources\app.asar`（182 MB，18188 个文件；**插件不在里面**） |

关于「插件在哪」的核实：对 `app.asar` 内 18180 个小文件做全量内容扫描，字面量 `dsh-project-memory` 命中 **0 次**；`resources\app.asar.unpacked\dsh\node_modules\` 里只有原生依赖（node-pty、koffi、sherpa-onnx 等），没有记忆插件。所以它是**独立安装到 profile 的插件**，走 `dsh plugin add` 装进 `profiles\desktop\node_modules`。

### 1. 插件契约与配置

`src\index.js:1-3`：

```js
export const name = 'dsh-project-memory'
export const inject = ['llm', 'tools']
```

配置 Schema 是唯一事实来源（`src\index.js` 的 `Config`），默认值原文摘录（与插件自带 `cordis.patch.yml` 一致的部分）：

| 键 | 默认 | 作用（原文/转述） |
| --- | --- | --- |
| `memoryDir` | `.dsh-project-memory` | 每个项目根下 store 目录名 |
| `chunkChars` / `maxChunksPerFile` | `3000` / `40` | 文档切块 |
| `maxFileSizeMb` | `10` | 内存闸门：「10 把单文件增量压在 ~+300 MB」（`src\index.js:27-29`） |
| `lazyIndexing` / `autoIndexOnFirstUse` | `true` / `false` | 读到即记忆 |
| `watch` / `watchInterval` | `true` / `30` | 后台轮询（秒） |
| `allowUnsafeRoots` | `false` | 危险根护栏（issue #5） |
| `maxScanFiles` / `maxScanDepth` | `20000` / `12` | 单次扫描上限，截断会报告且不删条目 |
| `insight.dedupOverlap` / `reinforceBand` | `0.7` / `0.65` | 词法去重/强化 |
| `insight.autoMergeCos` / `autoMergeMargin` | `0.9` / `0.05` | 向量自动覆盖 |
| `insight.hintCos` | `0.7` | 近邻提示 |
| `insight.maxProject` / `maxGlobalProcedures` | `100` / `200` | 容量上限 |
| `insight.promoteConfidence` / `globalPromoteTasks` | `0.7` / `3` | 提升门槛 |
| `insight.decayDays` | `90` | 不活跃归档 |
| `autoContext.maxTokens` | `400` | 单轮注入预算（token；实现按 `*3` 变字符） |
| `autoContext.gateCooldownSteps` | `2` | 两次条目注入的最少步间隔 |
| `autoContext.maxItemsPerSession` / `maxItemCharsPerSession` | `60` / `24000` | 会话级额度（保险丝） |
| `autoContext.hintMinCoverage` / `hintMinMatched` / `hintMinSupport` | `0.45` / `2` / `0.15` | 提示通道三道门 |
| `autoContext.vectorAlpha` | `0.5` | BM25/余弦融合权重 |
| `autoContext.vectorDir` | 无默认（`'off'` 强制纯词法） | 可选语义层 |
| `autoContext.auditLog` / `shadowLog` | `true` / `true` | 两个审计文件 |

为什么这两个额度被抬到 60/24000（`src\index.js:121-125` 原文）：

> 这两个是**保险丝**不是节流阀：节流由 gateCooldownSteps 与单轮 maxTokens 负责。旧默认 12 / 4000 ≈ 11 条，实测真实日志里 11/81 个会话打满、打满后永久静默（1234 步失明）；实测最长会话用 35 条 / 8640 字符，故抬到 60 / 24000。

依赖面极小：`dependencies` 只有 `pdfjs-dist`；`optionalDependencies` 只有 `leanvec`（本地嵌入表，README 说 79 MB / 约 +130 MB RSS，不在时自动退回纯词法）。

### 2. 落盘：一个 store 的文件清单与每份的确切 schema

README 给的布局块（`README.zh-CN.md:83-95` 原文）：

```
.dsh-project-memory/
  format.json      布局标记（v2，分片式）
  shards/          每个被索引源文件一个自描述 JSON —— 写入只落脏分片
  experience.json.migrated  v0.4 经验笔记的只读归档（首次加载已导入 insights.json）
  watch.json       被监听根目录
  tasks.json       TaskBridge 任务实体（跨会话）
  binding.json     当前会话 ↔ 任务绑定
  insights.json    项目级记忆（教训 / 决策 / 流程 / 经验笔记）——唯一实体
  vectors.json     可选语义索引（只在向量层启用时存在）
  injection-audit.jsonl   每次真实注入一行（注入了什么 / 为什么 / 丢了什么 / 额度）
  admission-shadow.jsonl  每步一行，全部被评分的候选 + 特征（离线重放）
```

本机实测（`D:\Project\CCP-Bot\.dsh-project-memory\`）：`format.json`、`insights.json`、`vectors.json`、`watch.json`、`injection-audit.jsonl`(21 行)、`admission-shadow.jsonl`(324 行) + `.1` 轮转、`shards\`（10042 个分片文件）、`.gitignore`。

**`format.json`**（两个 store 内容一致，原文）：`{"version":2,"layout":"sharded"}`

**`.gitignore`**（`src\store.js:679-688` 写入的固定内容，原文）：

```
# dsh-project-memory: local by default. `git add -f` to commit it.
*
```

**`watch.json`**（本项目原文）：`["D:\\Project\\OpenBot","D:\\Project\\CCP-Bot"]`

**`insights.json`**（本项目原文头部）：`{"version":3,"migratedAt":null,"items":[…]}`，4 条。单条实测字段：

```json
{"id":"ins_d48ac084-a256-4e24-9e1d-9ee890aada31","kind":"lesson","scope":"project",
 "title":"从 app/ 目录跑 bun test 会丢掉根的预载，结论全是假的","source":"agent","draft":false,
 "confidence":0.95,"hitCount":4,"createdAt":"2026-10-30T15:18:54.407Z","updatedAt":"2026-10-30T15:18:54.407Z",
 "pattern":"…","fix":"…",
 "triggerDerived":{"keywords":[],"actions":[],"paths":["tests/xxx.test.tsx","bunfig.toml","./server/scripts/test-preload.ts","./app/tests/preload.ts","app/tests/preload.ts"]},
 "lastHitAt":"2026-10-31T12:59:41.294Z"}
```

注意 `src\insight-store.js` 里 `emptyInsightsDoc()` 给的是 `version: 1`，而本机落盘是 `version: 3` —— 写入路径会升版本，具体在哪一行改的版本字段 **未查到**（未读 `replaceInsightItems` 全文）。

**`global.json`**（`C:\Users\Damon\.config\dsh-project-memory\global.json`，5111 B，原文头部）：

```json
{"version":1,"migratedAt":null,"items":[
 {"id":"ins_9478dfc9-e6df-433f-a1c5-2991f6d03598","kind":"lesson","scope":"global",
  "title":"PDF 内嵌字体常是空心子集：不能复用，要换系统字体 + fontTools 预抽子集 + 渲染前字形守卫",
  "source":"agent","draft":false,"confidence":0.8,"hitCount":11,
  "createdAt":"2026-10-23T14:36:11.831Z","updatedAt":"2026-10-23T14:42:21.277Z",
  "pattern":"…","fix":"…"}, …
```

三条全局条目与命中数（实测）：`ins_9478dfc9`(hit 11)、`ins_aa0903d4`(hit 9)、`ins_aa86d759`(hit 8)，`kind` 全是 `lesson`、`scope` 全是 `global`。字段集实测：`id, kind, scope, title, source, draft, confidence, hitCount, createdAt, updatedAt, pattern, fix, triggerDerived, lastHitAt, prev, files, symbols`。

> 这一条解开了调研起点的一个疑点：本项目 `injection-audit.jsonl` 里引用的 `ins_aa86d759`、`ins_aa0903d4` **不在** `D:\Project\CCP-Bot\.dsh-project-memory\insights.json` 里，因为它们是 **global 层**条目，住在 `~\.config\dsh-project-memory\global.json`。审计文件只记 id，不记层。

**层级归属**（`src\types.js` 原文）：

> task: tasks.json 内嵌于任务实体 task.insights[]（私有草稿）；project: .dsh-project-memory/insights.json（团队/项目资产）；global: ~/.config/dsh-project-memory/global.json（个人能力库，跨项目）。

本机实测到的 store（`Get-ChildItem C:\Users\Damon\.dsh,D:\Project -Recurse -Force -Directory -Filter .dsh-project-memory -ErrorAction SilentlyContinue` 的结果，至少 8 个）：`C:\Users\Damon\.dsh\.dsh-project-memory`（只有 admission-shadow / injection-audit / vectors，**无 insights.json**）、`C:\Users\Damon\.dsh\im\.dsh-project-memory`（空 store，只有 .gitignore + format.json）、插件自身目录下的 `.dsh-project-memory`、`D:\Project\CCP-Bot`、`D:\Project\Claude-Codex-Pro-Tool`、`D:\Project\harness-desktop`、`D:\Project\nixiang`（admission-shadow.jsonl 338620 B / injection-audit.jsonl 948 B / watch.json）、`D:\Project\TopoAG`（admission-shadow.jsonl 4033 B / watch.json）。也就是说 store 是**按项目根分散**的，没有一个中央库。

**`vectors.json`**（本项目原文头部）：`{"version":1,"model":"l1:0574a2d3bdc075df:80723968","dim":256,"ids":[…7 个 ins_…],"hashes":["33df37fc2bf7906a",…],"blob":"<base64>"}`。要点：维度 **256**、`model` 形如 `l1:<hex>:<hex>`、每条带 16 位十六进制内容哈希。`src\vector-index.js` 全文与 `leanvec` 的 `l1:` 命名含义 **未查到**。

**`shards/<sha256>.json`**（10042 个文件，`format.json` 的 `layout:"sharded"` 对应）。文档类实测：

```json
{"relPath":"tauri-signing-skill.md",
 "record":{"sha256":"c17a9b6c…9608","size":13065,"type":"doc","indexedAt":"2026-10-30T04:22:05.508Z"},
 "entries":[{"id":"tauri-signing-skill.md#0","sourcePath":"tauri-signing-skill.md","sourceLine":1,
   "type":"doc","title":"tauri-signing-skill.md","summary":"…",
   "keywords":["signing","tauri","windows","key","or","authenticode","access","wiring"],
   "terms":"<空格分隔的词项索引>","hash":"c17a9b6c9943023d"}, …]}
```

代码类产出 `type:"symbol"` 条目（零 token 符号表）：

```json
{"id":"desktop_src-tauri_src_vault.rs#29","sourcePath":"desktop/src-tauri/src/vault.rs",
 "sourceLine":29,"type":"symbol","title":"is_secret (function)",
 "keywords":["is_secret","function"],"text":"is_secret — desktop/src-tauri/src/vault.rs:29"}
```

符号表覆盖扩展名（`src\symbols.js:1-70` 原文）：`JS_LIKE=['.js','.mjs','.cjs','.ts','.mts','.cts','.jsx','.tsx']`、`PYTHON=['.py']`、`GO=['.go']`、`RUST=['.rs']`、`C_FAMILY=['.c','.cpp','.cc','.h','.hpp','.cs','.java']`、`SHELL=['.sh','.zsh']`（即 README 说的「8 种语言」）。注释/字符串由 per-language masker 抹成空格但保留偏移，避免注释里的声明被当符号。

紧凑性实测（`README.zh-CN.md:70-75`，2026-10-13）：Vue 应用 289 文件 **325 bytes/条目 ≈ 源码 21%**；TS monorepo 12634 文件 **代码层占源码 22%**、整库 549 bytes/条目、**文档层占其源码 127%**；文档为主工作区 **1401 bytes/条目**。

### 3. insight 是唯一记忆实体

`src\types.js`（JSDoc）逐字段原文要点：

- `kind ∈ lesson | decision | procedure | experience`：lesson = pattern→fix；decision = topic→choice+reason；procedure = steps；experience = problem→solution（**`remember` 写的就是它**，v0.4 的 `experience.json` 在加载时导入成同一实体，「不再有第二个存储」）。
- `scope ∈ task | project | global`。
- `draft`：true = 反思自动产出、未审核、**不参与注入**（`recall.js` 里也把 draft 挡在 `query_memory` 之外）。
- `prev`：「被自动覆盖/就地更新挤掉的**上一个**值（按字段名），只留一版：误覆盖后用同一个 id 再写一次即可写回；不是历史（不做折叠、不压实）」。
- `archived`：「归档 = 软删：不进召回/注入，可恢复」。
- `sourceTaskIds`：「曾在哪些任务中出现/被命中（提升判定唯一依据）」。
- `hitCount` / `lastHitAt`：曝光计数与最近命中（衰减依据）。

### 4. 写入路径：一次保存到底发生什么

入口是三个工具（`src\tools\lesson-tools.js`、`remember.js`），最终都落到 `src\insight-store.js` 的 `saveInsight()`，返回 `action ∈ created | merged | auto-merged | reinforced | updated | linked-project | linked-global`。

**唯一相似度指标是词法双向 token overlap**（`src\similarity.js`，52 行全文）：

> v0.5 去重 / 合并 / 强化共用的**唯一**相似度指标；BM25 只用于排序，禁止当阈值。
> 归一化定义：normalized = 共同 token 数 / 两文本中较长者的 token 数（= min(ratioA, ratioB)）… 因此「≥ 0.7 合并 / 0.65~0.7 强化」只需在此单一尺度上比较，跨库/跨长度可比。

匹配文本 `insightMatchText(ins)` = `title + problem + pattern + topic + choice + body`（**不含 fix/steps/reason**）。

**写入决策顺序**（`src\insight-store.js:775-797` 的 `upsertIntoPool`，转述+原文阈值）：

1. 向量带：`autoMergeTarget(near, cfg)` 要求 `top1 >= autoMergeCos(0.9)` 且 `top1 - top2 >= autoMergeMargin(0.05)` → `auto-merged`，字段合并、旧值进 `prev`。
2. 词法带：`findBestOverlapMatch` 的 `score >= dedupOverlap(0.7)` → `merged`；`score >= reinforceBand(0.65)` → `reinforceOnly`（并 `sourceTaskIds`、`hitCount+1`、`lastHitAt`、解除归档）→ `reinforced`；否则新建 → `created`，并在 `hintOf` 命中时返回近邻提示。

阈值来源是实测分布（`src\insight-store.js:53-58` 原文）：

> 47 条 live 条目、1081 对的余弦 max=0.655 / p99=0.531；本机 4B 把同一条知识改写后与原文的余弦 min=0.688 / p50=0.809。所以：· 0.90 自动覆盖…；· 0.70 提示 —— 在全部 1081 对真实条目上零噪声，而改写后的再记录有 78% 落进来。0.65 会开始误伤真实条目（1/1081），别往下调

不变量（`src\insight-store.js:73`）：`if (cfg.reinforceBand > cfg.dedupOverlap) cfg.reinforceBand = cfg.dedupOverlap`。

**就地更新**：带 `id` 再调一次 `save_lesson` 就是覆盖，只改显式传的字段，旧值进 `prev`（README 原文：「只改本次显式传的字段，旧值留在 `prev`，用同一个 id 再写一次即可写回」）。

**提升 = 更换归属而非复制**（`src\insight-store.js:913`、`:960` 注释原文）：

- task 池扫描：同一 insight 命中 ≥2 个任务且 `confidence ≥ promoteConfidence(0.7)` → 升 project；
- project 扫描：`sourceTaskIds ≥ globalPromoteTasks(3)` → 升 global。

级联去重还有个容易漏的点：新写 task 条目时先查 project 池 → `linked-project`；再查 global 池 → `linked-global`；再查**所有任务池** → 同一坑只存一份（`saveTaskInsight`）。

**容量与衰减**：`applyDecay` 用 `activityOf = lastHitAt || updatedAt || createdAt` 与 `now - decayDays(90)` 比较，超期归档；`pruneItems` 超容量时**优先物理删除已归档且最不活跃的**条目（「物理删除只发生在容量溢出」）。

这里有个作者自己记下的行为缺陷，值得抄的时候直接抄结论（`recordHit` 的文档注释原文）：

> …`applyDecay`/`pruneItems` 判活跃度只看 `lastHitAt || updatedAt || createdAt`，而 `lastHitAt` 此前只由 merge/reinforce 写…于是一条天天被注入、但从没人重写它的教训，`decayDays`（默认 90）之后会被自动归档、再也不会被推送——**用得最多的反而等于没人用过**。这是行为缺陷，不是调优问题。

修正就是 `recordHit({store, globalStore, ids, nowIso})`：注入进上下文或被 `query_memory` 命中时记一笔；并强调「记账**不参与任何注入判据**…语义是"曝光次数"而非"被采纳次数"」。

**删除**：`forget` 是真删、无撤销；关键词命中超过 `maxForgetMatches`（默认 10）时**一条都不删**、只列候选；最近删除的 5 条（`DELETED_KEEP = 5`）以完整条目留在该层 store 同目录的 `deleted.json`（`src\insight-store.js:571-574` 原文：「project/task 条目落在项目 store 目录、global 落在 global 文件目录」）。

**写盘前密文过滤**（`src\insight-store.js:21-30`）：9 条 `SECRET_PATTERNS`（PEM 私钥、`sk-…`、`gh[pousr]_…`、`AKIA…`、`AIza…`、`xox[baprs]-…`、`Bearer …`、`password|passwd|secret|token|api_key = "…"`），命中即拒绝写入，报错原文：`内容疑似包含密钥/token/私钥形态数据（字段: ${secretField}），已拒绝写入`。

### 5. 索引层：读到即记忆、变更即刷新

**唯一的「该不该读/写什么条目」实现在 `src\index-pipeline.js`**（120 行全文），返回 five-way plan：`UNSUPPORTED | OVERSIZE | UNCHANGED | DROP | WRITE`；`readFileForIndex` 一次读拿到 `{hash, buffer}`，未变更的文件不解码；文档类走 `buildDocEntries`，代码类走 `scanSymbols`。写入用 CAS：`toFileUpdate` 带 `expectedHash: record?.sha256 ?? null`，原文注释「扫描之后文件又被改动时，commit 会拒绝这次写入」；`commitFileUpdates` 把一批更新并成一次 `store.commit()`。

文件头注释说明了为什么合并（原文）：

> 这段逻辑以前在 index_repo（批量）、watch（轮询）、lazy（fs/observed 懒索引）里各抄一份，三份随后各自打补丁、已经漂移…现在「这个文件该不该读、读出来该写什么条目」只在这里定义一次

**懒索引的缝**（`src\lazy.js:1-96`，`setupLazyIndexing`）：监听 `fs/observed`，300 ms 去抖，原文：

```js
ctx.on('fs/observed', (target, observation, actor) => {
  if (!target || !observation || observation.kind !== 'present') return
  if (typeof target.displayPath !== 'string' || !target.displayPath) return
  queue(target.displayPath, sessionWorkingDir(actor?.agent?.session, {agent: actor?.agent}))
})
```

附带的重要设计（原文注释）：「不再被无条件 addWatch 记进 watch.json —— 那样会造出一个每次启动都复活的"僵尸根"」。

**切块与词项**：`src\chunker.js` 按 markdown 标题流式切，优先 `\n\n` → 空格 → 硬切，块带 `{title, text, line}`；文件头注明改流式的原因（原文）：「原实现先把整份正文 `split(/\r?\n/)`…峰值与文件大小同阶（实测 PDF 边际 19×、单文件 50 MB → ~1.2 GB RSS）」。`src\doc-index.js` 把「注入用的短摘要」与「检索用的词项」拆开：`summary` 短、`terms` 覆盖整个 chunk（`MAX_TERMS=160`），关键词靠 `title + ' ' + title + ' ' + text` 的标题加权，**全程不调用模型**。

**根推导与危险根**（`src\util\fs.js:560-704`）：顺序是「显式登记的根（最深匹配）→ 最近的 VCS 标记（`.git`/`.hg`/`.svn`）→ 最近的构建/清单标记（`package.json`、`go.mod`、`Cargo.toml`、`pyproject.toml` …）→ 会话工作目录（前提是文件在其内且安全）→ 否则不索引」。标记列表**刻意不含 `.dsh-project-memory`**（原文注释：「那个目录是插件自己创建的，一旦算作项目标记就会自我固化…于是家目录被永久锁成"项目"」）。排除名单（README:154 原文）：文件系统根、家目录、临时目录、系统/包管理器前缀；这些目录下的会话不启用记忆并往 stderr 打一行说明。

### 6. 注入路径（push）：唯一缝、两个通道、三道门、两份额度

**缝只有一个**（`src\auto-inject.js` 顶部注释与实现）：`ctx.on('agent/pre-step', …)`。原文注释：「宿主没有'工具执行前拦截'钩子，所以这是 pre-step 之外唯一能拿到的动作事实」。失败必须降级：出错只 `console.error('[dsh-project-memory] auto-inject skipped: …')` 并返回原 decision，因为「宿主 agent.ts 直接读 `decision.kind`，会崩掉整步 → 无法回复」。

**注入消息长什么样**（`injectionMessage()`，以及本机真机日志解出的原文）：

```
\n\n[Memory Inject] dsh-project-memory · auto-context
- [ins_aa86d759-bb32-4d72-baa5-c0294d048718] 空 secret 不等于「未签名」：Tauri 会去 import 空证书而打包失败 — 在 Tauri 打包的工作流里，把签名变量从「构建步骤的 env」搬到「前一步的条件注入」：…未签名打包保持可跑，配上 secret 就自动签名。
```

它是一条**追加的 `role:"user"` 消息**，带 `source`：

```json
"source":{"kind":"plugin:dsh-project-memory","form":"snapshot","sections":[{"name":"project-memory","text":"…"}]}
```

同一个块里可以混 project 与 global 层的条目（真机第 2 次注入同时含 global 的 pwsh 教训与 project 的 biome 决策）。`SOURCE_KIND` 存在的理由（源码注释原文）：「消息的 `source.kind`…只有宿主看得到：请求序列化只取 `role` 与 `content`…抬头是**唯一**能让模型（和 GUI 里的用户）看见生产者的地方」，并且 `isOwnInjection` 要据此挡住自激（注入块也是 `role=user`，会被「最后一条 user 消息」误当查询）。

**通道 1：authored trigger（确定性，优先级 1）**。只有 `when`（op / 写目标 / 意图词）能触发，`guard` 只能收窄；**没有 `when` 的条目在这里永远不命中**，降级为「可发现 + 按需拉取」。op 词典 9 个（`git-add`、`git-commit`、`git-push`、`npm-publish`、`release`、`go-public`、`delete`、`migrate`、`deploy`，`src\readiness.js:27`）。派生词表 24 个（提交/公开/泄漏/发布/发包/发版/上线/部署/迁移/删除/清理/回滚/推送/打包/构建/依赖/密钥/权限/并发/超时/内存/性能/安全/面试），上限 `DERIVED_MAX_KEYWORDS=6`、`DERIVED_MAX_ACTIONS=4`、`DERIVED_MAX_PATHS=6`。

两个防伪规则值得直接抄（都有实测反例，原文在 `src\readiness.js:182-241`）：

- `hintQueryText` 会剥掉 1–3 个字符的拉丁词：「`PR` / `CI` / `OS` / `WSL` / `npm` 这类缩写太短、歧义太大，一个巧合命中就能当上该层最高分…（实测：人类消息里的 "PR" 把一条 task-tools 越权 lesson 顶到了提示位；"wsl" 又把一条 pnpm lesson 顶到了"改文件时间戳"的任务里）」。
- `intentText` 会剥掉代码块、行内代码、引号内容、路径、带扩展名的非 ASCII 文件名：「人类消息里的文件名是**数据**，不是意图。实测中"示例调研.pptx"这个文件名让一条"做调研要先扫 curated 列表"的经验在改文件时间戳的任务里被注入。」

**通道 2：统计提示（hint）**，判据是**层内相对阈值**而非魔法常量。逐条门槛顺序（`src\auto-inject.js:321-468`）：

1. 通道级静音 `channelThin = supportRatio < hintMinSupport(0.15) && !vectorRescue` → `dropped: support:0.xx`；
2. `coverage < hintMinCoverage(0.45)` → `dropped: coverage:0.xx`；
3. `matched < min(hintMinMatched(2), terms)` → `dropped: thin:N`；
4. 相对分 `relative(min) = signalMinRatio(0.5)` 之外的落 `relative`；
5. 通过则 `why = relative:0.71 cov:0.71/4` 这样的自证字符串（本机审计文件里逐字可见）。

三道门的实测来源（源码注释原文）：

- `hintMinCoverage=0.45`：「0.30 时的实测反例：真实 store（43 条同源洞察）上，对照组场景「改 pptx 时间戳」以 cov 0.32~0.35 注入了 3 条无关条目…0.45 落在实测分布的空隙里（假阳性 ≤0.35、下一个真命中 ≥0.49）」。
- `hintMinMatched=2`：「单个通用词（"插件"）也能拿到 coverage=1.00」。
- `hintMinSupport=0.15`：「查询里能在语料中找到对应的词占比低于这个值时，整条提示通道本轮不出声。长句子里只有一两个词碰巧命中，coverage 会虚高到 1.00」。

**为什么向量不做闸门**（源码注释原文）：

> 实测在带标注的 8 场景/24 条池上，expect 为空的对照场景纯向量 top-1 = 0.38，而多条**真命中**只有 0.20~0.38（余弦与真值区间重叠）→ 任何绝对余弦阈值要么放过对照、要么杀掉真命中。所以闸门继续由词法/支持度决定（它们不随嵌入模型变），向量只在 BM25 的 top-k 内决定"先说哪条"。

同处还写明两个旋钮**不要开**：`itemMin`（真实交付分辨力为零；逐条标签一致率 57%、Cohen kappa = **-0.05**）、`speakMin`（最高余弦 0.467 vs 最低目标 0.483，间隔只有 0.016）。

**预算与去重**（`buildInjection`）：`stepBudget = maxTokens * 3`（字符，即 **3 字符 ≈ 1 token**）、`itemBudget = min(stepBudget, 会话剩余字符)`；条目最小可用长度 `MIN_BODY_CHARS = {trigger: 48, hint: 120}`（塞不下就宁可不注入，「与其输出 `- [ins_xxx] procedure ` 这种 stub，不如保持沉默」）；每条记 `hash = insightItemHash(it)`（`insightBody(it)` 的 sha256 前 12 位），内容没变就不重复注入；整块再用 `fingerprint(dedupeText)` 去重，且 `dedupeText` 特意排除「编辑中」这种每次写文件都变的 churn；`gateCooldownSteps=2` 是「别频繁注入」的主旋钮（常驻任务卡不受限）；会话级两个量分别是 60 条 / 24000 字符。

**每次注入落两行审计**（本项目实测）：

- `injection-audit.jsonl`（21 行）键集：`at, session, root, step, chars, labels, injected, dropped, budget, silence`；`injected[i] = {id, channel, why, chars}`；`dropped[i] = {id, channel, reason}`；`reason` 实测形如 `coverage:0.22` / `coverage:0.29` / `support:0.01` / `budget`；`budget` 实测随会话增长：`{"items":1,"chars":297,"lastStep":1}` → 第 182 步 `{"items":6,"chars":1914}`。
- `admission-shadow.jsonl`（324 行）键集：`at, session, root, step, query, scoreQuery, ops, writes, injected, support, terms, candidates, candidatesTotal, dropped, silence`；实测某行 `candidates` 里逐字为 `{"id":"ins_245cbd64-…","rel":3.045,"coverage":0.667,"matched":2,"decision":"support","outcome":"gate"}`。注意 **0.6.3 落盘的 candidate 键集是 `id, rel, coverage, matched, decision, outcome`**，比源码里的 `{id, channel, rel, coverage, matched, support, terms, decision}` 少几个键 —— 两处都对（源码另有「默认路径的记录与旧版逐字节一致」的兼容分支），但**以落盘为准时按上面 6 键写解析**。源码注释把两层结论分得很清：「`decision` 是**门槛层**的结论，`outcome` 是**预算层**的结论，两者正交」，`outcome ∈ injected | idle | gate | unscheduled`。

**常驻任务卡**是例外：只占 `stepBudget`、不占条目额度、不受 cooldown 限制（「它是状态快照」）；根不明确时还会注入一次说明（`rootNotice` 原文）：``memory root: ${root} (inferred from the session working directory; no project marker found). If project memory should live elsewhere, pass `root: <dir>` to index_repo / watch_repo / remember / query_memory, or restart dsh inside the project directory.``

### 7. 召回路径（pull）：`query_memory`

工具描述与参数（`src\tools\query-memory.js`）：`query`（必填）、`root`（默认当前工作目录）、`type ∈ all|doc|symbol|experience|insight|task`、`limit`（默认 8）；描述原文强调「Use BEFORE grepping when you need orientation, a spec constraint, or a past decision.」

跨层召回的三条不变量（`src\recall.js` 模块注释原文已引）加上**层先验** `LAYER_PRIORS = {insight: 1.15, doc: 1, symbol: 1, experience: 0.9}`、规范段提权 `NORMATIVE_PRIOR = 1.5`（只给标题命中「必须/禁止/rules/must/…」的 doc chunk）；`matchedFloor` 在**无向量**时要求至少 `min(2, 查询词数)` 个词命中（A/B 实测：纯词法下 hit@1/3/5/10 = 39/50/58/69% 完全不变，只是不再对乱码查询出声；有向量时加闸门反而把 hit@5/10 从 64/72% 拉到 58/64%，因为「向量救回来的那批，恰恰就是词法弱到不足 2 个命中的」）；向量融合只在**全量 BM25 序**上做、截断在后，且**不能拉进零词重叠的条目**。

BM25 实现细节（`src\util\search.js`）：`K1=1.5`、`B=0.75`、`idf = log(1 + (N-df+0.5)/(df+0.5))`、CJK 按 bigram 分词、CJK 短语命中 `score *= 1.5`；字段权重是「title 重复 5 次 + keywords + summary + terms + sourcePath」；`SYNONYMS` 只有 4 条人工词条。可返回的层级、任务私有性（`task` 层的条目只对绑定该任务的会话可见）、`draft`/`archived` 一律不召回，都在 `visibleInsights()` 里。

可核验性：每条召回都带 `sourcePath` + 行号，或 insight id；文档与符号的交叉链接按当前符号表解算，不落盘（「派生数据一律不落盘」）。

### 8. 任务桥与会话（跨会话续接的实现在这里）

**任务实体**（`D:\Project\Claude-Codex-Pro-Tool\.dsh-project-memory\tasks.json` 实测首条原文）：

```json
[{"id":"tsk_f574f066_更新-spec-acceptance-最大上下文_mvj7oxta_bbcb80","projectHash":"f574f066",
  "projectRoot":"D:\\Project\\Claude-Codex-Pro-Tool","title":"更新 spec/acceptance：最大上下文改为 K 单位…",
  "steps":[{"content":"…","status":"completed"},{"content":"…","status":"in_progress"},{"content":"…","status":"pending"},…],
  "files":[…100 个相对路径…],"fileMeta":{"acceptance/….md":{"n":12,"reads":5,"lastReadAt":"2026-10-22T10:27:21.784Z","writes":7,"lastWriteAt":"…"}},
  "archived":false,"lastSessionId":"session-db238160-a179-472c-92ca-509f7e13d587",
  "createdAt":…,"updatedAt":…,"lastActiveAt":…,"lastTodoAt":…,"lastHumanAt":…,
  "insights":[…3 条 task 级 insight…]}]
```

**绑定就是一张会话→任务的表**（`binding.json` 实测全文，只有一条）：

```json
{"session-db238160-a179-472c-92ca-509f7e13d587":"tsk_f574f066_更新-spec-acceptance-最大上下文_mvj7oxta_bbcb80"}
```

**TaskBridge 的行为**（`src\setup\taskbridge.js`）：监听宿主 `session/event`，把 `todo/write` 同步成任务 `steps`、把 `read/write/edit/read_image` 的 `file_path` 记进 `files`/`fileMeta`（`MAX_FILES_PER_TASK = 100`、`TITLE_MAX = 24`）；新会话 `list_tasks` → `select_task` 续接后会把任务 steps**反向灌回宿主的 todo 投影**：`session.append('todo/write', {todos: steps.map(s => ({content: stepContent(s), status: stepStatus(s)}))})`。任务 id 生成（原文注释解释为什么要随机后缀）：

```js
`tsk_${hash8(projectRoot)}_${slugifyTitle(title)}_${Date.now().toString(36)}_${randomUUID().slice(0,6)}`
```

**宿主自己的会话持久化**（不属插件，但「会话保持」必须知道）：每个项目一个目录 `C:\Users\Damon\.dsh\sessions\--<cwd 里的 \ 与 : 换成 - -->\<sessionId>\session.v4.jsonl.zstd`，内容是**多帧 zstd** 包住的 JSONL 事件（`{"type":…,"seq":N,"time":<ms>,"data":{…}}`），实测事件类型 `job/settled, tool/result, step/end, step/start, assistant/message, tool/call, job/registered`。另有投影缓存 `C:\Users\Damon\.dsh\storages\session_projcache\sessions\<sessionId>.json`，形状 `{version:7, record:{identity:{formatVersion:4, createdAt, cwd, …}, rows:{…}}}`，行名包括 `todos, plan, goal, tokenUsage, contextPressure, contextBreakdown, turnOutline, sessionStats, workingDirectory, modelSelection` 等 —— 也就是说**「会话状态」在宿主侧是投影表，而不是记忆插件的一部分**。

> 复现提示（我踩过的坑）：Node 22 的 `zlib.zstdDecompressSync` 只解**第一帧**（468 KB 的文件只吐出 276 B）。必须按魔数 `28 b5 2f fd` 切帧逐帧解；1260 万字节级别的日志解出 1259 帧 / 7.98 MB / 2215 行。（`bash` 在本机写不了 `%TEMP%` 也写不了仓库，全流程用 pwsh。）

### 9. 与 OpenViking 的关系：两套，不是一个库

- 插件根 `C:\Users\Damon\.dsh\profiles\desktop\node_modules\@openviking\` 下只有一个包 `dsh-memory-plugin`（DSH 侧的桥）。
- 用户目录同时存在 `C:\Users\Damon\.openviking`（独立目录）与 `C:\Users\Damon\.dsh`；`.dsh` 下没有 openviking 目录。
- 因此 `dsh-project-memory` 的落盘（`<root>\.dsh-project-memory` + `~\.config\dsh-project-memory\global.json`）与 `viking://` 是**两套互不相同的存储**。

**未查到**：`@openviking/dsh-memory-plugin` 注册了哪些工具、`~\.openviking` 里是不是 `viking://` 的库、两者是否共享数据。

### 10. 未能确认项（连同最省事的确认方式）

1. `src\vector-index.js`（12489 B）全文与 `leanvec` 的 `l1:<hex>:<hex>` 命名含义、`dim=256` 的来历 —— **未查到**。确认方式：读该文件 + `node_modules\leanvec\package.json`。
2. `src\readiness.js:280-513`（`matchTrigger` / `normalizeTrigger` / `corpusTermSets` / `idfCoveragePrepared` / `relativeHits` 实现）与 `src\index.js:201-253` —— 未读；上文关于 coverage/support 的定义来自 `auto-inject.js` 的调用与注释。
3. `watch.js` 的轮询/退避实现细节（「回合进行中静默、空闲退避到 2 分钟」）只从 README 得到，**源码未核对**。
4. `insights.json` 落盘 `version:3` 与 `emptyInsightsDoc()` 的 `version:1` 之间在哪一步升版本 —— **未查到**。
5. `tools\task-tools.js` / `commands\insight-actions.js` / `client\*.tsx` 的行为（面板、`/tasks` 子动词、翻页 30 条/页）—— 只从 README 得到。
6. OpenViking 侧（见上节）。

---

## 下半：CCP-Bot 该怎么抄（全部 proposed）

前提与分工：以下都是 **proposed**。库表基座用 CCP-Bot 现有的 PostgreSQL + pgvector（`server\drizzle\0000_schema.sql`），其中 `chunks`（`id uuid PK`、`document_id uuid FK→documents ON DELETE cascade`、`position integer`、`content text`、`embedding vector(1536) NOT NULL`）与 `documents`（含 `content_hash`、`deleted_at`、`source_id`、`connector_instance_id`）已存在；服务端现状与「知识库已被删除 / embedding 今天没人算」等判断见 `docs/self-hosted-memory.md`，本文不重复。**注意：现有 `sessions` 表是登录会话（`user_id, token, expires_at`），不是对话会话；对话历史与记忆表今天都不在本地库里**，所以下面全是要新增的表。

### P1. 表结构（proposed）

抄的核心判断：**DSH 把「记忆条目」「索引分片」「会话状态」「审计」分成四类数据，只有第一类需要事务与去重**。照这个切分建表。

```sql
-- 1) 记忆条目：唯一实体（对应 insights.json / global.json / task.insights[]）
CREATE TYPE memory_kind   AS ENUM ('lesson','decision','procedure','experience');
CREATE TYPE memory_scope  AS ENUM ('task','project','global');
CREATE TYPE memory_source AS ENUM ('agent','user','reflect','migrate');

CREATE TABLE memory_insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           memory_scope  NOT NULL,
  kind            memory_kind   NOT NULL,
  title           text          NOT NULL,               -- 截断 200 字符（照抄 slice(0,200)）
  body            text,
  pattern         text, fix        text,                -- lesson
  choice          text, reason     text,                -- decision
  steps           text[],                               -- procedure
  problem         text, solution   text,                -- experience（remember 写这种）
  files           text[]        NOT NULL DEFAULT '{}',
  symbols         text[]        NOT NULL DEFAULT '{}',
  tags            text[]        NOT NULL DEFAULT '{}',
  confidence      real          NOT NULL DEFAULT 0.8,
  draft           boolean       NOT NULL DEFAULT false,
  archived        boolean       NOT NULL DEFAULT false,
  source          memory_source NOT NULL DEFAULT 'agent',
  hit_count       integer       NOT NULL DEFAULT 0,
  last_hit_at     timestamptz,
  prev            jsonb,                                -- 只留上一版：按字段名存被挤掉的旧值
  moved_from      jsonb,                                -- 提升/降级审计 {scope,id,at}
  project_root    text,                                 -- project/task 层用；global 层为 NULL
  owner_user_id   text REFERENCES users(id) ON DELETE SET NULL,   -- 单用户自托管可为 NULL
  -- 词法检索列：照抄「title 重 5 次 + keywords + summary + terms」的加权思路
  search_text     text NOT NULL DEFAULT '',             -- 生成列在 P5 里给
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 2) 层级归属：task 层挂在任务实体上（对应 task.insights[] 内嵌数组）
CREATE TABLE memory_insight_tasks (
  insight_id  uuid NOT NULL REFERENCES memory_insights(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES agent_tasks(id)    ON DELETE CASCADE,
  PRIMARY KEY (insight_id, task_id)
);   -- 这张表同时就是 sourceTaskIds：提升判定唯一的依据

-- 3) 向量索引（对应 vectors.json；维度与模型名必须与 chunks.embedding 同一取舍，见 P6）
CREATE TABLE memory_insight_vectors (
  insight_id  uuid PRIMARY KEY REFERENCES memory_insights(id) ON DELETE CASCADE,
  content_hash text NOT NULL,        -- insightBody 的哈希：正文变了才允许重算/重注入
  embedding   vector(1536) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- 4) 任务实体与绑定（对应 tasks.json + binding.json：注意 DSH 是「会话→任务」一张映射表）
CREATE TABLE agent_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_root    text NOT NULL,
  project_hash    text NOT NULL,                    -- 照抄 hash8(projectRoot)，方便跨库/跨机对号
  title           text NOT NULL,
  steps           jsonb NOT NULL DEFAULT '[]',      -- [{content, status: completed|in_progress|pending}]
  file_meta       jsonb NOT NULL DEFAULT '{}',      -- {relPath:{n,reads,lastReadAt,writes,lastWriteAt}}
  archived        boolean NOT NULL DEFAULT false,
  last_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz, last_todo_at timestamptz, last_human_at timestamptz
);

CREATE TABLE agent_task_bindings (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  task_id         uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- 5) 会话与消息（DSH 的会话状态在宿主投影里，不在插件里；CCP-Bot 必须自己建，见 P5）
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text REFERENCES agents(id) ON DELETE SET NULL,
  channel_id      text REFERENCES channels(id) ON DELETE SET NULL,
  user_id         text REFERENCES users(id) ON DELETE SET NULL,
  project_root    text,
  title           text,
  workspace       jsonb NOT NULL DEFAULT '{}',      -- 对应 projcache 的 workingDirectory 等标量行
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             integer NOT NULL,                 -- 宿主事件 seq；(conversation_id, seq) 唯一
  role            text NOT NULL,                    -- user|assistant|tool|system
  content         jsonb NOT NULL,                   -- 原样存内容块数组
  source          jsonb,                            -- 注入消息要带 {kind,form,sections}
  turn            integer, step integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE conversation_summaries (              -- 摘要层：要不要，见 P5 的取舍
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  upto_seq        integer NOT NULL,
  summary         text NOT NULL,
  tokens          integer,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- 6) 审计（照抄两份 jsonl 的分工；append-only 用现有 audit_events 的同一手法）
CREATE TABLE memory_injections (
  id           bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn integer, step integer,
  project_root text,
  chars        integer NOT NULL,
  injected     jsonb NOT NULL,   -- [{id, channel, why, chars}]  why 形如 "relative:0.71 cov:0.71/4"
  dropped      jsonb NOT NULL,   -- [{id, channel, reason}]    reason 形如 coverage:0.22 / support:0.01 / budget
  budget       jsonb NOT NULL,   -- {items, chars, lastStep}
  silence      text,             -- cooldown | session-items | session-chars | NULL
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_retrieval_shadow (             -- 每步/每次召回一行，全部候选 + 特征
  id           bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn integer, step integer, query text, score_query text,
  ops text[], writes text[],
  candidates   jsonb NOT NULL,   -- [{id, rel, coverage, matched, decision, outcome}]
  candidates_total integer NOT NULL,
  dropped      jsonb NOT NULL,
  silence      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_deleted (                      -- 对应 deleted.json：最近 5 条完整条目，按层分区
  id uuid PRIMARY KEY,
  scope memory_scope NOT NULL,
  payload jsonb NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
```

索引（proposed）：

```sql
CREATE INDEX memory_insights_live_idx   ON memory_insights (scope, kind) WHERE NOT archived AND NOT draft;
CREATE INDEX memory_insights_search_idx ON memory_insights USING gin (search_text_tsv);       -- 见 P5
CREATE INDEX memory_insight_vectors_hnsw ON memory_insight_vectors USING hnsw (embedding vector_cosine_ops);
CREATE INDEX conv_messages_seq_idx ON conversation_messages (conversation_id, seq);
```

**不要抄的两处**（理由都来自上半的证据）：① 不要抄它的**文件分片 + 进程内锁**（`store.js` 的 `layout:"sharded"`、「锁在进程内：请避免多个 dsh 实例同时写同一项目存储」）—— CCP-Bot 是多进程/多租户，PostgreSQL 事务就是它手写的原子写 + CAS 的替代品；② 不要抄它**为单进程省内存**而做的 resident-byte 估算与 `STORE_CACHE_MAX_BYTES`，那是嵌入式形态的补丁。

### P2. 写入 / 去重 API（proposed）

对外暴露两个工具（沿用它的语义，宿主侧是 MCP 工具或 server 内部 service 都行）：

- `remember(problem, solution, …)` → 写 `kind='experience'`
- `save_lesson(title, kind, scope, 正文, trigger, id?)` → 写 lesson/decision/procedure，带 `id` 就是就地覆盖

两者的核心是**一个事务里的三带判定**，阈值照抄（它们是实测标定的，不要重调）：

```ts
// proposed: server/src/memory/save.ts  伪代码，一次事务内完成
async function upsertMemory(raw, { scope, taskId, projectRoot }) {
  rejectIfSecret(raw);                              // 9 条 SECRET_PATTERNS 照抄
  const text = matchText(raw);                      // title+problem+pattern+topic+choice+body（不含 fix/steps/reason）
  return db.transaction(async (tx) => {
    // 1) 向量带：top1 >= 0.90 且 top1-top2 >= 0.05 → 自动覆盖，字段合并，旧值进 prev
    // 2) 词法带：normalizedTokenOverlap >= 0.70 → merged；0.65..0.70 → reinforceOnly
    //    normalizedTokenOverlap = |A∩B| / max(|A|,|B|)  ← 唯一尺度，不要用 ts_rank 当阈值
    // 3) 否则 INSERT，并返回近邻提示（余弦 >= 0.70 时给 id + 相似度 + 标题）
    // 4) 同级池查重：project 池 → linked-project；global 池 → linked-global；所有任务池 → 合并掉
    // 5) 提升：memory_insight_tasks 计数 >= 2 且 confidence >= 0.70 → scope 升 project；
    //    >= 3 → 升 global（提升 = 改 scope 字段，不复制行）
    // 6) 容量：超限（project 100 / global procedures 200）先删 archived 且最不活跃的
    // 7) 衰减：activity = last_hit_at ?? updated_at ?? created_at，早于 now()-90d → archived=true
  });
}
```

三个必须一起抄的细节：

1. **`prev` 只留一版**。覆盖时把被挤掉的字段值存进 `prev`（jsonb），并让「同一个 id 再写一次」支持写回；不要做历史版本表（DSH 明确不做折叠/不压实，因为成本高收益低）。
2. **`recordHit` 记账**。注入进上下文、或 `query_memory`/检索命中时，`hit_count += 1`、`last_hit_at = now()`。上半那段的教训是「用得最多的反而等于没人用过」—— 漏了这步，衰减会把天天用的条目归档掉。记账**不参与任何注入判据**。
3. **`forget` 的保守性**。关键词命中数 > 10 时**一条都不删**、只返回候选；真删时把完整条目写入 `memory_deleted`（按层保留最近 5 条）。这比「模糊删除」重要得多，直接决定误删能不能救回来。

### P3. 混合检索与裁剪（proposed）

**目标是把 DSH 的三条不变量搬进 SQL，而不是把它的 BM25 手写一遍**：每层各自 top-k 再合并；跨层不给伪可比分数；闸门由词法/支持度决定，向量只重排。

1. **词法层**：`memory_insights.search_text` 用生成列把权重编码进去（title 重复 5 次对应 A 权重、files/symbols/tags 对应 B、body 对应 C），配 `tsvector` + GIN 索引；`ts_rank_cd` 出分。中文用 `zhparser`/`pg_jieba` 或先用 bigram 预处理（DSH 的 CJK 就是 bigram + 短语命中 ×1.5）。这条是**主力**：它的实测是「纯向量在改写成不含原词的查询集上 hit@10 53% vs BM25 69%」。
2. **向量层**：pgvector `embedding <=> $1` 取 top-k，**只在 BM25 的 top-k 内重排**，融合照抄 `(1-α)·(bm25/BM25_top) + α·cos`，`α = 0.5`（它实测 α=0.5 在小 k 最好、α=1 明显更差）。**不要把余弦分当绝对闸门**（上半那条 0.38 vs 0.20~0.38 的重叠就是反例）。
3. **闸门**（顺序不能换，因为审计里 `why`/`reason` 的语义依赖它）：通道级 `support = 命中词数 / 查询去重词数 ≥ 0.15` → 条目级 `coverage(加权) ≥ 0.45` → `matched ≥ 2` → 相对分 `≥ 0.5 × 该查询最高分`。
4. **裁剪**：单轮预算按 `maxTokens * 3` 字符；条目最小可用长度 `trigger 48 / hint 120` 字符，塞不下就丢掉并记 `reason='budget'`；会话级两个保险丝（60 条 / 24000 字符）；两次条目注入间隔 ≥ 2 步（`gateCooldownSteps`）；条目级去重用正文哈希（`sha256(insightBody).slice(0,12)`），整块去重再叠一层指纹。**常驻任务卡不占条目额度**。
5. **层先验**：`insight 1.15 / doc 1 / symbol 1 / experience 0.9`，规范段提权 1.5（只给标题命中「必须/禁止/rules/must」的 chunk）。这些是排序先验，不是闸门。
6. **可核验**：每条结果返回 `source_id/title/position`（文档）或符号的 `path:line`，或 insight id —— 与 DSH「每页 30 条、结果带引用」的体验对齐。

一处**别抄**：它按层分开调用再合并，是为了绕开「20k doc 条目把十几条 insight 挤出去」。在 SQL 里直接用「每层各自 top-k 的 UNION ALL」达成同一效果，不需要学它的多层适配器结构。

### P4. embedding 从哪来（proposed，含取舍）

现状（引自 `docs/self-hosted-memory.md`）：`chunks.embedding` 是 `vector(1536) NOT NULL`，但**今天没有人算 embedding**；DSH 插件侧走的是本地 256 维小表（`vectors.json` 的 `dim:256`、`model:"l1:…"`），并且作者明确说它**只重排、不做主力**。三条路线：

| 路线 | 维度 | 成本 | 优点 | 风险 / 代价 | 建议 |
| --- | --- | --- | --- | --- | --- |
| A. 复用现有 1536 的云 embedding | 1536（`chunks` 已定死） | 按量计费 + 出网 | 与既有 `chunks` 同一列同一模型，`documents`/符号/记忆可共用一次检索融合 | 每条记忆都要出网；自托管离线部署直接不可用；模型漂移要重算全库 | 只在「已有云 key 且接受出网」的部署里开 |
| B. 本地小模型（384/768，如 bge-small / e5-small） | 新列维度自成一体 | 一次性模型体积 + 常驻内存 | 离线、零调用费、隐私边界干净 | 与 `chunks.embedding(1536)` **不同维度**，不能同列比较；要给它单开一列或改 `chunks` 维度 | 自托管主推；给记忆层单开 `vector(384)` 列，不与 `chunks` 混算 |
| C. 先纯词法（tsvector + bigram），向量后置 | — | 零 | 立刻上线、可解释、可审计；DSH 的实测显示本类查询词法够用 | 同义改写/零词重叠查询召回不到（要靠人工 `SYNONYMS` 补） | **第一步就走这条**，把 `vectorAlpha` 做成开关，向量只是重排 |

推荐落地顺序：C → B →（有云 key 的部署）A。理由与 DSH 的取舍一致：闸门交给词法，向量只改排序，这样「换 embedding 模型」不会让召回闸门漂移 —— 这是它原文里反复强调的性质。

### P5. 会话保持（proposed）

DSH 的做法可以拆成三件事，CCP-Bot 需要自己实现前两件、第三件要新建：

1. **会话事件日志**（宿主已有，CCP-Bot 没有）：`conversation_messages` 按 `(conversation_id, seq)` 追加。用途与 DSH 的 `session.v4.jsonl.zstd` 相同 —— **事实源**，用于回放、审计、重建投影。DSH 用多帧 zstd 压 JSONL（可复现的解压坑见上半第 8 节）；CCP-Bot 直接进 Postgres 行，需要归档时再压。
2. **状态投影**（DSH 的 projcache）：不要把所有状态塞进消息流让每步重算，而是维护几张可覆盖写的投影 —— `conversations.workspace`（工作目录、模型、权限、sandbox 模式）、`agent_tasks.steps`（todo 投影）、`conversation_summaries`（滚动摘要）。投影行的语义与 DSH 一致：**可重建**，丢了能从事件日志重算。
3. **上下文重建顺序**（proposed，直接对应它 per-step 注入的语义）：`system/agent 人设` → `常驻任务卡`（绑定任务的标题+steps 状态快照）→ `近期消息（按 token 预算从新到旧）` → `摘要层（更早的对话压成一段）` → `本次注入的记忆块`。注入块作为**一条独立消息**追加（不要塞进 system），并带上 `source`，这样：模型能看见生产者；自己写的注入块能被识别出来而不被当成新的「用户查询」；审计能按消息定位。

**要不要摘要层：要，但要“按需生成、只压不删”**。理由：不设摘要层，长会话只能丢历史（丢的是事实），或者无限增长（预算爆掉）；DSH 侧对应的机制是「上下文压缩 + 交接」由宿主负责，记忆插件只负责**跨会话的持久事实**，两者职责不能混。所以 CCP-Bot 的分工建议是：`conversation_summaries` 负责**会话内**的滚动压缩（按 seq 区间、可重算），`memory_insights` 负责**跨会话**的教训/决策/流程，`agent_tasks` 负责**跨会话的任务状态**。三层各管一段，互相不复制。

**任务续接**：照抄「一张会话→任务映射表 + 反向灌回 todo 投影」这两步（`agent_task_bindings` + `steps → todo`），这是它「跨会话续接」的全部实现，没有更玄的东西。

### P6. 落地顺序与验证（proposed）

1. **迁移**：新增 P1 的表（一个 drizzle 迁移即可，`chunks`/`documents` 不动；记忆层若用向量，**单开列**，不改 `chunks.embedding` 维度）。
2. **写路径**：`save_lesson`/`remember` + 去重事务 + `recordHit` + `forget`（含 `memory_deleted`）。验证：`insert` 同一知识改写版 → 期望 `merged/auto-merged`；再写一个近邻 → 期望拿到 `near` 提示；`forget` 用宽泛词 → 期望**不删**只返候选。
3. **检索**：`search_text` 生成列 + GIN；先纯词法上线（`vectorAlpha=0`），把 P3 的闸门与裁剪按审计字段原样落库。
4. **注入**：在 agent 每步的 pre-step 位置追加记忆块（CCP-Bot 侧有真正的 hook，不必像 DSH 那样只能蹭 `agent/pre-step`），带 `source`；同时写 `memory_injections` / `memory_retrieval_shadow`。
5. **验证闭环**：用 `memory_retrieval_shadow` 离线重放 —— 这是它两份审计里最值得学的一招：**每步记录全部候选 + 特征 + 被卡在哪一层**，阈值调整就能在历史数据上重放而不必重跑真实会话。
6. **回滚**：注入失败必须降级为「不注入」并只打日志（照抄它 `auto-inject skipped` 的处理）；写盘前密文过滤照抄；`archived` 是软删，`memory_deleted` 是真删的最后一道保险。

### P7. 一句话总结要抄什么

抄 **实体模型**（4 种 kind × 3 级 scope × 唯一实体 + prev + archived）、**写路径的三带去重 + 提升 + 曝光记账**、**闸门与裁剪的分离**（词法/支持度管准入，向量管排序）、**两份审计 + 离线重放**、**任务桥的两张表**；不抄 **文件分片 + 进程内锁 + 内存预算补丁**（那是单进程嵌入式形态的代价），也不抄它的 **256 维本地小表**（CCP-Bot 的向量取舍按 P4 自定）。

---

## 证据索引（按上半小节）

| 结论 | 证据路径 |
| --- | --- |
| 插件位置/版本/依赖 | `C:\Users\Damon\.dsh\profiles\desktop\package.json`、插件 `package.json:1-115` |
| 生效配置 | `profiles\desktop\cordis.patch.yml`、插件 `cordis.patch.yml`（19 行） |
| 配置 Schema 与默认值 | `src\index.js`（`Config`）、`src\insight-store.js:48-75` |
| 实体模型与字段语义 | `src\types.js`（63 行，JSDoc） |
| 去重/强化/覆盖阈值与来源 | `src\insight-store.js:53-58, 73, 775-797, 846, 864, 884, 913, 960`；`src\similarity.js`（52 行） |
| 衰减与曝光记账 | `src\insight-store.js:314-351, 396-413, 420-430` |
| 删除与 `deleted.json` | `src\insight-store.js:571-574`；`src\tools\forget.js:35` |
| 密钥过滤 | `src\insight-store.js:21-30` |
| 索引计划与 CAS 提交 | `src\index-pipeline.js`（120 行） |
| 切块/词项/符号 | `src\chunker.js`（84 行）、`src\doc-index.js`（71 行）、`src\symbols.js:1-70` |
| 读到即记忆 | `src\lazy.js`（96 行） |
| 根推导与危险根 | `src\util\fs.js:560-704`、`README.zh-CN.md:150,154` |
| 注入缝与消息形状 | `src\auto-inject.js:1-74, 704-843, 907`；真机 `session-49298e3d-…` 事件日志 |
| 门槛/预算/额度 | `src\auto-inject.js:76-138, 305-319, 321-468, 481-591, 607, 637, 856-919` |
| authored trigger 与防伪 | `src\readiness.js:27, 74, 115, 133, 182, 207, 231, 243, 256, 278` |
| 召回与融合 | `src\recall.js`（347 行）、`src\util\search.js`（256 行）、`src\util\session-cache.js`（72 行） |
| `query_memory` 契约 | `src\tools\query-memory.js`（245 行，读 1-70） |
| 任务桥 | `src\setup\taskbridge.js`；`D:\Project\Claude-Codex-Pro-Tool\.dsh-project-memory\tasks.json`、`binding.json` |
| 两份审计 schema | `D:\Project\CCP-Bot\.dsh-project-memory\injection-audit.jsonl`(21 行)、`admission-shadow.jsonl`(324 行) |
| 宿主会话持久化 | `C:\Users\Damon\.dsh\sessions\--D-Project-CCP-Bot--\…\session.v4.jsonl.zstd`、`C:\Users\Damon\.dsh\storages\session_projcache\sessions\…json` |
| global 层落盘 | `C:\Users\Damon\.config\dsh-project-memory\global.json`（5111 B，3 条） |
| CCP-Bot 库表基座 | `server\drizzle\0000_schema.sql:10, 85-92, 139-150, 161-171, 391-406` |