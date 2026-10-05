# AGENTS.md — 开发与维护须知

面向**改这个仓库的人（和 AI 代理）**。用户视角的功能说明在 [README.md](README.md)，这里是构建、测试、
架构约定，以及踩过的坑。**动手前先读第 4 节「工程注意事项」，那一条条都是真的踩过的。**

---

## 1. 仓库布局

```
src/shared/          主进程与渲染进程共享：类型契约、默认值、i18n 文案表、RTMP 拼接规则
src/main/            主进程：入口、IPC、FFmpeg 能力探测/命令构建、串流引擎、存储、obs-websocket
src/preload/         contextBridge 暴露 window.streamer
src/renderer/        React 界面
.test/               自动化验证（unit / e2e 两套入口）
build/               图标与 data-placeholder（打包时复制成程序目录的 Data/）
.github/workflows/   checks.yml（共用门禁：类型检查 + 后端测试）· build.yml（打包产物）· release.yml（附到 release）—— 见 §2
```

产物只有一个：`release/win-unpacked/`（`--dir` 打包，绿色版）。**不生成单文件便携 exe，也不生成 NSIS 安装包**，
因为程序状态写在自身目录的 `Data/` 里 —— 整个文件夹就是完整可移动的副本。

## 2. 命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 开发模式（热重载）
pnpm typecheck        # 类型检查（node + web 两个 project）
pnpm build            # 编译主进程/预加载/渲染进程到 out/
pnpm start            # 用编译产物启动（不弹 DevTools）
pnpm dist             # 生成免安装目录版 release/win-unpacked/
```

测试：

```bash
pnpm test                # 默认跑 test:unit
pnpm run test:unit       # 非 Electron 全部：命令构建 + 真实转码/字幕渲染 + 本地推流 + obs-websocket
pnpm run test:e2e        # Electron 全部套件（ui → features → presets → layout → datadir → engine → enginebuffered）
pnpm run test:e2e ui     # 只跑指定套件，可写多个：node .test/e2e.mjs ui presets
pnpm run test:ci         # 类型检查 → 构建 → test:unit → test:e2e
```

`test:unit` 会按需生成 fixture、把被测模块从 `src/` 现场打包，再跑断言；`test:e2e` 需要先 `pnpm build`（`test:ci` 已包含）。
两套都会在首个失败处停下并给出失败项，`e2e` 还带看门狗：某个套件超时会被杀掉并以非零码报告，不会挂住整轮。

**个别断言的阈值贴着实测值，会偶发波动**：`unit` 的「编码领先被压在上限附近」（12s 上限 + 4s 容差，
实测 15.8–16.1s）和 `engine` 的领先量断言都属于这一类。失败时先单独重跑一次再判断是不是回归。

### 三个平台打包

```bash
pnpm exec electron-builder --win   --x64 --dir --config electron-builder.config.cjs
pnpm exec electron-builder --linux --x64 --dir --config electron-builder.config.cjs
pnpm exec electron-builder --mac   --x64 --dir --config electron-builder.config.cjs
```

`--mac` **只能在 macOS 上执行**（electron-builder 会直接拒绝：*Build for macOS is supported only on macOS*），
`--win` 与 `--linux` 在任意桌面系统上都能交叉打出目录版（目标是目录而非安装包，因此不需要 Wine）。

### CI

仓库有**三个 workflow**（`.github/workflows/`），其中一个是共用的门禁：

| 工作流 | 触发 | 做什么 |
| --- | --- | --- |
| `checks.yml` | 只被 `workflow_call` 调用 | 类型检查 → **后端测试**（`pnpm run test:unit`）。只在 Ubuntu 上跑，不打包、不上传、不启动 Electron |
| `build.yml` | push 到 `main`、手动 | 先 `uses: checks.yml`，通过后打包三个平台的**绿色版 zip** → 上传为 artifact（**不上传任何中间产物**） |
| `release.yml` | release created、手动 | 先 `uses: checks.yml`，再打包 + 最后把三个 zip **附到该 release**（`softprops/action-gh-release`，`if: github.event_name == 'release'`）；手动触发时只验证产物齐全，不写 release |

触发链是**一条直线**：`checks` 先跑，绿了才进打包 job（两个平台的打包 job 都写着 `needs: checks`），
`release.yml` 再多一个 `attach` job（`needs: [portable-linux-host, portable-macos]`）。
**两个工作流的差别只剩最后一步**：`build.yml` 停在 artifact，`release.yml` 附到 release。
门禁本身只有一份实现，两个工作流共用 `checks.yml` —— 以前是各自复制一遍，只会越改越不一样。

**macOS 上不再重复跑门禁**：它只负责编译 macOS 端（`needs: checks` 保证门禁已经绿过）。`runs-on: ubuntu-latest`
写在 `checks.yml` 的 job 上，是 job 级键，所以调用方也改不了它 —— 门禁就只有 Ubuntu 这一个出口。

- **门禁自带 ffmpeg**：CI 里没有 ffmpeg/ffprobe（runner 镜像不预装），而 `test:unit` 会真的转码，所以门禁直接从
  **Ubuntu 官方源**装：`apt-get install -y --no-install-recommends ffmpeg libavcodec-extra`。
  - **`libavcodec-extra` 不能省**：Ubuntu 把 GPL/专利相关的编码器拆到 `-extra` 变体里，基础 `ffmpeg` 依赖的是普通
    `libavcodec<NN>`。测试真的用 `libx264` 编码（fixture 生成、烧字幕转码、"复制回退软件编码"），还断言 `libx265`，
    缺了会一片 `Unknown encoder`。两个变体装的是同一个 `.so`，所以 `ffmpeg` 二进制不用换，只是多了编码器
- **`test:unit` 不需要先 `pnpm build`**：它把所有被测模块从 `src/` 现场 esbuild 打包（`.test/build-bundles.mjs`），
  所以门禁里没有 electron-vite 构建，`pnpm ci --ignore-scripts` 也就顺带跳过了 Electron 那 ~100 MB 的二进制下载。
  需要 `out/` 的只有 `test:e2e`
- 三个产物：`rtmp-file-streamer-win-x86_64.zip`、`rtmp-file-streamer-linux-x86_64.zip`、`rtmp-file-streamer-mac.zip`
- **Windows 与 Linux 在同一个 Ubuntu job 里交叉构建**（各占一个独立 step），macOS 单独一个 runner：这是 electron-builder 的硬约束，不是选择
- 压缩用各平台自带工具、纯 bash：Ubuntu 上用 `zip`（保留可执行位，Linux 启动器与 `chrome-sandbox` 解压后需要它），macOS 上用 `ditto`（`.app` 里的符号链接与签名只有它能保住）。**不用 tar.gz**：同一份产物实测 gzip -9 是 153.8 MB，zip 是 151 MB，更大且 Windows 用户更不好打开
- 工具链与本地开发**完全一致**（见 `package.json` 的 `engines`/`packageManager`），安装命令固定为 `pnpm ci --ignore-scripts`：本项目不依赖任何 postinstall

**Electron 那套 e2e 仍然不进 CI**（要窗口、要 CDP、要打包产物），CI 只跑非 Electron 的 `test:unit`。
门禁在 Ubuntu 上跑，所以断言里的时间阈值（见本节上面的「偶发波动」）会比开发机更容易贴边：
真红了先单独重跑一次再判断是不是回归。

### 随包附带 FFmpeg（可选）

默认**不**打包 FFmpeg（GPL 许可，且体积大）。若需要离线分发：把 `ffmpeg.exe`、`ffprobe.exe` 放进项目根的 `bin/`，
`electron-builder.config.cjs` 的 `extraResources` 会复制到 `resources/bin`，运行时优先使用它。

## 3. 架构约定

### 3.1 双引擎播出：为什么是「编码 stdout → Node → 推流 stdin」

单引擎时编码器必须带 `-re` 按 1× 读输入，硬件编码器预热期间（以及字幕密集段）速度会掉到 0.94× 并持续一段时间，
这期间远端播放端会卡。双引擎把它们拆开：

```
编码进程（不带 -re，全速跑）  --MPEG-TS-->  Node 中转  -->  推流进程（-re，稳定 1×）  -->  RTMP
```

选型时试过的传输方式与实测结果：

| 候选方案 | 实测结果 |
|---|---|
| concat manifest 追加分段 | ❌ `concat_read_header` 只解析一次，播完即退出；7 秒后追加第 2 段**完全无效** |
| `-follow 1` | ❌ 本地文件/manifest 上读 **0 字节**（该选项属于 http 协议） |
| 命名管道 `\\.\pipe\X` 作输入 | ⚠️ 能写入，但生产者退出即 EOF |
| HTTP 端点 + `-reconnect 1 -reconnect_at_eof 1`（ErsatzTV/Tunarr 做法） | ❌ 推流进程以 `0xBEBEBEBE` abort |
| UDP `udp://` | ⚠️ 唯一无 EOF 语义的原生传输，能熬过静默，但**读端在换段处 abort** |
| **编码 stdout → Node → 推流 stdin** | ✅ **采用**。推流 stdin 由本进程持有整个会话，编码进程来去都不产生 EOF |

