# Changelog

## 0.10.25

- **影子会话 composer 的三个"外观件"接通为真实功能（B 端截图反馈）**
  - **权限选择**：左下角权限 chip 不再是静态文字。点击弹出原生风格菜单（`仅可查看 / 工作区内修改 / 完全权限 / 自动审查 EXP`，主机自定义预设按原生规则标题化），当前项打勾；选择「完全权限 / 自动审查」先弹出风险确认（必须勾选「我已了解风险」才能确认，和原生 `RiskConfirmation` 一致）。改动经新增 `ext.shadow.permissions`（`op: catalog | set`，高危预设必须 `confirmed: true`）落到对端 Host 的 `permissionPresets` 服务，并追加原生同款 `permission/preset` + 沙箱/审批事件；对端是旧版时 chip 保持只读，不会假装可点。中文文案对齐原生「工作区内修改」（原来是「工作区写入」）。
  - **文件/图片上传**：`+` 打开原生风格「添加」菜单（图片或文件… / 推送文件到对端…）。选中文件后在 composer 卡片内出现附件栏（图片缩略图 / 文件卡、大小、上传进度、移除），按 512 KiB 分块经新增 `ext.shadow.attach` 暂存到对端；发送时 prompt 只携带 transferId，由对端把图片内联为规范 base64、普通文件经 Host `fileUploads` 换成回执后交给 Session Controller —— 与原生 composer 完全同一条附件准入链路。失败保留暂存可重试，超限（64 MB/个、20 个/条）在客户端先拦。
  - **语音输入（麦克风）**：点击麦克风在原地展开录音条（录音中 · 计时 · 取消 / 停止），停止后浏览器内 `MediaRecorder` 录音 → OfflineAudioContext 重采样为 16 kHz 单声道 PCM16 WAV → 经插件自有 Host 路由（新增 `shadow/src/speech.js`，调用本机 `speechToText` 服务；请求体上限单独放宽到 8 MB）转写 → 文字插入草稿，不自动发送。模型未准备时显示「下载并准备」引导并轮询准备进度；本机没启用语音 Bundle 时如实提示。对端/本机不支持时不会崩溃。
  - 客户端能力由 `info`/`localEvents` 批次的 `capabilities`、`attachmentLimits` 下发（全部 additive，`PROTOCOL_VERSION` 仍为 1；0.10.24 对端照常可用）。
- **修复：已回答的审计表单卡在输入框上方不消失**：删除了 composer 上方常驻的「已回答」卡（`answeredQuestions` / `QuestionAnsweredCard`）。现在与原生一致——提问卡在 Host 接受回答后立即消失，回答记录落在转录里持久的 `ask_user_question` 工具行上：标题「提问」、摘要「{n}/{m} 已回答」，展开可看每题答案（未答显示「未回答」）。审批卡仍按原逻辑保留（审批只有 transient）。
- **修复：思考 / 工具调用流不跟随时最新消息**：滚动跟随改为原生同款逻辑——真正滚动容器在运行时解析（`[data-conversation-scroll]` 或实际溢出的祖先），阈值 25px；每次提交都贴底，`ResizeObserver` 补住图片/字体/布局回流，用户滚轮/触摸离开底部才解除并显示「回到底部」，点它立即回底并重新跟随。过程组（思考/工具）运行中自动展开并保持展开，组内独立滚动条也始终停在最新一条操作。
- **测试**：`node --test` **189 全绿**（新增 `test/shadow-composer.test.js`，覆盖权限文案、附件分类、问答行模型、16 kHz WAV 头/采样、工具分类；Host 侧 `test/shadow-bridge.test.js` 新增 11 条权限/附件/语音桥测试）。无头真实 React 复刻台新增 `_chat_harness/controls_probe.js`：权限菜单→风险确认→设置、`+`→选文件→分块上传→发送携带附件、麦克风录音→转写插入、问答行展开、滚轮离开底部→回到底部→继续跟随，全部通过；`degraded_probe.js` 覆盖旧版对端与语音未准备两条降级路径。
- **A 端**：本机 profile 插件目录（`…\profiles\desktop\plugins\dsh-plugin-dsh-sync`，真实副本而非 junction）已整目录备份到 `dsh-plugin-dsh-sync.bak-0.10.25-20261027-192359`（86 文件）后覆盖为 0.10.25（111 文件，保留原 `.bak-sync-*` 等 25 个旧文件）；profile `package.json` 未改。校验：version=0.10.25、client.js sha256 `5270AE67…4BDFBC`、`shadow/src/speech.js` sha256 `97784998…F32084`、`PLUGIN_VERSION='0.10.25'`。
- **B 端**：发布包 `dist/dsh-plugin-dsh-sync-0.10.25.zip`（sha256 `B971772A6CB3D19DE40DB0189F6095D544BC1828DFE7B548070FC3839DB608FA`）已推到 B 的 `shadow-uploads` 并由 B 端 agent 安装校验：备份 `…\plugins\dsh-plugin-dsh-sync.bak-0.10.25-20261027-191931`，77/77 文件哈希一致，version=0.10.25、client.js sha256 `5270AE67…4BDFBC`、`shadow/src/speech.js` sha256 `97784998…F32084`；未运行 install.ps1、未改 profile `package.json`、未删任何 `.dsh` 目录。**A、B 两台 DSH 都需重启一次**（新增的 `ext.shadow.permissions` / `attach` / `voice` 与语音桥是 Host 侧代码，重启后生效；影子会话页面刷新即可拿到新 client）。

## 0.10.24

- **影子工作区改为顶部对齐：紧贴原生会话列表尾部**（之前误做成侧栏底部对齐）。停靠目标从 `regionArea`（列表与 footer 之间的 flex 容器）改回**原生会话列表自身的滚动容器**：影子块作为该列表的最后一个子节点，与原生会话/分组同处一条文档流，顶部紧接最后一个原生会话（例如「展开其余 5 个会话」下方 8px），不再被 `flex:1` 推到 footer 上方；列表内容多时随列表一起滚动，footer 与影子块之间保留空白。
  - 目标选择：在 `aside` 内由近及远找**包含全部原生会话行的最外层滚动容器**，避免选到会话行内部的局部滚动节点，也避免跨到页面根滚动容器。
  - `MutationObserver` 继续保证影子块是该容器的最后一个子节点（对端分组异步 append 时自动归位）。
  - 回退：探测不到列表容器时仍用 fixed 悬浮（按 `_footArea` 实测高度定位）。
- **测试**：`node --test` 151 全绿。
- **B 端已更新**：推送 `dsh-plugin-dsh-sync-0.10.24.zip`（sha256 `CB77E69CEC92F7467EF03673A38AFEA3A1AB6A73124D47EF1FAFA96820BDF74A`）→ B agent 回报 `installed version=0.10.24 client.js sha256=11B3C16A7FBBE23C094292A84BAE6CFE185AF92684115FE50EB6138374FDE948`，并确认：影子工作区紧贴在原生会话列表最后一项（「展开其余 N 个会话」）下方，顶部对齐、左边距一致，作为列表滚动容器末尾的普通块随列表滚动，不再固定于侧栏底部/页脚上方。截图见 `docs/shadow-launcher-top.png`。

## 0.10.23

- **模型/推理等级弹层对齐原生二级、三级界面（B 端截图对比）**
  - 一级：紧凑弹层两行 `模型  <当前模型>  ›` / `推理等级  <当前强度>  ›`（232px 宽、40px 行高、label 13/500、值 `label-tertiary` 右对齐、右侧 `›` 箭头）。
  - 二级「模型」：304px 面板，顶部 `搜索模型…` 输入框（实时按名称/id 过滤，无结果显示「没有匹配的模型」），下面按 provider 分组（组标题 11px `label-tertiary`），当前模型行高亮底色 + 右侧勾选。
  - 二级「推理等级」：220px 面板，`Default / Low / High / Max`（Default 表示跟随模型默认，排在首位），当前项高亮 + 勾选。
  - 弹层位置改为锚定 **composer 卡片顶部**（原生同样浮在卡片上方，不压住输入区）；Esc / 外部点击 / 窗口 resize 关闭；菜单宽度、圆角、描边、阴影、模糊背景均沿用原生 menu 观感。
