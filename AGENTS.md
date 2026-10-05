# AGENTS.md — 开发与维护须知

给**改这个仓库的人（和 AI 代理）**。用户视角的说明在 [README.md](README.md)。
原则：这里只写**能改变你行为的信息** —— 命令、不能动的约束、会踩的坑。设计背景与历史演进在`TODO.md`，**不要往这里搬**。

## 1. 概况

Electron + React + TS 桌面应用：本地视频（可带字幕）经系统 FFmpeg 重编码后推到 RTMP，按播放列表连续串流。
**不打包 FFmpeg**（运行时探测），**不做单文件便携 exe / 安装包**（`--dir` 绿色版，状态写在自身 `Data/`）。

```
src/shared/     类型契约 · 默认值 · i18n 文案表 · RTMP 拼接
src/main/       入口 · IPC · FFmpeg 探测/命令构建 · 串流引擎 · 存储 · obs-websocket
src/preload/    window.streamer
src/renderer/   React 界面
.test/          自动化验证（unit / e2e 两个入口）—— **只放测试**，见 §8
build/          图标 · data-placeholder（打包成程序目录的 Data/）
.github/workflows/  checks.yml（门禁）· build.yml（产物）· release.yml（附 release）
```

## 2. 命令

```bash
pnpm install        # 不要加 --ignore-scripts（§5）
pnpm dev            # 开发模式      pnpm typecheck   # 两个 project
pnpm build          # 编译到 out/   pnpm test        # = test:unit
pnpm run test:unit  # 非 Electron：命令构建 + 真实转码/字幕 + 本地推流 + obs-websocket + 文案表
pnpm run test:e2e   # Electron；可只跑指定套件：pnpm run test:e2e ui presets
pnpm run test:ci    # typecheck → build → unit → e2e
pnpm dist           # Windows 绿色版
```

打包三平台（`--mac` 只能在 macOS 上跑；`--win`/`--linux` 可在任意桌面系统交叉打目录版）：

```bash
pnpm exec electron-builder --win   --x64 --dir --config electron-builder.config.cjs
pnpm exec electron-builder --linux --x64 --dir --config electron-builder.config.cjs
pnpm exec electron-builder --mac   --x64 --dir --config electron-builder.config.cjs
```

工具链：Node `26.7.0` / pnpm `12.8.1`（`package.json` 的 `engines`，CI 同样钉住）。
`test:unit` 现场打包被测模块，**不需要先 build**；`test:e2e` 需要 `out/`。
个别阈值贴着实测值（缓冲领先量）会偶发波动：失败先单独重跑一次再判断是不是回归。

CI：`checks.yml`（门禁，唯一实现，另两个 `uses:` 它）→ `build.yml`（push main：打三平台 zip → artifact，
**不碰 release**）/ `release.yml`（release created：同上 → `softprops/action-gh-release` 附上去）。
artifact **只放最终 zip**；Windows/Linux 同一 Ubuntu job 分 step，macOS 单独 runner。

## 3. 不能动的约束

- **双引擎管道**：编码 stdout(fd1, 裸 MPEG-TS) → Node → 推流 stdin；fd2 = ffmpeg 日志，fd3 = `-progress`。
  这一层试过的其它传输（concat manifest / `-follow` / 命名管道 / HTTP+reconnect / UDP）都因 EOF 或换段 abort
  不可用，**不要重试**。见 `src/main/stream/playout.ts`
- **换文件两条路径刻意不同**：自然播完**只重启编码器**（RTMP 会话不动）；跳过/跳转**丢弃缓冲 + 重开会话**。
  重开期间 `Engine.restartingSession` 为真时 `onEncoderExit` 必须直接返回，否则跳转目标自己的完成事件会拆掉新会话
- **蓝条只能由推流位置改写**：`currentIndex`/`positionSec`/`completedSec`/`itemDuration` 的合法入口只有
  `onPublished()` 与 `moveViewerTo()`；编码器的位置记在 `encoderIndex`/`encoderItemDuration`。播放列表
  `done`/`live` 只由 `markPlayedThrough()` 按推流位置决定。绿条取 `Playout.getEncodedSec()`，**不要**用
  `completedSec + lead` 推算（段边界会错）。两条回归断言在 `.test/engine-run.cjs`，`enginebuffered` 会再跑一遍
- **领先上限**：超限就 `pause` 编码 stdout，等推流吃到 `上限 - max(4, 上限*0.25)` 再恢复。**不要改回
  「喂数据半路无条件暂停」** —— 数据收不回、`encodedSec - publishedSec` 不会自己变小，pump 会自锁（实测把
  35s 截成 16.9s）。`BUFFER_SEC_MIN/MAX = 12/300`，下限是实测值（换文件约 5.8–7.5s）
- **状态只在程序目录的 `Data/`**：`store/paths.ts` 重定向 Electron 的 userData/sessionData/cache，
  **绝不读写 `%APPDATA%`**（旧迁移代码已删，不要恢复）