关键实现：[`src/main/stream/playout.ts`](src/main/stream/playout.ts)。**文件描述符是契约的一部分**：

```
fd 1  编码 stdout   -> 裸 MPEG-TS，原样转发到推流 stdin
fd 2  编码 stderr   -> ffmpeg 自己的日志
fd 3  `-progress`   -> 机器可读进度，用来算时间轴
```

### 3.2 换文件：什么时候只重启编码器，什么时候两个都重启

**两条路径是刻意不同的**：

| 场景 | 行为 | 为什么 |
|---|---|---|
| **文件自然播完** | **只重启编码器**，推流进程与 RTMP 会话**不动** | 推流端已把交付的内容播完，没有 backlog，会话可以连续。这正是双引擎存在的意义 |
| **跳过 / 跳转** | **丢弃缓冲 + 重开 RTMP 会话** | 目标文件通常已在缓冲里，排在观众**还没看**的内容后面；已发布的时间轴无法回退，只有重开一条时间轴才能真正兑现跳转 |

实现位置：`Playout.restartSession()` ←→ `StreamEngine.launchBuffered()` 里的 `restartSession` 分支。
重开会话期间 `Engine.restartingSession` 为真，`onEncoderExit` 直接返回 —— 否则跳转目标自己的完成事件会把**正在开的会话拆掉**。

