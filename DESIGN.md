# 设计说明：dsh-plugin-dsh-sync

## 目标

两台安装了 DSH、登录同一 DeepSeek 账号、处于同一局域网的电脑，在没有人值守的情况下保持数据一致：会话、工作区、设置、插件与附件。没有云、没有中心服务、没有账号密码交换。

## 为什么是「文件级 + 内嵌引擎」

DSH 的全部持久状态最终都落在 `$DSH_HOME` 的文件里：会话是追加式 JSONL（zstd 帧），工作区/日程是 JSON，插件与设置是 profile 目录里的 YAML/JS。走官方 `ctx.sessionPersistence` 与 `ctx.storageDomain` 需要每个域单独适配，且无法覆盖任意插件数据；文件级同步一次覆盖全部，并对未来新增的数据目录保持宽容。

代价是必须自己处理「正在写入」和「两边都改」的问题，这正是引擎的主要复杂度。

## 架构

```
┌──────────────── Device A ────────────────┐        ┌──────────────── Device B ────────────────┐
│ index.js (apply)                         │        │ index.js (apply)                          │
│   ├ Identity  ─ device.json / trust.json │        │   ├ Identity                              │
│   ├ SyncEngine                           │        │   ├ SyncEngine                            │
│   │   ├ FileIndex  ─ index.json          │        │   │   ├ FileIndex                         │
│   │   ├ Journal    ─ journal/<peer>.json │        │   │   ├ Journal                           │
│   │   ├ SyncServer ─ :47822 (TCP)        │◀──────▶│   │   ├ SyncServer                       │
│   │   └ Discovery  ─ :47821 (UDP 组播)   │  HTTP  │   │   └ Discovery                         │
│   └ Panel route /plugins/.../panel       │  AES-GCM│   └ Panel route                          │
└──────────────────────────────────────────┘        └───────────────────────────────────────────┘
```

引擎是**拉取式**的：每个周期向每个已配对设备请求各同步集的 manifest，然后按纯函数规则决定每个文件是「拉」「合并」「保留本机」还是「记冲突」。双方跑同一套规则，因此不需要协调者，也不需要推送确认。

## 协议

### 发现

UDP4，绑定 `0.0.0.0:47821`（`reuseAddr`），加入 `239.255.77.77`，同时向广播地址与 `seeds` 单播。每 4 秒发一次：

```json
{ "v": 1, "proto": 1, "deviceId": "…", "name": "PC-A", "group": "…", "port": 47822, "ts": 0 }
```

20 秒未见即从列表移除。`deviceId` 与自身相同则忽略。组播被交换机/防火墙拦截时，用 `seeds: ["192.168.1.20:47821"]` 兜底。

### 配对

1. `POST /hello`（明文）：交换 `deviceId / name / publicKey / group`。
2. 双方用 X25519 求共享密钥，`SAS = SHA256(shared || sorted(pubA,pubB))` 取前 4 字节 mod 1e6，补足 6 位。
3. 人工比对一致后，各自 `trustPeer()` 把对端公钥写入 `trust.json`。
4. 之后所有 RPC 要求 `from` 在信任库中且公钥哈希与 `deviceId` 一致。

### RPC

只有两个端点：

- `POST /hello` — 公开身份。
- `POST /rpc` — `{ from, payload }`，`payload = AES-256-GCM(HKDF(shared, transcript), JSON)`。

`transcript` 使用排序后的双方公钥，保证两端派生同一密钥。密钥按 `enc`/`mac` 两个 info 派生。请求时间戳超出 ±10 分钟拒绝。

操作：

| op | 参数 | 返回 |
| --- | --- | --- |
| `ping` | — | 名称、组、端口、集合 |
| `manifest` | `set` | `{ entries: { rel: [size, mtime, sha256] }, deletes: { rel: [at, sha256] } }`，服务端先刷新该集合的索引 |
| `pull` | `set, rel` | `{ s, m, h, data: base64 }` |

传输为一次性 JSON，单文件上限 `maxBlobBytes`（默认 48MB）。没有分块，因为 DSH 的会话通常只有几百 KB 到几 MB；超限文件会在日志中报 `too-large`。

## 同步集

`src/paths.js` 定义集合边界与忽略规则：