- **已移除的功能不要恢复**：文件内 seek、暂停、`%APPDATA%` 迁移
- **i18n**：文案全在 `src/shared/i18n/messages.ts`（`EN` 基准 + `ZH`/`JA` 同键），`TranslationKey` 由 `EN` 推导，
  写错 key 是编译错误。
  - **不要给 `src/shared/i18n/*` 加依赖**（main / preload / renderer / `.test/*.bundle.mjs` 都会打包它）
  - **会被离线 harness 单独打包的主进程模块不许 `import '../i18n'`**：那条链依赖 `electron`，esbuild 的 ESM 输出
    在**加载时**就 `Dynamic require of "child_process" is not supported` 炸掉（`probe.ts`、`obs/websocket.ts`、
    `stream/playout.ts` 各踩过一次）。解法是注入：显式 `language` 参数，或 `PlayoutCallbacks.t` /
    `ObsWebSocketDeps.t` / `EngineDeps.getLanguage()`
  - 语言切换要立刻影响主进程文本：`IPC.setLanguage` 写盘并广播 `evtSettings`；主进程侧**用的时候现取**，
    不要在模块顶层缓存翻译函数或语言值
  - 文案表的一致性由 `test:unit` 第 1 节逐键校验（三表键集、空值、占位符）＋ `pnpm typecheck`
    （`Catalog<TranslationKey>` 缺键即报错）兜底，**不需要额外的维护脚本**

## 4. 界面文字要求（改文案前必读）

**界面只写终端用户需要知道的：这个设置做什么、代价是什么、下一步点哪里。不写内部实现、模块分工、
构建/调试细节。** 日志（`main.*` 文案与运行日志面板）不受此限，那里越详细越好。

- 每个可见字符串都必须是 `messages.ts` 的 key，三张表同名同键；英文表是基准，
  改中文/日文时**不要只改一张**（`pnpm test:unit` 会逐键断言三张表）
- 标签用名词短语；提示一句话。技术专名保留原文（H.264、AAC、FLV、MPEG-TS、libx264、`ffmpeg`、单位与数值），
  **不出现**内部术语（滤镜名、libass、协议请求名、双引擎/缓冲深度、模块名、文件路径）
- 反面例子（都曾存在，已清理）：`(libass)`、把 `SetStreamServiceSettings`/`StartStream`/`StopStream` 列进提示、
  `每 1 秒约占 码率/8 KB 内存`、`关闭后只保留 info 及以上——排查串流问题需要它，长期挂机可以关掉`
- 正面例子：`高度自适应` · `关闭后保持源分辨率` · `兼容 obs-websocket 5.x。已实现推流地址、开始与停止串流；
  其余请求一律返回成功`
- 被 JSX 切开的复合句按段拆成独立 key（`xxxHint1…N`），三张表都要有，这样才能按语言调整语序

## 5. 坑

- **不要用 PowerShell 碰源码**：一律 Edit 工具。`Get-Content -Raw`+`Set-Content` 在 Windows PowerShell 5.1 下按
  ANSI 解码，中文注释/断言会变 `?`、文件语法直接坏掉（踩过，只能 `git checkout`）。批量改文案写 `.mjs` 脚本，
  用 `fs.readFileSync(..., 'utf8')`
