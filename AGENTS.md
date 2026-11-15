# AGENTS.md

给**改这个仓库的人（和 AI 代理）**。终端用户的功能说明见 [README.md](README.md)（[English](docs/README.en.md) · [日本語](docs/README.ja.md)）。

开工前先记住四条：

1. Electron + React + TS 桌面应用。**不打包 FFmpeg**（运行时探测），**不做安装包**（`--dir` 绿色版，状态只写在程序目录 `Data/`）。
2. 串流有缓冲推流（双引擎）与关闭缓冲（单进程）两套管道，换文件与进度归零的路径不同。改引擎前先读「不能动的约束」。
3. 文案全在 `src/shared/i18n/messages.ts`，三语言同键；界面只写用户需要知道的事。
4. `test:unit` 与 `test:e2e` 全绿是提交前提；真实地址、密钥与本机路径不进仓库。

## 文档分工

| 文件 | 负责内容 |
|---|---|
| `README.md` | 中文用户文档：功能、界面、安装、使用、环境要求、已知限制、数据与备份 |
| `docs/README.en.md` / `docs/README.ja.md` | 英文 / 日文用户文档，与 `README.md` 同步 |
| `AGENTS.md`（本文件） | 架构、不能动的约束、坑、构建与测试、CI |
| `TODO.md` | 本地草稿：未完成事项与设计背景；在 `.gitignore` 里，不对外 |

- 功能行为变化改三份 README；模块、命令、构建、测试、CI 变化改本文件；没做完的事只进 `TODO.md`。
- 同一件事只在一处写：README 不引用 AGENTS / TODO（用户不需要知道开发文档），本文件不搬用户向说明。
- 新增常驻脚本、工具或文档，必须在本文写明用途；没被文档引用的按一次性脚本处理。

## UI 文案规范

面向终端用户的文字（界面、README、错误与提示）只回答「这是什么、能做什么、怎么做、有什么限制」，不解释实现方式。

- 只写用户看得见的结果和能做的操作；不写代码路径、模块名、运行时、缓存、探测、滤镜名、库名、构建与调试细节。
- 配置项可以写用户需要提供的内容（FFmpeg 路径、地址、密钥、字幕文件），但不要解释内部如何处理。
- 提示语一句话；范围和限制只在会影响用户决策时出现。错误信息要告诉用户下一步能做什么，不能只抛内部错误名。
- 日志（`main.*` 文案与运行日志面板）与诊断信息不受此限，那里越详细越好。
- 每个可见字符串都必须是 `messages.ts` 的 key：`EN` 是基准，`ZH` / `JA` 必须同键，改文案不要只改一张表（`pnpm test:unit` 会逐键断言）。
- 标签用名词短语，提示一句话。技术专名保留原文（H.264、AAC、FLV、MPEG-TS、libx264、`ffmpeg`、单位与数值）。
- 界面文案不绑定具体协议：除软件名与协议下拉里的协议专名外，不出现 RTMP 等字样，描述用「推流 / 直播 / 流媒体服务器」；README 的协议说明除外。
- 被 JSX 切开的复合句按段拆成独立 key（`xxxHint1…N`），三张表都要有，才能按语言调整语序。
- 图标只用 lucide，不用 emoji：文案表里没有 ▶ / ⏹ / 📂 之类前缀。
- 反面例子（都曾存在，已清理）：`(libass)`、把 `SetStreamServiceSettings` / `StartStream` / `StopStream` 列进提示、`每 1 秒约占 码率/8 KB 内存`。正面例子：`高度自适应`、`关闭后保持源分辨率`。

## 概况

Electron + React + TS：本地视频（可带字幕）经系统 FFmpeg 重编码后，按所选协议推到 RTMP / SRT / RTSP / WHIP，按播放列表连续串流。