### 3.3 领先上限（缓冲有界）

`BUFFER_SEC_MIN/MAX = 12/300`（`src/shared/defaults.ts`），引擎在 `Playout` 里按 `leadLimitSec` 执行：
领先超过上限就 **pause 编码 stdout**，等推流把领先吃到 `上限 - max(4, 上限*0.25)` 再恢复；
另有 backstop（`上限*2+10` 秒无推流进展就恢复编码继续排空）。

- 下限 12 秒是实测的：换文件时上一段编码结束到下一段产出首个数据包要 5.8–7.5 秒
- **曾经试过中途掐断的版本，结论是行不通**：暂停条件会在喂数据半路生效，已写进管道的数据收不回，
  而 `encodedSec - publishedSec` 不会自己变小，pump 会自我锁死（实测把 phase 1 从 35s 截断到 16.9s）。
  现在的实现只作用于「新段起点 + 可回退的余量」，不要改回无条件中途暂停。
- 上限是内存约束：领先的每一秒都留在本进程内存里（约 码率/8 KB）

### 3.4 进度条上的两条时间轴

- 蓝色 `.timeline-fill` = `completedSec / total`，**观众已经收到的**
- 绿色 `.timeline-encoded-fill` = `encodedSec / total`，**编码进程已经跑到的**，画成主进度条**底边缘**的 4px 细条