- **测试**：`node --test` 151 全绿；`_chat_harness` 走通「打开一级 → 模型二级（搜索过滤）→ 推理等级二级」并校验选中态、0 console 错误（注：无头页面的 SVG shim 不渲染图标，真机图标正常）。截图见 `docs/shadow-chat-model-menu-root.png` / `docs/shadow-chat-model-menu-models.png` / `docs/shadow-chat-model-menu-effort.png`。
- **B 端已更新**：推送 `dsh-plugin-dsh-sync-0.10.23.zip`（sha256 `2C715284FBF58EB1746A07314C09E2500339C30EA9D57503BDA2B8EB0A798CA2`）→ B agent 回报 `installed version=0.10.23 client.js sha256=EF4ED0F8C388241A432A2B108C26ECD8C17E364BC46FC1C797647E2EE5DD3F62`，并确认：点开先在根菜单出现「模型」「推理等级」两行；「模型」页带搜索框与 DeepSeek Account / 本机 NPU / opencode-go 分组；「推理等级」页为 Default/Low/High/Max 且当前 High 打勾。

## 0.10.22

- **Composer 的模型/思考强度显示对齐原生（B 端截图反馈）**：原来用两个原生 `<select>`，宽度会被「最长选项」撑开（模型名到 chevron 之间出现大空档），且与原生「一个紧凑触发器」的结构不一致。改为原生 InputBar 的单一触发器样式：`模型名 + 思考强度 + 单个 chevron`（`_select` 类，13px/500、`label-secondary`、height 28、右侧 12px chevron、hover 底色），宽度只跟当前标签；点击弹出原生风格菜单（按 provider 分组 + 「思考强度」分组，选中项高亮带勾，Esc/外点/resize 关闭）；右侧补上原生麦克风图标（未接入，置灰不可点），发送/停止仍是 34px 圆形。
- **修复运行中过程组反复展开/收起（B 端反馈）**：原来 `NcProcessBlock` 用 `processStats.running` 控制开合，而两次工具调用之间该值会短暂变 false，导致每个新工具/思考事件都把过程组收起再展开，直到 turn 结束。改为按 **turn 级 live 标志**（`running && 最后一轮`）决定：运行中自动展开并保持展开（标签也保持「正在…」不闪「已完成」），turn 结束自动收起为「已完成，用时 X」；用户手动点开的优先，不再被自动状态覆盖。
- **测试**：`node --test` 151 全绿；`_chat_harness` 校验 composer 触发器文本 `DeepSeek V4.1 Flash High`、mic/send 图标存在、0 console 错误。截图见 `docs/shadow-chat-composer.png` / `docs/shadow-chat-modelmenu.png`。
- **B 端已更新**：推送 `dsh-plugin-dsh-sync-0.10.22.zip`（sha256 `4BAD664E77307A014FE4CFDBC298994E834BA54783D912A7894D3C6E17BD0413`）→ B agent 回报 `installed version=0.10.22 client.js sha256=2A07647DDEC48B2B5E9FB1899271DA2A2A57E633A4F2EB4F7CFED5AF289F8390`，并确认新输入框控件：紧凑「模型名 + High + 单个箭头」、点开有 DeepSeek Account / 本机 NPU / opencode-go / 推理强度 Low·High·Max 分组菜单、右侧灰显麦克风（语音输入暂未接入），热重载已生效。

## 0.10.21

- **侧栏观感三处对齐原生（B 端反馈）**
  - 「展开其余 N 个会话」文字改回原生灰色（`label-tertiary`，运行时会读取原生同元素的计算色；不再被纯白规则染白）。
  - 「影子工作区」分组标题改回和原生「工作区」一样的灰色（`--dsw-alias-label-tertiary`，运行时取原生 `_sectionLabel` 实测色）；工作区名/会话名/时间仍为纯白；组头齿轮/刷新图标回到原生 `label-secondary` 灰。
  - 移除影子会话标题左侧的返回按钮（与影子工作区旁的设置按钮功能重叠，原生会话头也没有返回键）。
- **影子工作区设置页支持重命名对端工作区（仅本机显示）**：`显示对端` 列表每个对端工作区新增「重命名」按钮 → 行内输入框（Enter 保存 / Esc 取消 / 失焦保存）→ 自定义名称存 `localStorage['sdw-workspace-aliases']`（按 `deviceId:workspaceId`），侧栏分组标题、悬停卡片与设置页立即生效；副标题仍保留真实工作区名（`自定义 · 原名称`），清除名称即恢复官方名。代码里仍以对端真实名称为准，只是本机显示别名。
- **停靠方式改为侧栏 region area**：上一版把块停靠进原生工作区列表的滚动容器，但原生侧栏是「本地列表 + 对端账号列表」多个滚动容器，异步加载/切换会把块夹在中间或滚出可视区。0.10.21 改为把影子块作为 `regionArea`（原生工作区列表与 footer 之间的 flex 容器）的最后一个子节点：原生列表在上方 `flex:1` 内滚动，影子块 `flex:none` 固定在 footer 之上，任何窗口高度都不遮挡、不需要滚到列表底部才可见；`MutationObserver` 保持其为最后一个子节点，探测不到 `regionArea` 时回退 fixed 悬浮（底边按 `_footArea` 实测高度）。
- **测试**：`node --test` 151 全绿（新增工作区别名存取/清除单测）；无头 `_settings_harness` 验证重命名按钮 → 行内输入 → 保存链路；`_launcher_harness` 量到组头/展开行为 `rgb(173,178,184)`（= 原生 `label-tertiary`），与原生完全一致。截图见 `docs/shadow-launcher-finalside.png` / `docs/shadow-chat-header.png`。
- **B 端已更新**：推送 `dsh-plugin-dsh-sync-0.10.21.zip`（sha256 `B5068C9111F20F30DBC0452C1BE0DF2E4D4F39B9FA680E47D333E9ADA7FA638A`）→ B agent 备份/覆盖后回报 `installed 0.10.21 / client.js sha256 7A65F1ABDFDACC8603F8438A79861380216FE3D6E5A8D9343BEA50B2C36B6680`，并确认：侧栏「影子工作区」标题与「展开其余 N 个会话」已变灰（取自原生 `sectionLabel` / `sessionOverflowButton` 计算色）、工作区/会话名保持纯白、影子会话标题左侧已无返回按钮。

## 0.10.20

- **影子工作区不再遮盖原生工作区列表（B 端小窗口问题）**：原生 `sidebar.workspaces` 槽是 `kind=single` 且已被原生工作区列表占用，插件无法再注册第二个 section（第二个 entry 会被 abdicate）。改为把影子块**停靠进原生工作区列表的滚动容器**（探测包含全部 `data-row-key^="workspace:|session:"` 行、`overflow-y:auto/scroll` 的最外层祖先），并用 `MutationObserver` 保证它始终是最后一个子节点（对端工作区是异步加载的，否则会夹在原生 section 中间）。
  - 效果：影子块随原生列表一起滚动，**任何窗口高度下都不会覆盖原生工作区**；B 端低分辨率/小窗口不再出现「影子工作区压住工作区」的情况。
  - 兜底：探测不到原生列表时仍用 fixed 悬浮，但底边改为按原生 `_footArea` 实测高度定位（不再固定 `56px`），并新增 `data-*` 结构探测的失败降级路径。
- **影子工作区文本改为纯白**（`#fff`）：标题、工作区名、会话名、时间、图标在 A/B 两端一致为纯白，不再使用 `label-secondary/tertiary` 灰阶。
- **顺序与间距**：块在原生 section 之后、footer 之上，`margin-top` 6px；原生列表与影子块共用一个滚动条（hover 显示 thumb 的原生行为保留）。
- **测试**：`client.test` 断言保持 3 个 slot 注册（launcher 不再注册 `sidebar.workspaces`）；150 测试全绿。截图见 `docs/shadow-launcher-flow.png`。
- **B 端已更新**：推送 `dsh-plugin-dsh-sync-0.10.20.zip`（sha256 `43391C54493F66393C9F01A6F404FC36B8898B85441234643BA4AA1167F821C8`）→ B agent 备份/覆盖后回报 `installed version=0.10.20 client.js sha256=2692D5192AE0227F42A12AEB14C4D582432E60C121D6059FD9201AC72052FDE1`；B 端像素核对：影子标题/行文字 `max=255 · exactWhite=92/48`，原生标题 `max=251 · exactWhite=0`（纯白生效），并确认影子块位于原生列表之后、随列表滚动、不覆盖不夹层。