```text
src/shared/      类型契约 · 默认值 · i18n 文案表 · 推流目标/协议拼接
scripts/         build-info.mjs（编译前写 build-info.json，应用从它读版本）
src/main/        入口 · IPC · FFmpeg 探测/命令构建 · 串流引擎 · 存储 · obs-websocket
src/preload/     window.streamer
src/renderer/    React 界面（Tailwind v4 + shadcn/ui）
test/            自动化验证（unit / e2e 两个入口）
build/           图标 · data-placeholder（打包成程序目录的 Data/）
.github/workflows/  checks.yml（门禁）· build.yml（产物）· release.yml（附 release）
```

两套后端**共存**：Electron 侧原样保留（main 分支持续 merge 进来，其测试套件仍是行为契约），
feat-tauri分支的Tauri 侧是新增文件；shared/ 与 Data/ 的文件格式两端通用。见 §11。

## 命令

```bash
pnpm install        # 不要加 --ignore-scripts；需要的安装脚本由 pnpm-workspace.yaml 的 allowBuilds 放行
pnpm dev            # 开发模式
pnpm typecheck      # node + web 两个 project
pnpm build          # 编译到 out/
pnpm test           # = test:unit
pnpm run test:unit  # 纯 Node：命令构建 + 真实转码/字幕 + 本地推流 + obs-websocket + 文案表
pnpm run test:e2e   # Electron + CDP；可只跑指定套件：pnpm run test:e2e ui presets
pnpm run test:ci    # typecheck → build → unit → e2e
pnpm dist           # Windows x64 绿色版
```

`dev` / `build` / `dist` 先跑 `scripts/build-info.mjs`：把 package.json 版本、commit 前 10 位、是否 nightly（编译 commit 无 tag 即 nightly）与构建时间写进 `build-info.json`，应用从它读版本（`src/main/buildInfo.ts`）。

其它平台打目录版（架构用 `--arm64`；`--mac` 只能在 macOS 上跑，`--win` / `--linux` 可交叉）：

```bash
pnpm exec electron-builder --win   --x64 --dir --config electron-builder.config.cjs
pnpm exec electron-builder --linux --x64 --dir --config electron-builder.config.cjs
pnpm exec electron-builder --mac   --x64 --dir --config electron-builder.config.cjs
```

非 x64 产物目录带架构后缀（`win-arm64-unpacked` / `linux-arm64-unpacked` / `mac-arm64`），x64 是 `win-unpacked` / `linux-unpacked` / `mac`。electron-builder 自行下载目标平台的 Electron dist。

工具链 Node `26.7.0` / pnpm `12.8.1`（`engines`，CI 同样钉住）。`test:unit` 现场打包被测模块，不需要先 build；`test:e2e` 需要 `out/`。个别阈值贴着实测值（缓冲领先量），偶发波动先单独重跑一次再判断回归。

## 不能动的约束