`encodedSec` 来自 `Playout.getEncodedSec()`（已交付段偏移 + 当前段产出），不是 `completedSec + leadSec` 推算 ——
推算法在段边界会错。引擎取 `max(completedSec, 该值)`，保证绿条不会画到蓝条后面。

**蓝条只能由推流位置改写**（`currentIndex` / `positionSec` / `completedSec` / `itemDuration` 只描述观众），
合法写入口只有两个：`onPublished()`（推流进程报告越过了哪一段）与 `moveViewerTo()`（会话本身重开时）。
编码进程换文件（`advanceTo('finish')` → `launchBuffered`）**不许**碰这几个字段；编码器在看哪个文件记在
`encoderIndex` / `encoderItemDuration` 里。踩过的坑：`launchBuffered` 曾经自己写 `currentIndex`，
于是编码器一开始编下一个文件，UI 进度条就跳到下一个文件起点，300ms 后推流端下一次 `-progress` 到达才跳回来。

两条回归断言写在 `.test/engine-run.cjs` 里，**必须覆盖双引擎**（`e2e.mjs` 的 `enginebuffered` 套件用
`BUFFER_SEC=12` 再跑一遍同一个驱动器）：观众时间轴在 `live`/`draining` 期间不得回退；`currentIndex` 变化必须由
**变化前**那次的已推流总量背书（只看变化后的采样会误判为自洽）。

### 3.5 播放列表状态只能由推流进度驱动

`onEncoderExit` **不再**把条目标成 `done`，`launchBuffered` **不再**把条目标成 `live`（改为 `preparing`），
两者都由 `markPlayedThrough()` 统一按**推流位置**决定。原因：双引擎下编码进程可能几秒内跑完整个列表，
按编码完成上色会让整个队列开场几秒就全绿。`skipped` / `error` 不被覆盖。

两个必须保留的护栏：
- **`onPublished` 在 `stopping` / `state === 'idle'` 时直接返回**：正在拆除的推流进程还会再吐几个 `-progress`，
  那些块指的还是刚播完的那一段，不拦就会把 `finishSession` 刚标成 `done` 的最后一条**重新标回 `live`**
- **`markPlayedThrough` 不会把 `done` 改回别的**：推流时间轴只前进

收尾由 `finishSession(playedOut)` 负责，且标记必须发生在**任何 await 之前**。

### 3.6 i18n：文案表与"哪里不能 import Electron"

文案集中在 `src/shared/i18n/messages.ts`（`EN` 基准表 + `ZH` / `JA` 同键表），查表在 `core.ts`。
`TranslationKey` 由 `EN` 推导，**写错 key 是编译错误**。英文是基准表而不是"缺省翻译"，
真正的防线是启动时的 `assertCatalogsComplete()`（日志里打 `[i18n]` 警告）与单元测试的逐键断言。

- **不要给 `src/shared/i18n/*` 加依赖**：它被 main / preload / renderer 三个 bundle，以及
  `.test/*.bundle.mjs` 一起打包
- **主进程里"会被离线 harness 单独打包"的模块不许 import `../i18n`**：`main/i18n.ts` 依赖设置存储 → 依赖
  `electron`，一旦被 import 进那些 bundle，esbuild 的 ESM 输出会在**加载时**就
  `Dynamic require of "child_process" is not supported` 炸掉（已踩过三次：`probe.ts`、`obs/websocket.ts`、
  `stream/playout.ts`）。三处的解法都是**注入翻译函数**：

  | 模块 | 语言从哪来 |
  |---|---|
  | `ffmpeg/capabilities.ts` | `getCapabilities(..., language)` 显式传参 |
  | `ffmpeg/probe.ts` | `probeMedia(..., language)`，默认英文；探测缓存把语言算进 key |
  | `ffmpeg/command.ts` | `BuildRequest.language` / `buildTestCommand(..., language)` |
  | `stream/playout.ts` | `PlayoutCallbacks.t`（`?? EN[key]`） |
  | `obs/websocket.ts` | `ObsWebSocketDeps.t`（`?? EN[key]`） |
  | `stream/engine.ts` | `EngineDeps.getLanguage()`，由 `main/index.ts` 接上设置存储 |