## 0.10.19

- **影子会话窗口 1:1 复刻原生 DSH 会话页**：聊天页不再用自绘 `sdc-*` 观感，而是按 `dsh-client-ui-conversation` / `dsh-client-ui-chat` / `dsh-client-ui-tool` 的真实 DOM + CSS module 类名重建，类名在运行时从当前构建的样式表发现（`<prefix>_<key>` 与 shell/primitives 的 `_<key>_<hash>_<line>` 两种形态；修复数字开头 hash 的发现、markdown 作用域二次锚定、`tableScroll` / `codeBlock` 原生类）。
  - **页面骨架**：`ConversationRoot` 结构（`root[data-phase=active]` → `header` 51px → `body` → `scrollBody[data-conversation-scroll]` → `viewArea` + `composerSeat`）；内容列宽按原生公式 `clamp(680px, bodyWidth × .64, 920px)` 由 ResizeObserver 写入 `--dsh-conversation-column-width`（1440 宽窗口 = 920px，卡片 = 952px），composer `sticky bottom` + 36px 渐变遮罩。
  - **Composer**：原生 `InputBar` 卡片（`--dsw-radius-panel` 28px、`--dsw-specific-input-major` 底、阴影、`8px` 顶距）、编辑区 `36px min-height / 4 8 0 14` 内边距 + 原生 placeholder、控制行（`+` 入口 → 影子设置页、静态权限 chip、原生 `select` 模型/推理强度、34×34 圆形发送/停止），运行中发送键变停止。
  - **转录**：用户气泡（原生 `MessageItem` 20px 圆角、14/22、最大宽 `min(content×.702, 82%)`）；助手 `AssistantMarkdown`（原生 markdown 作用域：段落 14/24 + 16px 间距、标题 21/19/18、表格 `_tableScroll` + `md-table-wide`、代码块 `md-code-block` + 原生 banner/复制按钮）；过程组 `TurnProcessNodeView` 折叠行（「已完成，用时 X」+ 下划线，展开为原生 `ChatGroupSeat` body）；思考行 `ReasoningRow`（24px 折叠、展开 13/20 compact markdown）；工具行 `ToolRow` + `DisclosureRow`（24px 行、16px leading、13/24 标题、悬停变色/图标↔chevron 交叉淡入、展开 `ioCard` 显示参数/输出）；尾部 `MessageIconActions`（相对时间 · 用时 + 复制）。
  - **注意力卡**：审批/提问沿用既有逻辑，渲染在原生 `composerStack` 位置（卡片上方）。
  - **降级**：发现不到原生类名时整页回退到 0.10.0 的 `sdc-*` 实现（`ncLegacySurface`）；工具展开体统一用原生 `ioCard`（终端/diff/读取/search 专用块后续可继续细化）。
- **验证**：`node --test` 150 全绿；新增无头复刻台 `_chat_harness`（真实 `client.js` + 原生会话/聊天/工具 CSS + mock 影子路由 + 无头 Edge CDP）：header 51px、内容列 920px、composer 卡片 952px/28px 圆角、用户气泡 20px 圆角 14/22、markdown 14/24、过程组展开 4 工具行 + 1 思考行（24px）、工具行展开出 `ioCard`，0 console 错误；截图见 `docs/shadow-chat-native.png` / `docs/shadow-chat-native-expanded.png`。
- **B 端已更新**：通过影子「推送文件到对端」把 `dsh-plugin-dsh-sync-0.10.19.zip`（sha256 `2D20CFBD8CC76FACB2048C6601A29C53EFA2BEF271B82841F998A23B182A42EA`）推到 B 的 `shadow-uploads`，由 B 端 agent 备份→解压→覆盖 `client.js`/`package.json`→校验，回报 `installed version=0.10.19 client.js sha256=5800421FC13D95E2B6C9889B07B5E804B9ACEE929C77055FEF9CBF6956F3754B`（与 A 一致，未运行 install.ps1、未删除任何目录）。A 端真实界面截图见 `docs/shadow-chat-real.png`。

## 0.10.18

- **影子工作区左下角 1:1 复刻原生工作区列表**：把固定在侧栏底部的影子入口从「自绘卡片」重写为原生 DOM/CSS 契约的复刻。
  - **类名来自运行中的构建**：启动时扫描当前样式表，发现 `dsh-client-ui-workspace` 的行/区头类名（`projectRow` / `sessionRow` / `sectionHeader` / `sectionLabel` / `headerActions` / `iconButton` / `sessionOverflowButton` / `groupSection` …），影子行直接复用这些类，因此 34px 工作区行、32px 会话行、36px 区头、缩进、14px 标题 / 10px 时间、悬停底色、`folder↔chevron` 悬停交换、`…` / `＋` 悬停显隐与原生逐像素一致；图标使用 `@deepseek-ai/dsh-client-ui-primitives` 的原始 16×16 path 数据（folder open/close、triangle、ellipsis、new chat、settings、refresh）。
  - **操作逻辑与原生同构**：点工作区行折叠/展开（`aria-expanded` + 箭头旋转 + 文件夹开合 + `localStorage` 记忆）、点会话行进入影子聊天、`＋` 在该对端工作区新建影子会话、`…` 打开原生样式菜单（工作区：影子设置 / 刷新；会话：打开会话 / 复制会话 ID）、`展开其余 N 个会话` / `收起`（5 条水量线，与原生一致）、800ms 悬停卡片（标题 / 对端 / 相对时间 / 状态）、当前打开的会话行高亮。
  - **状态可视化对齐原生**：相对时间改用原生分桶（刚刚 / 5分钟 / 3小时 / 2天 / 2个月 / 1年），待审批会话显示 warning 点并把尾部时间替换为「待审批」，运行中会话使用 primitives 的 14px spinner，空闲行首留空。
  - **几何对齐**：仍固定在侧栏底部（左下角），左边界与行宽按原生行的实际 rect 对齐（含滚动条 gutter 动态补偿：host 宽 = 原生行宽 + gutter），区头 / 行 / 时间列在复刻台里与原生逐元素 bounding box 相同；无原生行可测量时退回 8px / 264px。
  - **滚动条随悬停显隐**：5px 滚动槽常驻（与原生 `--dsh-session-list-scrollbar-width` 相同，不抖动行宽），thumb 默认透明，鼠标进入影子块时显示、离开即隐藏；内容不足一屏时不占位。
  - **兜底**：发现不到原生类名（未来构建改动 CSS Modules 命名）时退回等价的内置 `sdw-fb-*` 样式，位置/交互不变。
- **验证**：`node --test` 150 全绿；新增无头复刻台 `_launcher_harness`（真实 `client.js` + 原生 CSS/类名 + mock 面板路由 + 无头 Edge CDP）：逐元素 box 断言（标题 x/w、时间右缘、文件夹 x 与原生完全一致）、交互断言（折叠、展开其余、打开会话路由、新建会话路由、菜单开合、悬停显隐、悬停卡片出现/消失）、深/浅色两套截图，0 console 错误。

- 0.10.1: 影子里程碑：隐藏 Host 注入的 runtime-context / skill-catalog / time-context 伪用户消息（按 source.kind 过滤），不再把系统上下文渲染成用户气泡。
# Changelog

## 0.10.0