- **双引擎管道**：编码 stdout（fd1，裸 MPEG-TS）→ Node → 推流 stdin；fd2 是 ffmpeg 日志，fd3 是 `-progress`。其它传输方式（concat manifest / `-follow` / 命名管道 / HTTP+reconnect / UDP）都会在 EOF 或换段时 abort，**不要重试**。见 `src/main/stream/playout.ts`。
- **换文件两条路径刻意不同**：自然播完**只重启编码器**（RTMP 会话不动）；跳过 / 跳转**丢弃缓冲 + 重开会话**。重开期间 `Engine.restartingSession` 为真时 `onEncoderExit` 必须直接返回，否则跳转目标的完成事件会拆掉新会话。
- **判断发布会话是否还活着只用 `Playout.isSessionActive()`**（把推流进程的 600ms 预热窗口也算作会话），**不要**用 `isPusherRunning()`：编码是全速跑的，短队列会在预热窗口内编完，误判成「没有会话」会让它一帧都不发就结束。
- **蓝条只能由推流位置改写**：`currentIndex` / `positionSec` / `completedSec` / `itemDuration` 的合法入口只有 `onPublished()` 与 `moveViewerTo()`；编码器位置记在 `encoderIndex` / `encoderItemDuration`。`done` / `live` 只由 `markPlayedThrough()` 按推流位置决定。绿条取 `Playout.getEncodedSec()`，**不要**用 `completedSec + lead` 推算（段边界会错）。回归断言在 `test/engine-run.cjs`，`enginebuffered` 会再跑一遍。
- **串流结束必须归零**（自然播完 / 手动停止 / 发布进程丢失），唯一出口是 `resetViewerTimeline()`：`completedSec` 是「当前队列里的位置」，队列换掉后不可能还成立；不清会把上一批进度留在新队列上。只有 `start()` 才会抹掉。
- **缺轨的文件要补轨**：源文件没有音频（音频编码不是 `copy` / `none`）→ `anullsrc` 生成静音；没有可用视频（视频编码不是 `copy`）→ `color=c=black` 生成黑场。两者都按对应那一路的编码设置编码，并加 `-shortest` —— 只推一路会被 ingest 直接拒绝。生成源**必须带 `d=`（剩余时长 +10s）**，否则会被全速读到底；源文件必须留在 input 0，生成输入排在它之后，双引擎经 `BuiltEncoderArgs.inputs` 交给 `Playout.startEncoder`。
- **领先上限**：超限就 `pause` 编码 stdout，等推流吃到 `上限 - max(4, 上限*0.25)` 再恢复。**不要改回「喂数据半路无条件暂停」** —— 数据收不回、`encodedSec - publishedSec` 不会自己变小，pump 会自锁。`BUFFER_SEC_MIN/MAX = 12/300`，下限是换文件实测值。
- **协议决定容器与网络格式**：协议（rtmp / srt / rtsp / whip，`src/shared/protocol.ts`）唯一推导 ffmpeg muxer 与容器（rtsp / whip 无容器），并钳制传输方式（只有 rtsp 能选 tcp / udp；whip 固定 udp —— TCP 只承载 HTTP 握手，媒体是 ICE / DTLS / SRTP 报文）。`OutputSettings.container` 是派生值，**不要再给容器做 UI 选择**。
- **串流密钥按协议解释**：rtmp / srt / rtsp 的密钥都直接追加进地址（srt 不生成 `passphrase` 参数：加密口令由用户填进串流密钥字段），whip 走 `-authorization`（JWT）。协议下拉没有「自动检测」项：地址输入框失焦时自动跳到检测出的协议，之后可手动改。
- **状态只在程序目录的 `Data/`**：`store/paths.ts` 重定向 Electron 的 userData / sessionData / cache，**绝不读写 `%APPDATA%`**（旧迁移代码已删，不要恢复）。
- **凭据只在日志出口脱敏**：`src/main/log-redact.ts` 在 `emitLog` 与测试结果返回处把密钥部分整体替换成 `*****`。`maskTarget(server, key, protocol)` 用 `buildPushTarget` 重建显示形式，`redactText` 只做字面替换，**不要**用正则去猜目标串里哪一段是密钥。脱敏边界是「串流密钥」字段，地址在界面明文显示，写进地址里的凭据不在保护范围。命令构建器必须拿真实 target 去 spawn，新增会打印地址 / 密钥的日志必须经过 `emitLog`；用未保存的地址 / 密钥做测试连接时，先用本次测试的 `secrets` 脱敏。
- **已移除的功能不要恢复**：文件内 seek、暂停、`%APPDATA%` 迁移。
- **i18n**：文案全在 `src/shared/i18n/messages.ts`（`EN` 基准 + `ZH` / `JA` 同键），`TranslationKey` 由 `EN` 推导，写错 key 是编译错误。
  - **不要给 `src/shared/i18n/*` 加依赖**（main / preload / renderer / `test/*.bundle.mjs` 都会打包它）。
  - **会被离线 harness 单独打包的主进程模块不许 `import '../i18n'`**：那条链依赖 `electron`，esbuild 的 ESM 输出在加载时就 `Dynamic require of "child_process" is not supported` 炸掉。解法是注入：显式 `language` 参数，或 `PlayoutCallbacks.t` / `ObsWebSocketDeps.t` / `EngineDeps.getLanguage()`。
  - 语言切换要立刻影响主进程文本：`IPC.setLanguage` 写盘并广播 `evtSettings`；主进程侧**用的时候现取**，不要在模块顶层缓存翻译函数或语言值。
  - 一致性由 `test:unit` 第 1 节逐键校验（三表键集、空值、占位符）＋ `pnpm typecheck`（缺键即报错）兜底，**不需要额外的维护脚本**。