- 忽略任何层级的 `node_modules`、`logs`、`backups`、`conflicts`、`dsh-sync`、`.git`，以及 `*.tmp`、`*.lock`、`*.bak*`、`*.conflict-*`；`modules` 集通过 `isIgnoredForSet()` 单独放行 `node_modules`。
- `profile` 集只收 `package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml` 与整个 `plugins/`，避免抓走 `.plugin-manager` 与锁文件；`plugins/` 的一级 junction 会解引用（见下）。
- `modules` 集镜像 profile `node_modules` 的真实目录包（跳过链接/原生二进制/`.pnpm` 等），`credentials` 集只收 `$DSH_HOME/.credentials.yaml`。
- 插件自己的状态目录 `<home>/dsh-sync` 永不参与同步，否则索引/日志会自指。

路径安全：所有远端路径经 `joinInside()`，拒绝 `..`、盘符、UNC、绝对路径；符号链接不进入扫描。

## 哈希与索引

`index.json` 记录每个文件 `{size, mtimeMs, sha256}`。刷新时：

- size/mtime 未变 → 复用旧哈希；
- 文件在 `stableAfterMs` 内被修改 → 继续复用旧条目（宁可晚一轮，也不发布半截文件）；
- 否则流式 SHA-256。

扫描与哈希并发度 6，大文件受 `maxBlobBytes` 限制。

## 决策矩阵（`src/merge.js`）

输入：本机条目 `local`、对端条目 `remote`、上次同步水位 `base`（`journal/<peer>.json`）。

| 条件 | 动作 |
| --- | --- |
| 两边哈希相同 | `EQUAL`，更新水位 |
| 本机无、对端有 | `PULL` |
| 本机有、对端无 | 保留（不传播删除） |
| 本机未变、对端变了 | `PULL` |
| 本机变了、对端未变 | 保留（对端下一轮会拉走） |
| 都变了，`merge-workspace` | `MERGE` |
| 都变了，`append` | `PULL` → 进入前缀检查（可能是纯追加，也可能分叉） |
| 都变了，其它 | mtime 大者胜；相等用 `deviceId` 字典序，保证两端结论一致 |

冲突被记录后，水位带 `divergedH`；只要对端文件还是那一版、本机也没变，就一直 `SKIP`，不会每轮重复产出冲突副本。

## 会话文件的特殊处理

DSH 的 JSONL 会话是**只追加**的：

- 远端是本机的严格前缀 → 只 `append` 尾部字节。zstd 帧可拼接，DSH 扫描时按帧读取。
- 本机是远端的前缀 → 本机领先，不动作。
- 两边都不是对方前缀 → 分叉：
  - 本机文件完全不动；
  - 远端整份写入 `<会话目录>/conflicts/`；
  - 水位记录 `{ h: 本机哈希, divergedH: 远端哈希 }`；
  - 面板显示冲突条目。

**为什么不在会话打开时写入**：后端给事件分配递增序号并在内存里维护写入句柄；外部追加会让进程内序号与文件不一致，下一次写入可能产生重复序号。引擎通过宿主注入的 `hooks.isSessionLive(sessionId)`（`ctx.sessions.get`）判断，本机打开中的会话一律延后，等关闭/重启后再合并。这是正确性优先的取舍。

## 工作区合并

`storages/workspace.json` 是唯一做结构合并的文件：

- `global.workspaceIds` 取并集；
- `global.archivedSessionIds / pinnedSessionIds` **只保留本机**，不并入对端——归档/置顶是每台机器本地的界面状态，并集会把对方正在用的会话归档掉，DSH 随即从工作区列表里隐藏它们（0.4.1 及更早的数据丢失表现）；
- `tables.workspaces` 按 id 并集，同 id 取 `updatedAt` 较新者，`sessionIds` 并集，`createdAt` 取更早、`updatedAt` 取更晚；
- `defaultWorkspaceId` 优先保留本机。

合并结果序列化后写回，哈希变化会让对端在下一轮拉走，最终两边一致；两边的归档/置顶列表允许长期不同，这是刻意为之。

本地文件存在但**不合法 JSON** 时不做合并：本机原文保留，对端版本另存 `.conflict-*` 并记 `invalid-local` 冲突，避免把可能唯一的一份设置覆盖掉。`profile/package.json` 同理（0.4.2 起）。