- **影子聊天对齐原生 DSH（0.10.0）**：客户端聊天页按 `@deepseek-ai/dsh-client-ui-chat` / `ui-tool` / `ui-conversation` 的真实结构与 CSS 重写，仍只用 `react` 与 `--dsw-alias-*` token，零新增依赖；设置页、审批、提问、计划、模型选择与文件推送逻辑不变。
  - **转录分组**：`buildTranscript()` 把事件分成「用户消息 → 过程组 → 回复 → 尾部」，748px 内容列；行距按原生 6px（默认）/12px（回复前后）/16px（过程组前后）。过程组折叠时只有一行「已完成 · 已思考 3.0s · 3 次工具调用 · 1 条命令」，运行中自动展开并显示 SVG spinner；`attachLive()` 把流式 reasoning/回复并入当前未结束的轮次，已结束轮次不会被覆盖。
  - **思考行**：折叠为 24px 单行「思考 + 首行摘要 + 耗时」，点击展开；流式时自动展开并在正文末尾显示光标，结束后自动收起。旧的 boxy 卡片删除。
  - **工具行**：24px 高、16px leading 图标、13px 摘要；运行中 leading 换成 spinner 且文字呼吸；展开后编辑显示带 old/new 行号的 unified diff（`--dsw-alias-code-diff-added/deleted` 底色 + 3px inset 边），命令显示 `$ cmd` + 输出（224px 滚动）与失败退出码，读取显示路径/行号窗口，grep/glob 显示匹配数与文件数，写入显示内容，后台任务显示 job 卡片，待办显示 checklist，未知工具回退为参数/输出 IO 卡片；错误行内标红。
  - **助手 Markdown**：纯函数 `markdownBlocks()` 解析 GFM（标题、段落、列表含一级嵌套、表格、围栏代码、引用、分隔线、链接、行内 code/粗体/斜体/删除线），渲染为原生排版：段落 16px 间距、表格横向滚动、代码块 sticky 语言栏 + 复制按钮、流式光标。
  - **Composer**：原生卡片式输入区（`--dsw-specific-input-major`、16px 圆角、自增高 textarea），工具栏内含模型与推理强度选择器、快捷键提示、运行中停止按钮（圆形）与发送按钮（圆形蓝色），Enter 发送 / Shift+Enter 换行（兼容 IME composing），发送中禁用。**不添加附件按钮**：B→A 上传尚未实现，现有「推送文件到对端」仍在设置页。
  - **消息操作与状态**：用户气泡改用 `--dsw-specific-bubble` 与原生圆角/内边距，显示相对时间；助手消息尾部显示相对时间、耗时与「复制回复」；代码块有独立复制按钮；新增加载骨架、空状态、断线/错误横幅、贴底跟随与「回到底部」浮动按钮（`scrollFollow()` 纯函数判定，阈值 48px）。
  - **交互卡样式**：审批、提问、计划待审改为原生 attention 卡（warn 描边 + 状态条 + 15px 标题 + 右对齐操作行），逻辑与文案不变。
- **纯函数与测试**：新增 `test/client.test.js` 5 个用例（Markdown 围栏/表格/嵌套列表解析、转录分组与 tool/todo 合并、live reasoning/回复接入、工具事实（diff/退出码/读取窗口/匹配数）、滚动跟随与相对时间）；全量测试 150 绿。
- **修复**：`push-file` 的传输步骤同时接受 `step` 与旧 `action` 负载，数据路由以路由 action 为准（0.9.0 会把步骤误当 action）；此前 2 个上传测试与客户端推送测试失败的问题解决。
- **验证**：`node --check` 全部改动文件；headless Edge 用 mock 影子路由渲染真实 `ChatPage`（用户消息、流式思考、读取/编辑 diff/命令/搜索工具行、待办、Markdown 表格与代码块、审批/提问/计划卡），断言分组、折叠、diff、复制按钮、`回到底部` 均存在且无 console 错误，截图 `docs/shadow-chat.png`。

## 0.9.0

- **分块文件传输（0.9.0 新增）**：影子通道新增 `ext.shadow.push-file`（单 op，`action: begin | chunk | commit | abort`），把本机文件推到已配对的对端。此前版本承诺的「文件上传」由本版落地。
  - **接收端默认关闭**：需要配置 `shadow.uploads.enabled: true`，或在本机设置页「本机共享」打开「接收对端推送的文件」，或 `state.json` 的 `uploads.peers` 按设备授权。未开启时返回 `shadow/uploads-disabled` 并记一条失败审计。
  - `begin {transferId, name, size, sha256}`：校验文件名（单个 Windows 安全路径段：拒绝 `/`、`\`、盘符、`.`/`..`、控制字符；`CON` 等保留名加前缀）、大小上限（默认 64 MB，`shadow.uploads.maxBytes`）、sha256 格式；在 `<DSH_HOME>/shadow-uploads/.incoming-<id>.part` 建临时文件。
  - `chunk {transferId, index, data(base64)}`：必须顺序到达；单块默认 512 KiB（`shadow.uploads.chunkBytes`，上限 700 KiB 以适配 dsh-sync 的 1 MB 请求体），累计不得超过声明大小。
  - `commit {transferId, sha256?}`：校验字节数与 sha256 后 `rename` 到 `<DSH_HOME>/shadow-uploads/<安全文件名>`，返回 `{ok, transferId, name, size, sha256}`（接收端报告 `{size, sha256}`）；失败/超时/abort 删除临时文件；同名文件永不覆盖（自动 `name (1).ext`）。
  - 10 分钟 TTL、最多 8 个并行传输；commit 重试幂等（缓存最近 32 个已完成传输）。
  - **审计**：每次 begin/commit/abort/失败写一行（`op: ext.shadow.push-file, action, transferId, name, bytes, peer, ok[, code]`），**不记文件内容**；同样信息写入 `$DSH_HOME/shadow-workspace/debug.log`（`host/bridge/uploads` scope）。
- **显示端（B）**：`b-proxy` 新增 `pushFileStep()`（begin/chunk/commit/abort 转发）、`uploadsState()`；`ext.shadow.info` 新增 `uploads: {enabled, maxBytes, chunkBytes}`（按调用设备计算）。
- **本地路由**：`POST /plugins/dsh-plugin-dsh-sync/shadow/rpc` 新增 `uploads-enable {enabled}`（持久化本机接收开关）与 `push-file`（一个传输步骤，浏览器只上传 base64 块）；`GET` 与 `state` 响应新增 `uploads`。
- **客户端**：「本机共享」页新增「接收对端推送的文件」开关（并显示保存目录）；「显示对端」页在**已选中对端且对端开启接收**时显示「推送文件到对端」卡片：文件选择器、分块进度、送达结果（名称/大小/sha256 前 16 位）与失败原因。sha256 由浏览器 WebCrypto 计算、A 端在 commit 复核；客户端仍零 npm 依赖。
- **安全**：文件名清洗 + 目录逃逸双重防护（临时文件与最终文件都必须在 upload 目录内）、新增错误码 `shadow/uploads-disabled`、`shadow/upload-not-found`、`shadow/upload-hash-mismatch`、`shadow/upload-busy`；传输动作全部走仅本机 GUI 可用的鉴权（cookie/loopback + `X-Shadow-Client`）。
- **测试**：新增 `test/uploads.test.js`（10 个：文件名清洗/路径穿越、base64 严格解码、64 MB 上限与声明大小、sha256 不匹配不落盘、默认关闭与显式授权/撤销、begin/chunk/commit 落盘+审计+debug 日志、本地数据路由端到端、TTL/dispose 清理）与客户端推送纯函数（分块、字节格式化、begin→chunk→commit、失败 abort）及推送卡片可见性渲染检查；全量 145 个测试全绿。

## 0.8.0

- **影子会话的「提问 / 计划审批」交互（0.8.0 新增）**：`ask_user_question`（含 `plan-review`）此前只由 A 端本地 UI 处理，B 端完全看不到，导致 B 的会话卡住或超时。现在 A 端 bridge 在 `#onAgentCreated` 里与 `approval/request` 并排注册 Agent-scoped waterfall `user-questions/request`（`{ prepend: true }`）：
  - 只拦截 bridge 管理的影子会话，其它 Agent 立即 `next()`；共享关闭时也交回本地 UI。
  - 新增 RPC `ext.shadow.questions`（待答列表，按会话/owner 过滤）与 `ext.shadow.answer-question`（`{sessionId, questionId, answers}` 或 `{cancel:true, reason}`）；答案批次做逐题校验（每题恰好一条、选项必须真实存在、单选自定义覆盖选择、多选自定义补充、跳过=`{id, selected: []}`）。
  - 请求转成 transient `{ kind:'question', phase:'asked', questionId, sessionId, questions, intent, planReview, createdAt, expiresAt, ttlMs }`；回答/取消写 `phase:'answered'|'cancelled'` 并清理 pending；`#batchEnvelope` 同时携带 `questions` 齐备列表，重连也能看到。审计只记数量/类型，不记问题与答案正文。
  - plan-review 的「要求修改」以 `ASK_CANCELLED` 拒绝 waterfall（消息可读），让 agent 回到编辑器；「同意执行」用 `intent.approve` 标签回答。B 离线或 60s TTL 到期时把同一请求 `next()` 给本地官方 UI（不静默 auto-approve）。
  - 客户端聊天页 composer 区（输入框位置）渲染提问卡：标题/详情（Markdown）、单选/多选、自定义文本、单题跳过/全部跳过、提交；提交后卡片变只读「已回答」。plan-review 专用卡：计划待审条 + 标题 + 两行摘要 + 查看全文（展开 detail）+ 要求修改 + 同意执行。