- **界面栈**：Tailwind v4 + shadcn/ui（style `base-nova`、base color `zinc`、theme `blue`）。组件是源码，在 `src/renderer/src/components/ui/`，增减用 `pnpm dlx shadcn@latest add <name>`（会覆盖本地改动）。设计令牌与全局层都在 `src/renderer/src/styles.css`（唯一入口），alias 由 `components.json` + tsconfig 的 `@renderer/*` 决定。渲染层依赖装在 devDependencies（Vite 打包，`electron-builder` 的 `files` 排除 node_modules）。
- **两套配色，一个开关**：`:root` 亮色、`.dark` 暗色，`settings.theme`（`light` / `dark` / `system`，默认 `system`）决定 `<html>` 上有没有 `.dark`。`main.tsx` 先按系统设置画第一帧，`App.tsx` 拿到设置后纠正并在 `system` 下持续跟随系统；主进程用 `windowBackground()` / `syncWindowTheme()` 同步窗口底色。新增颜色一律进令牌，别写死深浅色值。
- **语言与界面风格是应用状态**：顶层 `AppSettings` 字段（与 `debugLogging` 一样），**不在预设里** —— 预设只带 `SessionSettings`。改这两个要显式走 `setLanguage` / `saveSettings`，不要塞进预设结构。
- **`native-select.tsx` 有一处本地补丁**：`className` 落在 `<select>` 上、`wrapperClassName` 给定位外壳（e2e 用原生 API 驱动这些下拉），`shadcn add` 覆盖后要重新打上。
- **e2e 依赖的 DOM 契约**：`.playlist` / `.player` / `.settings-body` / `.field` / `.field-label` / `.field-hint` / `.field-grid` / `.unit-input` / `.seg-btn` / `.log-line lv-*` / `.timeline-*` 等类名是测试钩子，改结构要同步 `test/*-e2e.mjs`。几个控件**必须保持原生**：`<select>`（`.preset-select`、`.unit-input select`、tune、字幕方式）、分辨率里的两处 `<input type="checkbox">`（`.res-enable` / `.auto-check`）—— 套件用原生 setter 与 `.checked` 驱动；其余开关是 shadcn `Switch`（`role="switch"`，测试读 `aria-checked`）。
- **播放列表宽度记在 `settings.json`**（顶层字段 `playlistWidthPercent`，与 `theme` / `language` 一样不进预设）：面板只在挂载时读一次（`initialQueueWidthRef`），拖动结束时写回 —— 把保存值当 `defaultSize` 一直喂回去会把分隔条拉回原位。另外**面板库把裸数字当像素**：`defaultSize={27}` 是 27px，必须写字符串 `"27"` 才是 27%。

## 坑