- **`String.replace` 替换串里的 `$` 是反向引用**（`$1`、`$&`、`` $` ``）：用函数式替换
  `replace(re, () => literal)`，否则会静默写出错行（踩过：一个 `$` 前缀顶掉了相邻的 key）
- **改完文案/代码要跑 `pnpm test:unit`**：`.test/*.bundle.mjs` 是从源码现场打包的生成物，
  单独跑 `node .test/harness.mjs` 会用旧 bundle 得出假结论
- **`fd 1` 是二进制**：不要 `setEncoding`、不要挂第二个 `data` 监听（这是「ingest 收到 0 字节」的全部原因，
  非法字节换成 U+FFFD 后不可逆，整条链路静默失效）
- **挂 `data` 监听前想清楚要不要 pause**：`on('data')` 让流进入 flowing，之后 `pause()` 已经晚了
- **kill 是异步的**：被杀进程的数据与 exit 事件还会到达，不按身份过滤会污染转发流、把完成事件算到别的段上
- **esbuild 只能从 pnpm store 找**（`.pnpm/@esbuild+<platform>-<arch>@<ver>/…` 原生二进制，或
  `.pnpm/esbuild@<ver>/node_modules/esbuild/bin/esbuild` 兜底）：顶层没有 `.bin/esbuild`，`require.resolve` 也
  `MODULE_NOT_FOUND`。逻辑内联在 `.test/build-bundles.mjs` 与 `.test/harness.mjs`
- **不要用 `--ignore-scripts` 绕 build script**：esbuild 的 postinstall 正是提供上面那个二进制的步骤，
  跳过就 `esbuild not found`（踩过两次）
- **测试 ingest 是 `ffmpeg -listen 1`，一次只接一个连接**：跳转会重开会话，必须 `waitForListener()`；
  它对管道写的 FLV 头是坏的，用 `patchFlvHeader()` 就地修（9 字节头 + 4 字节 PreviousTagSize，第一个 tag 在
  偏移 13，字节 5..8 是 DataOffset 必须保持 9）
- **测试 fixture 分辨率必须互不相同**：harness 靠画面认文件（曾两个都是 1280x720 导致误判）
- **UI 套件要显式把 `buffered`/`bufferSec` 写进 `settings.json`**，否则跑哪条管道取决于默认值 ——
  覆盖的是另一条代码路径且不报错
- **改 UI 结构要同步测试选择器**（把百分比从 `.progress-pct` 挪到 `.timeline-pct` 曾静默弄坏一条断言）
- **「测试连接」必须与正式推流共用参数构建**（`applyVideoEncoderArgs`/`applyAudioArgs`/`pixelFormatFor`/
  `encoderArgFor`）：它曾自带硬编码参数，服务器拒绝正式流时仍报成功。新增编码设置时**同时**想清楚测试里怎么体现，
  并把替代行为写进 `RtmpTestResult.notes`
- **两条管道的诊断日志同一处产出**（`Engine.logStreamChoice()`）：默认走双引擎，漏了就只有单进程路径有诊断
- **UI e2e 固定 `--lang=zh-CN` 且重置 `settings.json` 的 `language`**：套件断言中文控件文字，否则随开发机语言漂
- **测试合成源有物理上限**（画面压到 720p、音频恒 44.1kHz 单声道正弦波）：断言要写在**收到的流**上，
  只查命令行会漏掉 ffmpeg 协商回来的结果

## 6. 敏感信息（硬性要求）

**不要把本机相关敏感信息写进仓库**：环境变量值、密钥/token/密码、真实推流地址与串流密钥、内网主机名与端口、
个人目录绝对路径（`C:\Users\<name>\…`）、机器名、代理与证书配置。

- 示例一律用占位符：`rtmp://127.0.0.1/live/`、`example.com`、`<your-stream-key>`、`app.getPath(...)`
- 测试与 fixture 只用 `127.0.0.1` 与随机端口
- 预设**设计上明文保存推流地址与密钥**，所以 `Data/`（含 `presets.json`/`settings.json`）、`release/`、`out/`
  都在 `.gitignore` 里：不要提交，也不要贴进 issue/日志
- 提交前自查 `git diff`：不应出现真实凭据、真实服务器地址或本机绝对路径
- 本机特定配置放进 `Data/settings.json`（运行时状态，不入库），不要写进源码或脚本

## 7. 测试范围

`test:unit` 与 `test:e2e` 全绿是提交前提；断言数量随功能增长，以实际输出为准。

- **unit**：命令构建（字幕滤镜转义、分辨率三态、CBR/VBR/CRF、像素格式与硬件编码器映射、RTMP 拼接、音画偏移）
  + **真的执行生成的命令**再解码校验 + 字幕烧录（外挂与内嵌轨各一次，`signalstats` 验证字幕区字形像素）
  + 编码缓冲上限实测 + 本地推流 + obs-websocket 端点 + 文案表三语言键集/占位符/空值
- **e2e**（CDP 驱动）：`ui`（启动、播放列表与字幕恢复、开始/停止、跳转、语言切换落盘、日志面板）·
  `features`（拖入、串流中锁定、密钥掩码、日志留存、流选择诊断）· `presets`（保存/套用/改名/删除、
  obs-websocket 块落盘与还原）· `layout`（切选项卡播放区不位移）· `datadir`（开发构建/打包版/移动后都写在
  程序目录且不写 Roaming）· `engine` 与 `enginebuffered`（同一驱动器的两条管道）
- 端到端都用 `ffmpeg -listen 1` 当下游，不需要外部流媒体服务；套件带看门狗（超时杀残留进程并以 3 退出）；
  被测应用带 `STREAMER_E2E=1`（窗口移出屏幕 + 点击穿透）

## 8. `.test/` 只放测试

**`.test/` 里只保留「反复运行的测试」。** 一次性的探索、诊断、修复脚本写完删掉，不要留在仓库里 ——
它们会和时间一起腐坏（引用了已改名的函数、把临时文件写进 `.test/`），而且下一个人分不清哪个还在用。

- 允许留下：`unit.mjs` / `e2e.mjs` 两个入口与其套件、`harness*.mjs`、`build-bundles.mjs`、
  `make-fixtures.mjs`、`obs-websocket.mjs`、`engine-run.cjs`，以及**被文档明确引用**的辅助工具
- **写 helper 前先确认现有测试覆盖不了它**：多数「看一下文案 / 对比两张表 / 查一个 key」的需求，
  `test:unit`（文案表三语言逐键校验）或 `pnpm typecheck`（`Catalog<TranslationKey>` 缺键即报错）已经覆盖，
  再写一个脚本就是重复
- **新增常驻工具必须同时在 AGENTS.md 或 TODO.md 里写明用途**：没被文档引用的脚本一律视为一次性脚本，
  用完即删
- 生成物（`*.bundle.mjs`、fixture、`*.json` 报告、截图）由 `.gitignore` 覆盖，不要提交