- **工具卡可见性诊断**：
  - 设置页显示 `影子插件 vX.Y.Z` 与 `对端 vX.Y.Z`（`peer.version` 来自 `ext.shadow.info`；panel state 新增 `display.peerVersion`）。
  - 客户端每收到一批事件就把 `chat events {type:count,...}`（含 transient 种类）写入 shadow `clientDebug` → B 的 `debug.log`，可直接确认事件是否到达渲染层。
  - 渲染兜底：assistant 消息里的 `tool-call` content block 会被补成工具卡（即使独立 `tool/call` 事件缺失/丢失），避免出现「只有思考和回复、看不到工具」的观感；同一 callId 不会重复渲染。
- 测试：新增 5 个（133 全绿）——question waterfall 拦截/非影子放行/答案批次/取消 ASK_CANCELLED/TTL 本地回退/owner 与答案校验，以及客户端问题卡纯函数（归一化、必填校验、答案批次、plan-review 摘要/同意批次）。
- **文件上传仍未做**（上一版承诺顺延），计划下一版；客户端仍只有 `react` 可用，零 npm 依赖。

## 0.7.3

- 审批原因改为优先取结构化 displayReason.zh（其次 en/text），客户端同时兼容旧版 JSON 字符串，审批卡不再显示原始 JSON。
- xt.shadow.info 增加 ersion，显示端 state 的 peer 带版本，便于排查两端版本不一致。

## 0.7.2

- 审批原因修复：DSH 的 displayReason 是结构化对象，之前被 String() 成 [object Object]；现在优先取 	ext/message/description/title，否则 JSON 序列化，审批卡显示可读文案。
- 工具分类新增 skill（技能调用卡片）；transcript 增加持久 pproval/decided 行（已允许一次/已拒绝/审批不可用）。

## 0.7.1

- 影子入口排序调整为 0 / 1+：sidebar.workspaces 是 ui-workspace 独占的 single 槽，无法追加子项；通过把「影子工作区」和各设备分组排到面板列表最前，让它紧贴原生工作区列表下方显示（设备同步 仍在 43）。

## 0.7.0

针对 B 端（显示端）实测反馈的 4 个问题。

- **原生级 transcript（最重要）**：影子聊天页按 DSH 原生聊天观感重做事件渲染（`client.js` 的 `ChatPage`）。
  - **工具卡片**：工具名 + 参数摘要 + 可展开的结果；按名字区分读取 / 写入 / 编辑 / 搜索（grep）/ 查找（glob）/ 命令（pwsh/bash 等）/ 后台任务 / 其它，带耗时与状态点；失败卡片整体标红。
  - **编辑 diff**：`edit`/`str_replace`/`patch` 类调用从 `old_string`/`new_string` 等字段提取 old/new，输出行级 diff（公共前后缀 + LCS），显示 `+新增 / -删除` 行数与代码行底色；大编辑按条数截断。
  - **命令**：`command/run` + `command/done` 合并为命令卡片，显示 `$ 命令 参数` 与输出尾部（超过 40 行折叠保留尾段），失败标红；`tool/call` 里的命令类工具也显示命令行与输出尾部。
  - **事件覆盖**：`tool/call`、`tool/result`、`command/run`、`command/done`、`todo/write`（待办清单卡片，只在最后一条渲染避免刷屏）、`job/registered`/`job/settled`（后台任务卡片）、`model/selection`/`sandbox/mode`/`permission/preset`/`working-directory/change`（去重后的状态 chip）、`assistant/attempt` 错误行、`turn/end` 状态行；孤儿 `tool/result`、`command/done`、`job/settled`（没有对应起始事件）也会渲染。
  - **思考块**：折叠态显示「思考」+ 首行摘要（流式时显示「思考中…」与实时耗时），展开看完整 Markdown；流式时自动展开，`assistant/message` 落盘后折叠。GFM 表格/代码/列表渲染保持不变。
- **模型选择（Host + Client）**：
  - 新增 `ext.shadow.models`：把 A 端 `sessionController.modelCatalog()` 精简为 `{default, groups:[{id,label,name,models:[{id,name,reasoning?}]}], failures}`，provider 失败项原样上报；B 端代理缓存 60 秒。
  - 新增 `ext.shadow.select-model`（`{sessionId, provider, model, reasoningEffort?}`）：`requireSession` + 共享工作区 + **owner 校验**（拒绝他人设备创建的会话，行级审计记录 `ext.shadow.select-model`），随后调用 `sessionController.selectModel`，成功结果写入注册表 `lastModel`。
  - `ext.shadow.create` 支持传入 `model`：创建会话后立即 `selectModel`，失败返回 `modelError`（会话仍保留，不谎报创建失败）。
  - 注册表 / `ext.shadow.list` / `events` 信封新增当前模型（`lastModel`/`model`），B 端 header 能直接显示。
  - 客户端：聊天页 header 增加模型下拉（含 provider 分组与 reasoning effort 子选择），切换即调用 `select-model`，失败在页面上明确提示（不静默）；「新会话」页可预选模型，创建时带上。
- **会话列表**：修复 B 端「更新后旧会话消失」的数据链路隐患，并补回归测试：
  - A 端 `#isOwner` 对**升级前写入、没有 `creatorPeerId` 的旧注册表行**不再一律过滤：旧会话对已配对设备可见，第一次写入时自动认领归属（显式 `local` 行仍拒绝），不再出现「注册表里有、B 端列表没有」。
  - B 端 `#buildState` 不再丢弃「session 属于未在 info 里声明的工作区」的行：为它们合成一个工作区分组并保留（warn 日志），避免列表静默吞会话。
  - B 端会话列表取「分组列表 ∪ 扁平 session 列表」的并集（按 sessionId 合并），任何分组/覆盖回归都无法再隐藏会话；列表行展示标题、状态、更新时间、当前模型、最近文本，点击进入聊天。
- **侧栏顺序**：影子设置入口 order 从 58 调到 **10**，每个对端工作区分组 order **11+**，紧挨在原生「工作区」下方。**`sidebar.workspaces` 是 shell 声明的 `kind: single, scope: root` 槽，已被 ui-workspace 占用，不能替换**（会顶掉原生工作区浏览器），因此影子入口只能留在 `sidebar.panellist`，这是 shell 槽位限制而非实现取舍。
- **文件上传**：本版不做，README/CHANGELOG 已注明「下一版」。客户端仍只有 `react` 可用，未引入任何 npm 依赖。
- 新增测试（128 个全绿）：`test/shadow-bridge.test.js` 5 个（旧 owner 会话可见/认领与列表完整性、未声明工作区不丢会话、模型目录精简、owner/参数/会话校验与审计、create + model 成功与失败路径）；`test/client.test.js` 增加 transcript 纯函数断言（工具分类、编辑 diff、命令摘要、模型 label）与侧栏 order 10/11+ 断言。`node --check` 覆盖全部改动 JS。