- **不要用 PowerShell 改源码**：一律用 Edit 工具。`Get-Content -Raw` + `Set-Content` 在 Windows PowerShell 5.1 下按 ANSI 解码，中文注释 / 断言会变 `?`，文件语法直接坏掉。批量改文案写 `.mjs` 脚本，用 `fs.readFileSync(..., 'utf8')`。
- **`String.replace` 替换串里的 `$` 是反向引用**（`$1`、`$&`）：用函数式替换 `replace(re, () => literal)`，否则会静默写出错行。
- **改完文案 / 代码要跑 `pnpm test:unit`**：`test/*.bundle.mjs` 是从源码现场打包的生成物，单独跑 `node test/harness.mjs` 会用旧 bundle 得出假结论。
- **起 Electron 一律经 `electronEnv()`（`test/harness-util.mjs`）拿环境**：宿主若把 `ELECTRON_RUN_AS_NODE=1` 导出给子进程，Electron 会以纯 Node 启动，没有窗口与 CDP，命令行开关回 `bad option: --…` 后立即退出（退出码 9）。该函数同时清掉 `NODE_OPTIONS`、`ELECTRON_NO_ATTACH_CONSOLE` 并置 `STREAMER_E2E=1`；不要在调用点自己拼 `process.env`。
- **`fd 1` 是二进制**：不要 `setEncoding`、不要挂第二个 `data` 监听 —— 这是「ingest 收到 0 字节」的全部原因。挂 `data` 前想清楚要不要 pause：`on('data')` 让流进入 flowing，之后 `pause()` 已经晚了。
- **kill 是异步的**：被杀进程的数据与 exit 事件还会到达；不按身份过滤会污染转发流、把完成事件算到别的段上。
- **打包被测模块用 esbuild 的 JS API（`require('esbuild').buildSync()`），不要找 CLI**：`.bin/esbuild` 不存在，`esbuild/bin/esbuild` 的磁盘格式随平台变（ELF / sh / `.cmd`），猜错就报 SyntaxError。`esbuild` 必须是直接依赖（否则 CI 缺 `@esbuild/<platform>` 平台包）；**不要用 `--ignore-scripts`** 绕 build script（postinstall 正是安装平台二进制的一步）。
- **测试 ingest 是 `ffmpeg -listen 1`，一次只接一个连接**：跳转会重开会话，必须 `waitForListener()`；它对管道写的 FLV 头是坏的，用 `patchFlvHeader()` 就地修（9 字节头 + 4 字节 PreviousTagSize，第一个 tag 在偏移 13，字节 5..8 的 DataOffset 必须保持 9）。
- **测试 fixture 分辨率必须互不相同**：harness 靠画面认文件。
- **UI 套件要显式把 `buffered` / `bufferSec` 写进 `settings.json`**，否则跑哪条管道取决于默认值，覆盖的是另一条代码路径且不报错。
- **e2e 里写输入框用 `focusin` / `focusout`，不要用 `focus()` / `blur()`**：数值框与地址框都在失焦时提交，被测窗口不一定持有系统焦点，`focus()` 会静默无效（症状是「文本变了、模型没变」）。React 的 `onBlur` 映射到 `focusout`，显式 dispatch 才与真实点击等价。
- **改 UI 结构要同步测试选择器**（百分比从 `.progress-pct` 挪到 `.timeline-pct` 曾静默弄坏断言）。设置面板的锁定用 `inert`，但要挂在滚动容器内层的 `.settings-fields` 上；挂到 `.settings-body` 会让串流中无法滚动查看设置。
- **「测试连接」必须与正式推流共用参数构建**（`applyVideoEncoderArgs` / `applyAudioArgs` / `pixelFormatFor` / `encoderArgFor`）：它曾自带硬编码参数，服务器拒绝正式流时仍报成功。新增编码设置时同时想清楚测试里怎么体现，并把替代行为写进 `RtmpTestResult.notes`。
- **两条管道的诊断日志同一处产出**（`Engine.logStreamChoice()`）：默认走双引擎，漏了就只有单进程路径有诊断。
- **UI e2e 固定 `--lang=zh-CN` 且重置 `settings.json` 的 `language`**：套件断言中文控件文字，否则随开发机语言漂。
- **测试合成源有物理上限**（画面压到 720p、音频恒 44.1kHz 单声道正弦波）：断言要写在**收到的流**上，只查命令行会漏掉 ffmpeg 协商回来的结果。

## 敏感信息

**不要把本机相关敏感信息写进仓库**：环境变量值、密钥 / token / 密码、真实推流地址与串流密钥、内网主机名与端口、个人目录绝对路径（`C:\Users\<name>\…`）、机器名、代理与证书配置。