- **语言切换要立刻影响主进程产出的文本**，所以 `IPC.setLanguage` 除了写盘还会广播 `evtSettings`；主进程侧一律
  **用的时候现取**（`mainT()` / `deps.getLanguage()`），不要在任何模块顶层缓存翻译函数或语言值
- **文案表的死键由 `node .test/prune-dead-keys.mjs` 维护**（`--write` 才落盘）。它按「`src/` 里是否存在与
  key 完全相同的字符串字面量」判定，删前会校验每个 key 在三张表里各出现一次；`pnpm typecheck` 是兜底
- **编码器名称不再是文案 key**：`capabilities.ts` 的 `ENCODER_CATALOGUE` 用 `{ prefix, suffix, suffixFull }`
  拼装（只有 `main.enc.audioCopy` / `main.enc.audioNone` 仍是 key）

### 3.7 状态目录

全部状态在**程序目录下的 `Data/`**（`store/paths.ts` 把 Electron 的 `userData` / `sessionData` / `cache`
重定向过去），**从不读写 `%APPDATA%`**。`electron-builder.config.cjs` 的 `extraResources` 把
`build/data-placeholder` 复制成程序目录下的 `Data/`。

- **不要恢复「从 `%APPDATA%` 迁移」**：那段代码曾存在于 `paths.ts`（`PathSetup.migratedFrom` +
  日志键 `main.engine.migrated`），已整体删除 —— 从未有任何发布版本把状态写在 `%APPDATA%`，
  迁移对象不存在。将来真的换过数据目录，再按「目标文件不存在才复制」重做
- **测试不要预先删除 `%APPDATA%\RTMP File Streamer`**：那是为了挡旧迁移代码的补丁。现在「没有写入 Roaming」
  的断言在应用运行**之后**检查，应用真写了就会失败
- 文件：`settings.json`（含 `language` + `languageSet`）· `playlist.json` · `presets.json` ·
  `Logs/`（JSONL，总量上限 12 MB / 20 个会话，单文件 4 MB 滚动）· `Cache/`

### 3.8 已移除的功能（不要恢复）

- **文件内 seek**：UI / IPC / 引擎全部删除。RTMP 推流发出后无法回溯，支持它需要在已发布的流中间做时间戳位移的
  拼接。保留的操作是**跳转到下一个文件 / 跳转到指定文件**
- **暂停**：已删除（引擎、IPC、UI）。恢复推流需要重开 RTMP 会话
- **`%APPDATA%` 旧位置迁移**：见 3.7

## 4. 工程注意事项（踩过的坑）

- **绝对不要用 PowerShell 正则改这个仓库的源码**。源码是 UTF-8 + 中文注释，`Get-Content -Raw` /
  `Set-Content` 会把中文变成乱码并破坏文件。一律使用 edit 工具。另外
  `Get-Content -Encoding UTF8 | ConvertFrom-Json` 读测试报告也会失败，用
  `node -e "require('./.test/engine-run-report.json')"`。
  **这条已经真的踩到过一次**：用 `Get-Content -Raw` + `.Replace()` 给 `.test/harness.mjs` 重排小节编号，
  Windows PowerShell 5.1 的 `Get-Content` 在没有 `-Encoding` 时按 ANSI 解码，整个文件的中文
  （含断言里的 `'只推送音频'`）变成 `?`，语法直接坏掉，只能 `git checkout` 重来。
  重排/批量改文案要么逐处用 edit 工具，要么写一个 `.mjs` 脚本用 `fs.readFileSync(..., 'utf8')`
- **文案表批量改动也走 `.mjs` 脚本**：`messages.ts` 是三张同键表，手改容易只改一种语言。按「键 + 语言」精确
  替换、失配就报错退出，比人眼核对可靠；改完跑 `test:unit`（键集/占位符断言会立刻发现漏改）