## 0.6.1

- 影子聊天按 DSH 原生观感补全 Markdown：GFM 表格、代码围栏（带语言标签）、1–6 级标题、引用、分隔线、有序/无序列表、粗体/斜体/删除线/行内代码/链接。
- 新增思考过程显示：实时 `reasoning-delta` 流式累积为可折叠「思考过程」，持久消息里的 reasoning 块同样折叠展示。
- 流式文本与思考分开聚合，`assistant/message` 落盘时一起清空，避免残留/重复气泡。

## 0.6.0

- **合并插件：`dsh-plugin-shadow-workspace` 0.1.1 并入本插件**。现在只装 `dsh-plugin-dsh-sync` 一个插件（0.6.0），同时拥有「设备同步」和「影子工作区」两个功能；原来单独安装的影子插件可以卸载，`cordis.patch.yml` 仍只有 `dsh-sync` 一行 bundle，不新增插件行。
- **Host 侧**：影子插件的 host 代码整体搬进本包的 `shadow/`（`shadow/index.js` + `shadow/src/*.js` + `shadow/locale/*`），内部相对导入不变。
  - 入口从独立插件的 `apply(ctx, config)` 改为 `attachShadow(ctx, { rpc, config, logger })`：由本插件 `index.js` 在 `registerPanel()` 之后调用，直接传入 `broker.api`（即 `dshSync` 服务），不再依赖 `ctx.inject(['dshSync'])`，也不再有 `ctx.dshSync` 属性访问；`ext.shadow.*` 的注册、peer 事件订阅及其 disposer 都挂在引擎条目上，随插件卸载/重载一起回收。
  - `ctx.inject(['webServer'], ...)` 的本地路由保留，路径改为 `/plugins/dsh-plugin-dsh-sync/shadow`（面板）和 `/plugins/dsh-plugin-dsh-sync/shadow/rpc`（会话数据）。
  - 面板读取 `dshSync` 改为模块级 `setShadowSync(api)/syncOf()`，由 `attachShadow()` 注入。
  - `ctx.provide('dshSync', api)` 保持不变，其它插件仍可消费本插件的 sync 服务。
  - 影子插件的单实例保护（按 stateDir）保留：热重载不会重复挂载 bridge/路由。
- **Web 客户端合并**：影子插件的 `client.js` factory 主体被内嵌为 `createShadowClient(require)` 并挂到本插件 `client.js` 的 `apply()` 里，整个包只保留一次 `window.__ModuleLoader__.load` 调用；`inject` 增加 `locale`，路由常量改为新路径。两个 UI 的 style id（`dsh-sync-panel-style` / `shadow-workspace-style`）和 slot key（`dsh-sync-panel` / `shadow-workspace*`）互不覆盖，侧栏同时出现「设备同步」「影子工作区」和每台已配对设备的「XXX的工作区」条目。
- **打包**：`package.json` `files` 增加 `shadow/`；`scripts/package.ps1` 递归复制 `shadow/` 并校验 `shadow/index.js`、`shadow/src/constants.js`、`shadow/src/panel-route.js`、`shadow/locale/{zh,en}.json` 存在；产物为 `dist/dsh-plugin-dsh-sync-0.6.0.zip` / `.tgz`。`packaging/install.ps1` 不变（本来就整目录复制）。
- 测试随合并更新：`test/client.test.js` 断言新 `inject`（含 `locale`）与两套 UI 的注册（设备同步 2 条 + 影子设置页 2 条）；`test/apply.test.js` 改为按路径区分多条路由，并断言影子面板路由 403/200 与 `dshSync` 服务复用不变。上一版 122 个测试保持全绿。

## 0.5.1

- **`registerRpc` 增加 `{ allow }` 选项，做到「装完即用」**：`registerRpc(op, handler, { allow: true })` 会让该 op 自动加入本机放行集合（仅该 op，不扩大其它 op），不再要求用户手改受保护的 profile `cordis.patch.yml` 才能让影子插件工作。权限判定顺序：`extRpcDisableAll === true` → 一律拒绝；否则 op 以 `allow: true` 注册过 **或** `extRpcAllow` 配置匹配 → 放行；两者都没有 → `ext-disabled`（默认仍关闭）。
- 新增 config `extRpcDisableAll`（默认 `false`）：总开关，为 `true` 时即使插件声明 `allow: true` 也拒绝，方便用户一键封死扩展通道。
- 放行集合随注册生命周期回收：`registerRpc` 返回的 dispose 被调用后，该 op 的隐式放行一并移除（重新注册但未声明 allow 时会恢复为 `ext-disabled`）；`broker.dispose()` 清空全部。
- 安全文档补「`allow: true` 的信任模型」：插件代码与 DSH 同信任级，`allow: true` 只是该插件声明自己的 op 可被已配对设备调用；不放大已有信任，仍受 `dshSync` 服务、配对、`ext.` 命名、1MB/8MB 大小限制与审计日志约束。另补充「用 `- id: dsh-sync` override 会整份替换该行 config（不是深合并）」的提醒。
- 新增测试 4 个（122 个全绿）：`extRpcAllow` 为空时 `allow:true` 可用、`allow:true` 只放行自身 op（其它 op 仍 `ext-disabled`）、`extRpcDisableAll` 拒绝 `allow:true`、allow 注册 dispose 后权限回收。

## 0.5.0

- **新增 `dshSync` 跨机 RPC 服务（broker，传输层，默认关闭）**：把 dsh-sync 已有的发现/配对/加密 RPC 以 Cordis 服务形式暴露给同 profile 的其它插件（如「影子工作区」），这些插件不再需要自己维护通道。插件入口在 engine 创建后调用 `ctx.provide('dshSync', api)`；宿主没有 `ctx.provide` 时只 `log warn` 并跳过，dsh-sync 自身功能不受影响。
  - API（最终签名）：`identity() → {deviceId,name,group}`；`peers() → [{deviceId,name,online,trusted,host,port,lastSyncAt}]`；`rpc(deviceId, op, payload?, {timeoutMs=10000}) → Promise<json>`；`registerRpc(op, handler) → dispose`（`handler({op,payload}, {peer})`）；`onPeerEvent(listener) → dispose`（`peer`/`peer-lost`/`peer-updated`/`status`）。**不暴露 `engine`**。
  - 扩展 op 强制 `^ext\.[a-z0-9][a-z0-9._-]{0,63}$`，不能覆盖内置 `ping`/`manifest`/`pull`/`push`；只接受已配对设备（传输层认证 + `identity.getPeer` 双重断言）；请求 1MB / 响应 8MB 上限；日志只记 `ext rpc <op> from <device>` 与字节数，不打印 payload。
  - **默认关闭**：新增 config `extRpcAllow: []`，空数组时任何 `ext.*` 调用都返回 `ext-disabled`；显式配置 `['ext.shadow.status']`、`['ext.shadow.*']` 或 `['*']` 才放行（按 op 名前缀匹配）。
  - 生命周期：`registerRpc` 的 op 表与 `onPeerEvent` 订阅随插件卸载/重载清理；`engine.setExtRpcHandler()` 返回 dispose，重载后可重新挂钩。
- 新增测试 16 个（118 个全绿）：broker 服务形态、ext.echo 双引擎往返、默认关闭、通配白名单、未注册 op、非法 op 名、未配对设备（传输层 403 + 直接进 handler 的 `not-paired` 双路径）、内置 op 回归、请求/响应超限、handler 错误码与「日志不含 payload」、dispose/重载、peer 事件订阅；`apply.test.js` 增加 `ctx.provide('dshSync', …)` 与 reload 复用同一 service 的断言。

## 0.4.4