## profile 清单合并

`profiles/<profile>/package.json` 的合并同样是「本机全保留 + 对端新增项过滤」：bundle 需要本机 `node_modules`/DSH 安装目录里能解析，`link:`/`file:` 依赖需要目标存在；被跳过的条目记 `bundle-unavailable` / `dependency-unavailable` 冲突。解析逻辑由引擎注入（`src/bundles.js`），`merge.js` 保持纯函数，便于单测。

## 插件依赖同步（modules，0.4.3）

profile 集只镜像声明与 `plugins/` 源码，pnpm `hoisted` 布局下真正的包在 `node_modules/` 里。只有 A 装插件时 B 会「有声明没包」，所以新增 `modules` 集：

- 根目录仍是 `profiles/<profile>`，`include: ['node_modules']`，并带 `allowNodeModules: true`；`IGNORE_DIRS` 里的 `node_modules` 对所有集合生效，只有该集通过 `isIgnoredForSet(rel, set)` 放行（剥掉 `node_modules` 段后仍应用常规忽略规则）。
- `listFiles` 跳过符号链接/junction，因此 pnpm 的链接、插件目录 junction 不会被索引；`exclude` 跳过 `.pnpm/.bin/.ignored/.modules.yaml/.pnpm-workspace-state-v1.json` 与原生二进制、source map。
- 该集 `deletesEnabled === false`（永不传删除、不写墓碑），回写时跳过 `.bak-sync-*`（体积翻倍没有恢复价值）。
- 每个 peer 每轮有 `maxModulesBytes` 预算（默认 256MB）：先按清单声明大小预扣，超限剩余文件延后一轮，并记 `modules-over-limit`（每 peer 每轮一条）。
- 拉取路径 `fetchRemote()` 统一校验 `maxBlobBytes`：清单声明与响应实际大小都要 ≤ 本机上限，否则抛错计入同步错误（不静默收下大 payload）。

## profile 自愈（0.4.3）

`repairLocalProfile()` 在每个同步轮末尾运行，纯本地、离线可用、幂等：

1. 解析失败 → 不写盘（可能唯一副本）；
2. `link:`/`file:`/`portal:` 依赖：目标存在 → 建/修 `node_modules/<name>` 的 junction（只删链接本身；已解析到同一物理目录的链接保持不动；目标必须在本机 profile 内）；目标不存在 → 删链接、删依赖声明；
3. `plugins/<name>/package.json` 存在但清单没有声明 → 自动补 `link:./plugins/<name>`（0.4.4，用于接收 junction 解引用过来的源码）；
4. 链接可解析的插件补进 `dsh.profile.bundles`；
5. 无法解析且无 `plugins/<name>` 源码的 bundle 声明移除（`@deepseek-ai/*` 保留），记 `bundle-pruned`；
6. 有改动才写盘：备份 `package.json.bak-prune-*` + UTF-8 无 BOM + 更新索引。

`sets.json` 随之升级（v1→v2 打开 `modules`，v2→v3 打开 `credentials`，要求 `profile` 开启）；`setSets` 去掉 `profile` 会同时关闭 `modules`。

## 插件源码 junction 解引用（0.4.4）

profile 集的 `plugins/**` 由 `listFiles` 逐文件索引，而 `listFiles` 有意跳过符号链接/junction。开发者常把 `profiles/<profile>/plugins/<name>` 链到 profile 外的源码目录（本机 npu / companion-memory 就是 `D:\工作区\<name>` 的 junction），于是对端永远收不到这些插件。

`FileIndex.refresh()` 对带 `dereferencePluginLinks` 的集（目前只有 profile）额外做一次「一级解引用」：

- 只枚举 `<root>/plugins` 的**直接子项**；是 symlink/junction 且 `realpath` 为可读目录时，用 `listFiles(realTarget, …)` 列出目标内文件；
- rel 统一改写成 `plugins/<name>/…`，filter/shouldEnter 用改写后的 rel 判断，因此 `plugins/**/node_modules/**`、`*.node`、`.git` 等既有排除照常生效；
- 目标内部的二级链接仍由 `listFiles` 跳过；目标不存在/不可读 → 跳过并 `log warn`；
- 写回时若本机该 rel 仍经过 junction，写入会落到源码目录（LWW 语义），文档已提示开发插件注意。