- 示例一律用占位符：`rtmp://127.0.0.1/live/`、`example.com`、`<your-stream-key>`、`app.getPath(...)`。
- 测试与 fixture 只用 `127.0.0.1` 与随机端口。
- 预设**设计上明文保存推流地址与密钥**，所以 `Data/`（含 `presets.json` / `settings.json`）、`release/`、`out/` 都在 `.gitignore` 里：不要提交，也不要贴进 issue / 日志。
- 提交前自查 `git diff`：不应出现真实凭据、真实服务器地址或本机绝对路径；本机特定配置放进 `Data/settings.json`。

## 测试与 CI

`test:unit` 与 `test:e2e` 全绿是提交前提；断言数量随功能增长，以实际输出为准。

- **unit**（纯 Node，不需要先 build）：命令构建（字幕滤镜转义、分辨率三态与取偶、CBR / VBR / CRF、HEVC profile / x265 私有参数、像素格式与硬件编码器映射、协议目标 / 密钥拼接、音画与字幕延迟）；真的执行生成的命令再解码校验；字幕烧录（外挂与内嵌轨，`signalstats` 验证字形像素）；缺轨补轨；编码缓冲上限实测；本地推流；obs-websocket 端点；三语言文案表键集 / 占位符 / 空值。
- **e2e**（Electron + CDP，需要 `out/`）：`ui`（启动、播放列表与字幕恢复、开始 / 停止、跳转、语言切换落盘、日志面板）、`features`（拖入、串流中锁定、密钥掩码、日志留存、流选择诊断）、`presets`（保存 / 套用 / 改名 / 删除、obs-websocket 配置落盘与还原）、`layout`（切选项卡播放区不位移）、`datadir`（开发构建写在程序目录且不写 Roaming）、`engine` 与 `enginebuffered`（两条管道）。
- 端到端都用 `ffmpeg -listen 1` 当下游，不需要外部流媒体服务；套件带看门狗（超时杀残留进程并以 3 退出）；被测应用带 `STREAMER_E2E=1`（窗口移出屏幕 + 点击穿透）。
- **`test/` 只放反复运行的测试**：一次性探索 / 诊断 / 修复脚本用完删掉。允许留下两个入口与套件、`harness*.mjs`、`build-bundles.mjs`、`make-fixtures.mjs`、`obs-websocket.mjs`、`engine-run.cjs`，以及被本文明确引用的工具。新增 helper 前先确认现有测试覆盖不了；生成物（`*.bundle.mjs`、fixture、`*.json` 报告、截图）由 `.gitignore` 覆盖，不要提交。
- **CI**：`checks.yml` 是唯一门禁（`pnpm typecheck` + `test:unit`，Ubuntu 上装 `ffmpeg` 与 `libavcodec-extra`），`build.yml` 与 `release.yml` 都 `uses:` 它。`build.yml`（push main / 手动）打 zip → artifact，**不碰 release**；`release.yml`（release created）把同样的 zip 附到 release。artifact 只放最终 zip。
- **打包矩阵**：Windows / Linux 各 amd64、arm64 在 Ubuntu leg 上交叉编译（产物名用 amd64，electron-builder 参数是 x64）；macOS 在 `macos-latest` 上出 `mac-intel` 与裸 `mac` 两个 leg（Intel 版由 Apple 芯片交叉编译）。`build.yml` 与 `release.yml` 的矩阵必须同步改。

## Release note

发版时输出英文 release note，分类固定为 `UI`（用户可见的变化）/ `Backend`（引擎、IPC、存储、命令构建）/ `CI/CD`（workflow 与流水线）/ `Chores`（清理与重构）/ `Docs`，某类没有内容就整类省略。

每条一句，说清「改了什么、对谁有影响」；不写原因、不贴 diff、不写验证小节。功能开发与移除都要写。破坏性变更、需要用户手动操作的、以及未验证的部分，各自单独一条并在句子里点明。版本号只写在 `package.json`（`build-info.json` 由脚本生成），release note 里不要复制。