- **profile 集支持解引用 `plugins/<name>` 的一级 junction**：A 的 `dsh-npu`、`dsh-plugin-companion-memory` 源码目录其实是指向 `D:\工作区\<name>` 的 junction，`listFiles` 原本跳过链接，导致 B 永远拿不到源码。现在 profile 集（`dereferencePluginLinks: true`）会枚举 `plugins/` 的直接子项，对一级 symlink/junction 用 `realpath` 解析后列出目标内真实文件，rel 仍是 `plugins/<name>/...`；只解一层，目标内部的二级链接继续跳过，既有 include/exclude（`node_modules`、`*.node`、`.git` 等）照常生效。A 本机的 junction 保持不变。
- **新增同步集 `credentials`（模型 API 密钥）**：`$DSH_HOME/.credentials.yaml` 只做行级合并，且**只并 `refs:` 段中名字以 `API_KEY` 结尾的条目**。
  - 本机缺失的 key 追加到 `refs:` 末尾；两边都有但值不同 → 保留本机并记 `credential-conflict`（只记 key 名，不写值）；多行/块格式的值记 `credential-skipped`，不自动合并。
  - `records:` 段（设备/OAuth token）与 `BUDDY_ACCOUNT_*`、`WORKBUDDY_ACCOUNT_*` 等账号类 ref **永不复制**；本机文件缺失时不会整文件复制，而是新建只含 `version: 1`、`records: {}`、`refs:` + 对端 API Key 的最小文件。
  - 有改动才写：备份 `.credentials.yaml.bak-sync-<stamp>`、UTF-8 无 BOM、更新索引、journal 记 `{h, divergedH}` 驻留避免重复；写入前若本机文件在 `stableAfterMs` 内刚变动会跳过本轮（运行中的 DSH 可能内存态回写）；删除永不传播；日志不打印密钥值。
- **`cordis.patch.yml` 模型块定向合并（`mergeModelConfig`，默认开启）**：不再整文件按机器保护，而是用新的纯函数模块 `src/modelconfig.js` 只合并白名单块（`name` 为 `@deepseek-ai/dsh-agent-default-model` 或 `@deepseek-ai/dsh-llm-*`）。
  - 三方规则：无 base（首次）或只有对端改过 → 采用对端块；只有本机改过 → 保留本机；两边都改 → 保留本机并记 `model-config-conflict`；对端有而本机没有的模型块追加到块序列末尾。
  - 文件其它字节（本机路径、端口、`dsh-npu`/qqbot 等其它插件块、注释）逐字节保留；不再为 `cordis.patch.yml` 生成整文件 `.conflict-*`；块水位记在 journal 的 `cordis.patch.yml::<name>` 键上。
  - 有改动才写：备份 `cordis.patch.yml.bak-model-<stamp>`、无 BOM、保留结尾换行、更新索引；拉取与推送两条路径都走这套合并。