## 模型块定向合并（0.4.4）

`cordis.patch.yml` 既含机器相关配置（NPU 路径、端口）又含用户模型设置。0.4.4 起不再整文件保护，而是由纯函数 `src/modelconfig.js` 只合并白名单块：

- `parsePatchBlocks()` 按行切顶层列表项（`- ` 开头），块范围**不含尾部空行**，因此块外字节（空行、注释、其它块）在替换时逐字节保留；
- 白名单按 `name:` 匹配 `@deepseek-ai/dsh-agent-default-model` 与 `@deepseek-ai/dsh-llm-*`；
- 按块三方合并，base 存 journal 的 `cordis.patch.yml::<name>` 键；首次/仅对端改 → 采用对端；仅本机改 → 保留本机；双方改 → 保留本机 + conflict；
- 引擎只在 `changed` 时备份 `cordis.patch.yml.bak-model-*`、写回（无 BOM、保留 EOL）并整文件记 `{h, divergedH}` 驻留；不再产生整文件 `.conflict-*`。
- 这条路径**不经过 `decide()===PULL` 门控**（DSH 运行时回写会让本机 mtime 更新，按 LWW 会静默不同步）；是否合并只由块级 base hash 决定，合并后驻留、对端文件未变时不重复拉取。无 base 的块只在「对端文件 mtime 更新」时采用，避免两端互相采用对方的旧块。

## 凭据同步（0.4.4）

`$DSH_HOME/.credentials.yaml` 混合了「可跨机」的模型 API Key 与「绝不能跨机」的设备/OAuth token 和账号 ref。纯函数 `src/credentials.js` 用行级解析（不引入 YAML 依赖）实现：

- 找到顶层 `refs:` 段，按 `^  ([A-Za-z0-9_.-]+):` 识别 ref 行并保留原始整行；
- 只处理名字匹配 `/API_KEY$/i` 的 ref：本机缺失 → 追加对端整行；值不同 → 保留本机 + `credential-conflict`（只记 key 名）；多行/块标量 → `credential-skipped` 不自动合并；
- `records:` 段与其它 ref 逐字节不动；本机文件缺失时创建 `version: 1` / `records: {}` / `refs:` 的最小文件，绝不整文件复制；
- 写前检查 mtime 稳定窗口（运行中的 DSH 会内存态回写），改动才备份 `.credentials.yaml.bak-sync-*`、写回、更新索引、journal 记 `{h, divergedH}`；删除永不传播。
- `syncPeer` 对 `merge-credentials` 集绕过 LWW 门控：两边哈希不同且未驻留分叉时直接增量合并（只加缺失的 API Key、不覆盖本地值），合并后驻留避免重复拉取。

## RPC 路径白名单

几个集合的 root 比较宽（`credentials` = `$DSH_HOME`，`profile`/`modules` 共用 profile 目录），只用 `joinInside()` 会让已配对对端通过 `rel` 读到/改写任意文件。因此 `setAllowsRel(set, rel)` 用与索引相同的规则（`isIgnoredForSet` + include + exclude）校验，并在 `handleRpc` 的 `pull`/`push`、`applyPushedFile`、`applyPull` 四处强制；`applyCredentials` 额外断言 rel 必须是 `.credentials.yaml`。越界统一 `invalid-path`。

`sets.json` 升到 v3：v1 文件打开 `modules`，v2 文件打开 `credentials`（均要求 `profile` 开启），写回 `{version: 3}`。

## 跨机 RPC broker（`dshSync`，0.5.0）

其它插件（影子工作区等）不应重复实现发现/配对/加密，因此 `src/broker.js` 以 Cordis 服务暴露一层最小 API，engine 本身不外泄：