- **`.test/*.bundle.mjs` 是生成物**，但它们是**从源码实时打包**的：改了 `src/` 却只跑
  `node .test/harness.mjs` 会用到旧 bundle，必须走 `pnpm test:unit`（先打包再断言）
- **fd 1 是二进制，永远不要对它 `setEncoding`，也不要挂第二个 `data` 监听**。这是「ingest 收到 0 字节」那个
  bug 的全部内容（`-progress` 与裸 TS 曾共用 stdout，非法字节被换成 U+FFFD，还原不可逆），代价是整条链路静默失效
- **给子进程挂监听前先想清楚要不要 pause**。`on('data')` 会让流进入 flowing 模式，之后再 `pause()` 已经晚了
  （实测 1500ms 窗口放进 4382KB）。要先 pause 再挂 listener
- **kill 是异步的**。被杀进程的数据和 exit 事件都还会到达；不按身份过滤就会污染转发流、并把完成事件算到别的段上
- **临时目录会泄漏**：`Playout` 在 `os.tmpdir()` 建 `rtmp-streamer-*`。`stop()` 会清自己的，但被 kill 的进程不会。
  现在**构造时会扫掉 1 小时前的同类目录**（`sweepStaleTempDirs()`），不要删掉它
- **esbuild 的路径不要各处内联**，用 `.test/find-esbuild.mjs` 的 `esbuildCommand()`：它按当前平台找
  `@esbuild/<platform>-<arch>`（pnpm 的 isolated 布局下就在 `.pnpm` 里），找不到才退回 `bin/esbuild` 那个 JS shim
  （shim 也叫 `esbuild`，只能靠「谁来执行」区分，所以返回的是 `{ command, args() }`）。
  写死 `win32-x64` 的旧版本让整套非 Electron 测试在 Linux CI 上直接死在打包阶段
- **引擎测试的 ingest 用 `ffmpeg -listen 1`，一次只接受一个连接**。双引擎的跳转会重开会话，所以测试必须等下一个
  listener 就绪（`waitForListener()`），否则会把"ingest 没准备好"误判成"推流失败"
- **`-listen 1` 写的 FLV 头部是坏的**（管道上无法回写 filesize/duration），测试里用 `patchFlvHeader()` 就地修。
  注意布局是 `9 字节头 + 4 字节 PreviousTagSize`，第一个 tag 在偏移 **13**，**字节 5..8 是 DataOffset（必须保持 9）**，
  声明的文件大小在其后的 4 字节。写错这两个位置会把测试文件写坏
- **测试夹具的分辨率必须互不相同**。harness 靠画面辨认是哪个文件（分辨率 + 亮度），`clip_d` 曾经也是 1280x720，
  结果它的帧被算成 `clip_a` 的，让一次正确的跳转看起来是失败
- **UI 测试要显式写 `buffered`/`bufferSec` 进 settings.json**。各套件会重置 output 块，漏写就会跑成单进程管道
  —— 那样覆盖的是另一条代码路径，而且不会有任何报错。**`features` 与 `ui` 目前就没写**，它们走哪条管道完全取决于
  `normaliseOutput()` 的默认值：`buffered` 缺失时按 `DEFAULT_SESSION.output.buffered`（**true**）处理，所以跑的是双引擎。
- **两条管道的诊断日志必须由同一处产出**：`Engine.logStreamChoice()` 同时服务单进程与双引擎。它曾经只写在单进程
  路径里，于是双引擎（默认）的会话只有「流信息」而**没有**「选用视频流 / 选用音频流」，`features` 的日志断言就这么
  红了一条 —— 默认路径反而缺诊断，是最难发现的那种缺口
- **改 `buildEncoderArgs()` / `buildStreamCommand()` 的返回值时要同步两者**：映射到的流索引由
  `mappedStreamIndexes()` 一处产出，别各自内联条件（`-an`、纯字幕文件都会让索引为 -1）