- **profile 自愈增强**：`repairLocalProfile()` 现在还会扫描 `plugins/<name>` 实体目录（`package.json` 的 `name` 与目录名一致），清单里没有声明时自动补 `link:./plugins/<name>`，随后补 `node_modules` junction 与 bundle —— B 收到 junction 解引用过来的源码后能自动恢复被 0.4.3 清掉的声明。
- **sets.json v3 迁移**：v1 文件同时打开 `modules`，v2 文件打开 `credentials`（前提 `profile` 开启，均按其 `defaultEnabled`）；写回 `{version: 3}`；`setSets` 写 v3，去掉 `profile` 仍会关闭 `modules`。
- **修复：模型块/凭据合并被 LWW 门控导致「本机文件较新时静默不生效」**（verifier Y9/C9）。`credentials` 集在 `syncPeer` 中绕过 `decide()`，只要两边都存在、哈希不同且不是已驻留分叉，就直接增量合并；`cordis.patch.yml` 模型块分支不再要求 `decision === PULL`，改为按 journal 的块级 base 做三方合并。两者合并后都写 `{h: 新本地 hash, s, m, divergedH: remote.h}` 驻留，下一轮对端未变就不重复拉取/写盘。另外无 base 的模型块只在「对端文件更新」时采用，避免两端各自「采用对端」把较新的本机配置反向覆盖（纯函数增加本地/远端 mtime 入参）。
- **安全修复（P1/P2）**：`credentials` 集 root 是 `$DSH_HOME`，此前 RPC 的 `pull`/`push` 只用 `joinInside()` 校验「在 root 内」，已配对对端可借此读取/改写 `dsh-sync/device.json`、`profiles/<profile>/package.json` 等任意文件。现在新增 `setAllowsRel()`（`isIgnoredForSet` + set 的 include/exclude），在 `handleRpc('pull'|'push')`、`applyPushedFile`、`applyPull` 四处强制校验，越界一律 `invalid-path`；`applyCredentials` 再断言只处理 `.credentials.yaml`。
- `client.js` 增加 `credentials: '模型 API 密钥'` 标签；`DEFAULTS` 增加 `mergeModelConfig: true`。
- 文档：README 增「模型 API 设置与密钥同步」、junction 解引用与 B 机流程；补充「npu 同步到无 NPU 硬件的机器可能报加载错误」「凭据/模型写回后需要重启 DSH」等安全与限制说明；DESIGN 增对应小节。
- 新增/更新测试（102 个全绿）：modelconfig 纯函数 10 个（首次采用/较旧对端不回滚/对端更新/本地改动保留/双方冲突/远端独有块追加/非白名单逐字节不变/幂等/CRLF）、credentials 纯函数 8 个（只并 API_KEY、records 与账号 token 不复制、冲突保留本机、缺失文件最小化创建、无 refs 段追加、多行值跳过、CRLF）、profile junction 解引用（index-store + 双引擎端到端 + 自愈补声明）、`cordis.patch.yml` 双引擎合并/本地改动保留/**本机文件更新时仍合并且第二轮不重复写盘**、`.credentials.yaml` 双引擎合并/冲突/**本机更新时仍合并**、**RPC 越界路径拒绝（P1/P2：pull/push `dsh-sync/device.json`、`profiles/.../package.json` 均拒绝且文件不变，合法 `.credentials.yaml` 仍可读）**、sets v1→v3 与 v2→v3 迁移。

## 0.4.3

- **新增同步集 `modules`（插件依赖）**：镜像 `profiles/<profile>/node_modules` 里的**真实目录**（pnpm `hoisted` 布局），解决「profile 只同步声明与 plugins 源码，`node_modules` 不同步 → 对端『有声明没包』、插件页『包不可用』，只能靠 U 盘拷 node_modules」的根本问题。
  - 跳过链接/符号链接/junction（`listFiles` 不进入），跳过 `.pnpm`、`.bin`、`.ignored`、`.modules.yaml`、`.pnpm-workspace-state-v1.json` 与原生二进制（`*.node/*.dll/*.so/*.dylib/*.exe`）、`*.map`。其中 `.bin` 只排除该**目录下的内容**（`**/.bin/**` + 顶层精确条目 `node_modules/.bin`）：包内普通资源如 `pkg/dist/assets/tool.bin` 照常索引/同步。此前写成 `**/.bin` 会被 glob 展开成 `.*\.bin`，误伤所有以 `.bin` 结尾的文件（verifier F1，已修正并加回归测试）。
  - **永不传播删除**（`deletesEnabled('modules') === false`，不写墓碑）；在 `node_modules` 里回写文件时**不生成 `.bak-sync-*` 备份**。
  - 新增 `maxModulesBytes`（默认 256MB）：每个 peer 每轮最多拉取这么多字节，超限后本轮剩余文件延后到下一轮，`log('warn')` + 面板记一条 `modules-over-limit`（每个 peer 每轮一条）。
  - 忽略规则改为按集合生效：新增 `isIgnoredForSet(rel, set)`，`index-store`/engine 全部调用点改为集合感知，`node_modules` 只对 `modules` 集放行（`.bak`、`.sync-tmp-`、`conflicts` 等规则仍然生效）。
- **本机 profile 自愈 `repairLocalProfile()`**（每个同步轮末尾执行，纯本地操作，不需要网络；`config.repairProfile !== false`）：
  - 为 `link:`（及指向本 profile 内的 `file:`/`portal:`）依赖补建 `node_modules/<name>` junction：目标存在则确保链接存在且正确、缺失/错误才重建（只删链接本身，**绝不对真实目录递归删除**）；目标不存在则清掉链接并移除该依赖声明与对应 bundle；
  - 给「链接目标存在且本机可解析」的插件补回 `dsh.profile.bundles`；
  - 清理本机既无源码也无法解析的 bundle 声明（`@deepseek-ai/*` 一律保留），记录 `bundle-pruned`/`link-pruned` 冲突，不再显示「包不可用」；
  - 有改动才写盘：先备份 `package.json.bak-prune-<yyyyMMdd-HHmmss>`，UTF-8 **无 BOM**、2 空格、结尾换行，并同步更新索引；无改动不写盘、不备份（幂等）。
  - **junction 目标始终用本机 `profileDir` 解析**，绝不会指向对端的绝对路径。
- **sets.json v1 → v2 迁移**：存量机器（旧文件只有 6 个集）升级后自动为 `modules` 打开（前提是 `profile` 集开启），并写回 v2；`setSets` 去掉 `profile` 时会同时关闭 `modules`。
- 修复**入站大小上限没有执行**：`fetchRemote()` 现在先用清单声明的大小、再用响应大小两次校验 `maxBlobBytes`，超限直接抛错并计入同步错误（不再静默完整收下超大 payload）；`modules` 集也走这条路径。
- 打包产物 0.4.3；`install.ps1` 不变（0.4.2 起已是无 BOM 写入）。
- 新增/更新测试（71 个全绿）：modules 集索引/忽略规则/junction 不索引/超限跳过、**包内 `*.bin` 资源照常同步而 `.bin` 目录内容不传（F1 回归）**、profile 自愈（补链接/补 bundle/清声明/幂等/无 BOM/备份/不指向对端路径）、sets 迁移与联动、modules 一轮自愈端到端、入站上限、`maxModulesBytes` 预算。

## 0.4.2

- **数据丢失修复（事故根因）**：`workspace.json` 的 `global.archivedSessionIds` / `pinnedSessionIds` 不再取并集，**只保留本机的值**。归档/置顶是每台机器本地的界面状态，旧版把对端的归档 id 并进来后，DSH 会把本机正在用的会话从工作区列表里隐藏，表现为「工作区会话列表变空/变少」，而且没有任何冲突提示。`workspaceIds`、`tables.workspaces[].sessionIds`、`defaultWorkspaceId` 的合并语义不变。已被污染的两台机器需要手动清理：把同时出现在 `tables.workspaces[<id>].sessionIds` 与 `global.archivedSessionIds` 里的 id 从归档列表中删掉（步骤见 README）。
- 修复合并后的 `defaultWorkspaceId` 可能指向悬挂工作区（不在 `workspaceIds` / `tables.workspaces` 里）的问题：合并后校验，无效则回退到有效的本机/对端 id，再退回合并后的第一个工作区，都没有则置空，避免 DSH 打开空工作区。
- 修复 `workspace.json` 合并把同步水位记到占位 peer（`dsh-sync/journal/peer.json`）而不是真实设备 id 的问题：`applyWorkspaceMerge`/`applyWorkspace` 现在使用真实 `peer.deviceId` 记 journal；同时修正会话/文件「内容已一致」路径上 `journal.record(..., remote)` 字段名不匹配（`hash` vs `h`）导致水位被清空的同类隐患。
- 修复「对端出现本机没有的插件 bundle、DSH 显示『包不可用』」：`profiles/<profile>/package.json` 合并时不再无脑取并集。
  - 对端独有的 `dsh.profile.bundles` 条目只有在本机能解析（profile `node_modules` 或 DSH 安装目录里存在该包，且 `exports`/`main`/入口文件至少能定位）时才并入；本机已有的条目永远保留。
  - 对端独有的 `link:`/`file:` 依赖，如果本机 `profiles/<profile>/plugins/...` 目标不存在则不并入（避免 pnpm install 因缺失链接失败或裁剪）；registry 版本号依赖保留，便于以后安装。
  - 被跳过的 bundle/依赖不再静默丢弃：面板冲突区记录 `bundle-unavailable` / `dependency-unavailable`，说明「对端启用但本机未安装，安装后可再次同步」。装好插件后下一轮同步会自动并入，不会因为「已跳过」而永久卡住。
  - 解析能力可注入（`config.bundleRoots`、`DSH_SYNC_BUNDLE_ROOTS` 环境变量），`merge.js` 保持无 fs 依赖。
- 修复安装包 `install.ps1` 写出的 `package.json` 带 UTF-8 BOM、导致 DSH `JSON.parse` 抛 `Unexpected token ''` 的问题：改用 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`，兼容 Windows PowerShell 5.1。
- 数据安全：本机 `workspace.json` 或 profile `package.json` **存在但不是合法 JSON** 时，不再用对端内容覆盖本机（旧行为会把 union 结果写回，属于潜在数据丢失）。现在保留本机原文，把对端版本另存为同目录 `.conflict-<设备>-<时间>`，并记录一条 `invalid-local` 冲突提示。
- `applyPushedFile`（推送落盘）同样应用上述两条规则，避免推送路径绕过保护。
- 新增/更新测试：归档/置顶不并集、bundle 过滤、link 依赖过滤、registry 依赖保留、本地非法 JSON 不被覆盖、install.ps1 无 BOM。

## 0.4.1

- 本机删除的插件文件不再被对端「拉回来」：profile 集合的删除记录为本地墓碑，但不向对端传播。对端副本保持原样。
- 新增对应测试。

## 0.4.0

- 每个已配对设备新增两个显式操作：「覆盖本地」用对端文件替换本机；「推送」把本机文件发给对端。
- 「推送」默认关闭，必须先在本机打开「允许推送」安全开关；开关持久化在 `dsh-sync/push-guard.json`。
- 推送按哈希跳过相同文件；覆盖对端普通文件前保留 `.bak-sync-*`；会话日志只追加，`cordis.patch.yml` 等仍受保护，`package.json` 仍走并集合并。
- 「覆盖本地」同样先备份；配置类与会话走安全路径，不会被静默丢历史。

## 0.3.2

- 修复 0.3.1 及更早版本会把本机 `package.json` 覆盖成对端版本、导致本机插件（QQ 机器人、NPU 等）从 profile 里消失的问题。
- `profile/package.json` 改为**增量合并**：`dependencies`、`dsh.profile.bundles` 取并集，本机版本优先，不再丢插件。
- `cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml` 改为**按机器保护**：对端版本只另存为 `.conflict-*` 并在面板记录，绝不覆盖本机配置。
- 新增 profile 合并/保护测试。

## 0.3.1

- 「立即同步」改为完整状态机：点击后显示「同步中…」、已拉取文件数与字节，全部传输完成后显示「✓ 同步完成」并保留 4.5 秒。
- 手动同步会先等待正在进行的自动轮次结束，再跑一轮新的，确保包含最新改动。
- 同步期间面板以 800ms 轮询刷新进度；按钮在同步中禁用，不再无反馈地跳回原状。

## 0.3.0

- 修复单向发现问题：已发现的对端会收到直连单播 beacon，不再依赖组播/广播一定能双向到达。
- 新增「手动添加」：输入另一台电脑的 `IP:监听端口`，通过 TCP `/hello` 直接建立对端，适用于 AP 隔离或单向组播环境。
- 面板显示本机局域网地址，方便在另一台电脑上手动填写。
- 手动对端持久化到 `dsh-sync/manual-peers.json`，重启后自动重连。

## 0.2.0

- 界面按 DSH 原生风格重写：页面标题栏、分组面板、发丝分隔线、32px 按钮、原生复选框，只使用 `--dsw-alias-*` 主题 token。
- 新增删除同步：内容哈希墓碑 + 同步水位双重校验；分叉删除会保留并提示。
- 删除前保留 `.bak-sync-deleted-*` 恢复副本。
- 同一进程内重复加载时复用同一个同步引擎，不再重复监听端口。
- 提供可分发安装包（zip / tgz）与 `install.ps1`。

## 0.1.0

- 首次发布：局域网发现、SAS 配对、会话追加合并、工作区并集、LWW 文件同步、附件与缓存、设置面板。