- 插件入口在 `apply()` 里同步 `ctx.provide('dshSync', api)`（`getEngine` 用闭包 getter，engine 在异步 boot 中创建）；`ctx.provide` 不存在时只 warn。
- 客户端 API：`identity()` / `peers()` / `rpc()` / `registerRpc()` / `onPeerEvent()`；`rpc()` 只允许 `ext.*` op，复用 `PeerClient`（每次新建以适配端口变化），默认 10s 超时，未配对/离线抛带 `code` 的错误。
- 服务端：`handleRpc` 在内置 op 之后、`unknown-op` 之前把 `ext.*` 交给 `engine.setExtRpcHandler()` 安装的 hook。broker 依次断言：授权（见下）、`ext.` 命名、已配对 + publicKey 一致、op 已注册、请求 ≤1MB；执行 handler 后校验响应 ≤8MB；日志只记 op/设备/字节数。
- 授权模型叠了三层：插件可用 `registerRpc(op, handler, { allow: true })` **自声明**该 op 可被已配对设备调用（0.5.1，装完即用、只限该 op、随 dispose 回收）；用户侧 `extRpcAllow`（op 全名、`prefix*`、`*`）是第二道可选闸门；`extRpcDisableAll: true` 是最外层总开关，优先级最高、一律拒绝。三层都没有 → `ext-disabled`。这与 credentials 越权事件同一思路：新增能力默认 off，但允许插件以最小粒度自声明，避免逼用户手改受保护的 profile 文件。
- 生命周期：hook 返回 dispose；broker.dispose() 清空 op 表、隐式放行集合与事件订阅；两者都挂在插件 entry 的 dispose 上，随 refs 归零回收。

## 一致性模型

- 每个文件是独立单元，没有跨文件事务。
- 传播是最终一致的：A 改动后，B 在下一轮（≤15s）看到；B 再改，A 再下一轮看到。
- 「最后写入者优先」依赖 mtime；跨机器时钟偏差会改变胜负。已知限制，不引入 HLC（文件 mtime 本来就是用户可见语义）。
- 删除通过墓碑传播，但只在普通文件集合（`lww` 且非 `workspace`）：会话日志与工作区索引永不删除。

### 删除

本地刷新索引时，上一轮存在、这一轮消失的文件会记入 `tombstones.json`：`{ set, rel, hash, at }`。清单随 manifest 下发后，对端只有在同时满足以下条件时才删除本地副本：

1. 该集合允许删除传播；
2. 本机文件仍存在，且 mtime 不晚于墓碑时间（排除「删了又建」）；
3. 对该设备存在同步水位 `base`，且 `base.h === tomb.h === local.h`（排除从未同步过的独立文件，以及删除后被改过的文件）；
4. 文件内容哈希与墓碑一致。

任一条不满足：保留本机文件；哈希不一致时记一条 `delete` 冲突提示。若删除后对端又修改了文件，同步侧会先看到「本机没有、对端有且哈希不同」，撤回自己的墓碑并把对端版本拉回来，同时记一条 `resurrect` 提示——删除输给修改，避免误删新内容。

墓碑保留 45 天，最多 5000 条。根目录整体消失（权限、挂载问题）不会产生墓碑：索引刷新直接保留上一轮快照。

## 安全

- 每设备 X25519 密钥对，私钥只存本机 `device.json`。
- 配对前不能读任何数据；`/hello` 泄露的只有设备名、组标签、公钥。
- GCM 同时提供机密性与完整性；篡改会解密失败。
- 面板路由复用 DSH GUI 的 `connection.requestRejection`，无 cookie 时只接受回环地址。
- 扩展 RPC（`ext.*`）默认关闭，授权 = 插件 `allow:true` 自声明 ∪ `extRpcAllow` 配置，`extRpcDisableAll` 可一键全关；只接受已配对设备、请求/响应有大小上限，日志不含 payload；`dshSync` 不暴露 engine。

## 失败与恢复

- 索引/水位写盘为原子替换；崩溃最多丢失一轮同步进度。
- 写文件用同目录临时文件 + `fsync` + `rename`，读取方不会看到半截 JSON。
- 对端文件在传输期间变化 → 校验失败 → 下一轮重试。
- 端口被占用：`/rpc` 与发现失败只记录日志，插件仍可加载（面板显示错误）。

## 后续

- 分块传输与断点续传（大附件）。
- 会话分叉的人工合并 UI（选择保留哪一段）。
- 更高频的变更触发（`fs.watch` 去抖）替代固定轮询。
- 插件原生二进制/平台包（`*.node` 等）不传输，需要目标平台自行 `dsh plugin install` 补装。
- 传输限速与同步窗口（仅 Wi-Fi/仅充电）。