- **改 UI 结构后记得同步测试的选择器**。把百分比从 `.progress-pct` 挪到 `.timeline-pct` 就静默弄坏了一条 UI 断言
  （拿到 0.0%）。这类断言失败看起来像功能坏了，其实只是选择器过期
- **「测试连接」必须和正式推流共用参数构建**。它曾经自带一套硬编码（128k/44100/立体声 AAC、libx264 ultrafast
  1000k、固定 640x360），于是服务器拒绝正式流时测试照样报「连接成功」。现在它复用
  `applyVideoEncoderArgs` / `applyAudioArgs` / `pixelFormatFor` / `encoderArgFor`，并把测试专用的替代
  （`复制`回退、`不要音频`真的不发音轨）写进 `RtmpTestResult.notes`。**新增编码设置时要同时想清楚测试里怎么体现**
- **测试的合成源有物理上限**：画面尺寸取输出分辨率但压到 720p（4K 请求会编几十秒），音频源恒为 44.1kHz 单声道
  正弦波、靠设置的 `aresample`/`aformat` 转过去。断言要写在**收到的流**上（ffprobe：22050Hz 单声道、1280x720@25），
  只查命令行会漏掉 ffmpeg 自己协商回来的情况
- 测试脚本统一入口：`node .test/unit.mjs`（非 Electron）、`node .test/e2e.mjs [suite...]`（Electron）。
  新增测试请并入这两条
- 测试用 `ffmpeg -listen 1` 充当下游 RTMP 服务器，不需要外部流媒体服务。所有端到端测试都装有**看门狗**
  （超时即杀掉残留进程并以退出码 3 报告卡住的步骤），UI 驱动全部走 CDP 程序化调用；测试启动的应用以
  `STREAMER_E2E=1` 运行 —— 窗口移出屏幕并开启点击穿透，物理鼠标不会干扰测试
- UI 端 E2E 会 `--lang=zh-CN` 启动应用并把 `settings.json` 的 `language` 重置为 `zh`：套件断言的是中文控件文字，
  不钉住就会被开发机的系统语言左右

## 5. 测试覆盖

`pnpm run test:unit` 与 `pnpm run test:e2e` 全绿是提交前提。断言数量会随功能增长，以实际输出为准，这里只列范围：

**unit（非 Electron）**：文案表三语言键集/占位符/空值逐键比对、系统语言判定、命令构建器按语言输出；
媒体探测、外挂字幕自动关联、字幕滤镜转义（Windows 盘符冒号、样式逗号）、分辨率三态与非法几何回退、
CBR/VBR/CRF 参数、硬件编码器与像素格式映射、跳转与音画偏移的时间戳语义、RTMP 地址拼接，并**实际执行生成的命令**
再解码校验产出；字幕烧录（外挂 + 内嵌轨各跑一次，用 `signalstats` 验证字幕区出现高亮字形像素）；
编码缓冲上限实测；本地推流（`-re` 节奏、进度单调、收到可解码音视频）；obs-websocket 端点完整握手与请求。

**e2e（Electron）**：`ui`（真实窗口 + CDP：启动、恢复播放列表与字幕关联、开始/停止串流、跳转、语言切换落盘、
日志面板筛选与清空）、`features`（拖入、串流中锁定、密钥掩码、对齐、日志留存与两条管道的流选择诊断）、`presets`（预设栏渲染、保存、
套用内置/自定义、**改名**、删除、obs-websocket 块落盘与还原、分辨率与码率单位控件）、`layout`（切选项卡时播放区
不位移）、`datadir`（开发构建 / 打包版 / 移动后三种情况都写在程序目录、且不写 Roaming）、`engine`（单进程基线）
与 `enginebuffered`（双引擎，`BUFFER_SEC` 驱动）。

打包产物 `release/win-unpacked/` 也应当跑同一套验证，确认 asar 打包后预加载桥、FFmpeg 探测、推流链路与目录布局正常。
