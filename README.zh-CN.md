# agycodroid

[English](README.md) · **简体中文** · [Contributing](CONTRIBUTING.md)

**在安卓手机上跑 Google Antigravity CLI（`agy`）的开发启动器。** 不用 root，不用定制 ROM，不用 chroot / proot / 虚拟机。

[![License](https://img.shields.io/github/license/Zmin2003/agycodroid)](LICENSE)
![Android 8.0+](https://img.shields.io/badge/Android-8.0%2B-3ddc84)

<p align="center"><img src="docs/assets/hero.jpg" width="880" alt="平板上的 agycodroid：侧边栏、带输入框的欢迎页、列着 Blender、Godot、Cloudflare 等可装组件的组件页"></p>

安卓本来就跑在 Linux 内核上。工具一旦能直接跑在这个内核上，手机就能做真正的 AI 辅助开发：
写代码、编 C/C++、跑 Python / Node、打包 APK、用 git 推送——全在手机上完成。

> agycodroid 是第三方项目，**与 Google 无关**。它跑的是**官方未修改的 Antigravity CLI**：
> 安装时从 Google 官方 manifest 下载，按 manifest 里的 sha512 校验，从不改动。

> agycodroid 是 [cccodroid](https://github.com/greyoak111/cccodroid)（v0.7.9）的 fork，cccodroid 用同样的方式跑 Claude Code。
> 本 README 里凡是不涉及 `agy` 本身的内容，都是从 cccodroid 继承来的；换了什么、改了什么、砍了什么，见
> [与 cccodroid 的区别](#与-cccodroid-的区别)。

> **感谢 greyoak111。** agycodroid 站在 [cccodroid](https://github.com/greyoak111/cccodroid) 的肩膀上：网关、界面、工具链、安装器都是你的工作——这个 fork 只是把 Claude Code 换成了 Antigravity CLI。谢谢你把它做出来，并公开分享。

## 为什么

在手机上用 AI，模型真要动手（跑代码、改文件、打包）时，活通常都交给云端沙箱，手机只是块屏幕。
agycodroid 把执行拿回你自己的设备：云端只做模型推理，你的代码、文件和工具链都留在本地，环境跨会话保留，智能体还能直接碰到设备本身。

## 安装

1. 从最近一次成功的 [apk 构建](https://github.com/Zmin2003/agycodroid/actions/workflows/apk.yml)下载 APK：打开那次运行，下载 `agycodroid-test-<short-sha>` 构建产物（保留 30 天），装里面的 `agycodroid.apk`。如果安卓说不兼容装不上，改用同一产物里的 `agycodroid-36.apk`（目标 SDK 36，功能相同；两者区别见应用内帮助的“更新与修复”）。（维护者发布 Release 之后，APK 也会在 Release 里。）
2. 打开应用。首次启动会自动：
   - 下载工具链：先选模块，base 必选，命令行工具和 C/C++ 编译器默认勾上，总共约 350 MB（全模块约 740 MB）；可续传，sha256 校验，校验完再解包；
   - 从 Google 官方 manifest 下载 Antigravity CLI（1.3.5 的包约 176 MB，大小随版本变化）。manifest 是安装时现读的——版本、下载地址、sha512 一律不在应用里写死。
3. 在设置里选登录方式：Gemini API Key，或 Google 账户登录（见[登录](#登录)）。
4. （可选）装好 Shizuku 并启动，在设置里授权，就能用 `priv` 和更强的保活。

要求：Android 8.0+、arm64、约 4 GB 空闲空间。

**厂商 ROM 的后台运行**：有些厂商的省电策略会无视前台服务，整个应用在后台会被冻住
（红魔上实测：离开前台约 90 秒就冻住），正在跑的任务就停了。agycodroid 在任务进行中检测到被冻住时，会在设置里告诉你具体去哪里改。
红魔 / ZTE：应用信息 → 应用电池用量 → 电池优化 → **后台运行：允许**、**自启动：允许**。

**离线安装**：先把 `devkit-cc.codroid.tar.gz` 下载到手机，首次启动时选"选择本地文件…"并挑它。其他东西都不用再下载，文件会先按已发布的版本校验。（工具链文件仍叫 `cc.codroid`：工具链与 cccodroid 共用，字节完全相同。）

带后缀的版本（例如 `v0.2.0-rc1`）是预发布版。应用内更新只推稳定版；想试某个提交的构建，去那次运行的 Artifacts 里手动下载。

## 登录

两种方式，都在设置 → 服务商卡片。网关用一次很小的 headless 探测（`agy -p "ping"`）查登录状态；它只能告诉你*登没登上*，看不到邮箱、套餐和额度——探测本身不返回这些。

- **Gemini API Key**（最简单）。在设置里粘贴 Key，存在应用私有目录里，只在启动 `agy` 子进程时以 `GEMINI_API_KEY` 环境变量传给它——CLI 只认这个渠道（只在 `settings.json` 里写是不行的，`GOOGLE_API_KEY` 也不认）。Key 去 https://aistudio.google.com/apikey 领。这种模式下 CLI 需要 settings 文件里有 `modelProvider: "gemini"`，网关会替你写好。
- **Google 账户（OAuth）**。点"登录 Google 账户"，`agy` 会打印一个授权链接；在系统浏览器里打开、登录，CLI 就拿到了保存好的 token。headless 运行时会复用缓存的凭证，所以先交互登录一次。网关不看也不存你的 Google 凭证；如果流程要一次性验证码，也是粘进 `agy` 自己的提示里，绝不经过应用的输入框。

## 权限——先读这节

这是和 Claude Code 差别最大的一点，也是移植里最难的设计问题。

**headless 模式下的 `agy` 没法在中途逐条问你。** 没有中途弹出的审批框：没预先放行的工具会被*软拒绝*——这一轮继续跑、退出码 0，只在 stderr 里打印一条说明，告诉你是哪个工具、怎么放行。连读文件都可能这样被拒。应用不会、也不可能替你点"允许"。

agycodroid 的做法是：

- **默认：`request-review` + 有范围的预先放行。** 每次运行前，网关会按你的设置重写 CLI 的 settings 文件（`~/.gemini/antigravity-cli/settings.json`），写入权限模式和一份有范围的 `permissions.allow` 清单（来自设置里的放行工具和放行目录）。`deny` 规则在任何模式下都生效。模式和 agent 模式（`default` / `accept-edits` / `auto` / `plan`）在设置、输入框下方和每个对话里都能改。
- **默认不开 `--dangerously-skip-permissions`。** 它确实存在，一开就全放行，包括写文件和执行命令。应用永远不会替你开；真想要，你自己清楚后果再开。
- **信任的先放行，其余保持拒绝。** 某一轮被软拒绝了，提示会告诉你是哪个规则要加；在设置里加上再跑一次。定时任务是无人值守跑的，需要审批的一律拒绝——排定时任务之前先把放行清单想好。

## 功能

<p align="center"><img src="docs/assets/gallery.jpg" width="880" alt="四张手机截图：可选组件、新建定时任务、通用设置（外观与字体）、内置帮助"></p>

- **带界面的官方 Antigravity CLI**：聊天、流式输出、工具调用、文件浏览、会话历史。
  - 每轮一个长期存活的 `agy` 进程（`--input-format stream-json --output-format stream-json`）；下一条消息用 stream 里的 `conversation_id` 续接同一对话。每条回复都带实时生成计时，结束时定格成总用时。
  - Antigravity 干活时发来的消息排在聊天末尾标 *Queued*；**立即发送**会把其中一条塞进正在跑的那轮，不打断它。**停止就是停止**——排队的消息会被挂起，绝不会自动发出去。
  - **安静的顶栏**：右上角只有一个 ⋯，点开滑出文件、终端、浏览器、命令面板和新会话，再点收回去。页面万一不滚动了，长按顶栏标题可以重建页面。
  - **外观与字体**：三种配色（原生、求索、朱月），浅色 / 深色 / 跟随系统（状态栏也跟）；启动屏、首次设置屏和内置浏览器都跟着变。字体随应用自带，手机系统字体改不了显示效果：界面默认 Inter + 思源黑体，回复默认衬线 Spectral + 思源宋体。设置里能换界面字体、回复字体（衬线 / 无衬线）和字号（小 / 中 / 大）。代码和终端用 CC Mono 等宽字体。
  - **界面动效**：侧边栏、菜单、页面和面板进出都有来处去处，带弹簧感；侧边栏能跟着手指滑开推回。只有位置和透明度在动，流式文字和长列表不动，老手机也流畅。回复文字匀速放出，服务商一次发来一大块时不再一跳一跳。设置 → 通用 → 界面动效：系统 / 开 / 关。
  - 你的消息在右、回复占满宽，和桌面版一样。两段回复之间的工具调用会折成一行"N 步"，点开看每一步。出问题的分组会自动展开。每条回复下面有**复制**（原始 Markdown）和**分享**（系统分享表）。回复渲染 Markdown，支持表格、任务列表、LaTeX 数学和语法高亮的代码块。
  - **内置帮助**（侧边栏 → 更多 → 帮助）：完整用户指南和进阶技巧，带目录，中英文都有。旁边的版本说明收录了每个版本的说明，可以搜索。
  - **横屏平板和展开的折叠屏**：按窗口宽度变成两列（聊天 + 右边的工作区）或三列（再加一个停靠的侧边栏）。文件、查看器、终端和内置浏览器在右边打开，不盖住聊天，分隔条可以拖。竖屏手机和窄分屏和以前一样。**折叠屏布局（试验性）**：列按折痕对齐，半开站立时输入框移到折痕下面，三折叠每块屏一列。
  - **后台也不丢活**：一轮结束时会发系统通知，不弹横幅。系统要是把应用杀了，再打开会把没跑完的那轮标成*已中断*并给一个*继续*按钮，排队的消息还在。
  - **会话管理**：侧边栏的聊天页可以按消息内容搜索和筛选，常用的会话可以置顶。删掉的会话先进回收站（30 天内可恢复）。可以一个个挑或全选，把会话导出成 zip——用系统*保存到*选位置，或直接分享——再到另一台设备上导入，接着聊。会话由网关自己存（`~/agyapp-sessions/`，一个对话一个 JSONL 文件）；不依赖 Antigravity 自己的落盘位置。
  - **终端**（顶栏）：真正的终端，带标签页，跑的是 Antigravity 用的同一套 bash 和工具链——hx（Helix）、less、top、git 之类都有。一排附加按键补上手机键盘没有的东西（Esc、Tab、粘住的 Ctrl / Alt、方向键、Home / End、PgUp / PgDn、粘贴、字号）；长按可以选中复制输出。关掉面板终端还在跑，回来会重放输出。终端里 `agy` 和桌面上一样用：输入 `agy` 就进交互会话。
  - **文件查看 / 编辑**（从文件浏览器进）：改文本和代码并保存——如果打开之后文件在磁盘上变了（比如 Antigravity 改了它），覆盖前会先问你。Markdown 边看边改；图片按屏适配显示，点一下 1:1；PDF 用 [pdf.js](https://mozilla.github.io/pdf.js/) 渲染（支持 CJK 文字和带密码的文件），页面滚动到才画。Word 和 Excel 直接打开；PowerPoint 和老 .doc 装了 LibreOffice 组件后会先转成 PDF。`.html` 文件显示为实时页面——同目录或上级目录引用的 CSS、JS、图片都加载，文件一变页面就刷新，所以 Antigravity 写的浏览器游戏点一下就能玩。右上角是**分享**，把文件交给系统分享表。
  - **DevTools**：HTML 预览和内置浏览器能打开自带的 [Eruda](https://github.com/liriliri/eruda)——元素、控制台、网络、存储——离线可用。打开后**点选元素**会把点到的元素的选择器和一小段 HTML 塞进输入框，方便你告诉 Antigravity 改哪里。
  - **Markdown 写作**：边写边排版数学和代码块，光标不在上面时只显示排版结果；字数实时跟上，没保存的草稿自动留着。几百万字的稿子也能打开编辑（上限 16 MB），预览只排版屏幕附近，滚动不卡。
  - **Git 面板**（从文件浏览器或编辑器进）：看改动、历史和逐行 diff，勾文件、写提交说明提交，也能丢弃改动、切换或新建分支、拉取和推送。
  - **输入框下方直接切换**：模型、思考 effort 和权限模式。新聊天的开始屏上可以先选项目和模型再说话。模型是自由填写的 slug（例如 `gemini-3.8-flash-medium`）；应用不自带模型列表，因为 Antigravity 没有发布稳定的列表——写错的 slug 会在运行时报错，绝不会悄悄换成别的。effort 是 low / medium / high / xhigh / max。
  - `/goal <条件>` 让 Antigravity 一轮接一轮干，直到条件满足，检查和已用时间显示在输入框上方。
  - **回退到这里**：每条你发过的消息都能把对话截到那之前、另开一个会话重新问（会话 fork）。把 Antigravity *改过的文件*也退回去是**做不到的**——Antigravity 不留文件检查点。任何一条回复也可以 **fork** 成新会话，原会话不动。Antigravity 干长活时，进度汇报会显示成输入框上方的**任务清单**，子智能体各有一张卡片：一行状态和当前步骤。后台命令也在那里列着；多了就折成一行，点开逐个查看和停止。
  - **谱系**（侧边栏）：会话之间的 fork、续接和回退画成地铁图（或缩进树），一眼看出每个会话从哪来。每个会话自动有个档案号，点站台直接跳到那一章。旧会话可以一键归档，第一次打开有简短导览。
  - **附件**：＋面板第一行是附加文件、拍照、截图和浏览文件。拍照打开系统相机，照片按长边缩到 2048 像素并摆正再附加。截图走 Shizuku；长按截图可以 5 秒后拍，给你时间切到想截的应用。从别的应用分享到 agycodroid 也会附加文件。
  - 聊天往上翻时出现一个 **↓ 按钮**，点一下跳到最新消息；上面有个点表示期间又有新输出。
  - **回复里的路径是链接**：点 `/storage/emulated/0/…/report.pdf` 这样的绝对路径（或 `file.js:12`）就在查看器里打开；文件夹在文件浏览器里打开。读或写文件的工具卡片上也有一个 ↗ 按钮。
  - **内置浏览器**（顶栏的地球图标）：回复里的网页链接在应用内打开——看 `http://127.0.0.1:<端口>/` 的开发服务器很方便。宽屏上在右边的 workspace 里打开，和聊天并排。用的是系统 WebView，不增加下载。登录页面还是去你的正常浏览器。
  - 界面有 10 种语言：简体中文、繁體中文、English、Français、Español、Русский、العربية（RTL）、日本語、한국어、Bahasa Indonesia（机器翻译草稿，欢迎纠错）。
- **项目和定时任务**：
  - 项目就是工作目录加上它的默认服务商、模型、effort 和权限；会话按目录归到项目下。
  - 定时任务让 Antigravity 按计划干活——每天、每周、每月、每几小时、一次，或 cron 表达式——到点由系统闹钟唤醒。可以限制任务只读、只限本项目或指定工具，并限制单次运行时长和每天总时长。跑的时候没人看着，需要审批的一律拒绝。
- **用量**：顶栏下方的上下文行后半段显示当前会话用掉的 token（input / output / thinking / cache-read / total，按 `agy` 的 stream-json 事件报的数）。用量页记录对话、活跃天数和用过的模型，带一张月度报告卡片，可以保存或分享；只统计用量，从不统计内容。没有额度显示——Antigravity 不报额度——也没有费用：`agy` 不报价格。
- **工具链按模块安装**（扩展 → 工具包模块）：分成 base、命令行工具、C/C++ 编译器、Java 和安卓打包、图形库、音视频、文档和数据、Go 和 Node.js 生态。首次安装时自选，以后可以增减。每个模块列出用途、主要命令、大小、依赖和哪些组件用它；输入一个没装的模块里的命令会告诉你去哪里找。
- **可选组件**（扩展 → 可选组件）：不随应用附带的大工具，需要再下载。每个构建都对应某个工具链版本，安装前按 SHA-256 和逐文件清单校验，卸载干净。
  - **浏览器组件（无头 Chromium 155）**，下载约 254 MB，装完约 750 MB：让 Antigravity 无头打开页面——截图、导出 PDF、渲染后的 DOM、用 puppeteer-core 写脚本浏览。
  - **社区组件**，来自 [cccodroid-components](https://github.com/greyoak111/cccodroid-components) 仓库（与 cccodroid 共用）。开发：GitHub CLI（gh）、Godot（无头运行、导出 APK）、Graphviz / PlantUML 画图、Hugo、逆向（rizin、binwalk）。媒体：Blender（无头合成和渲染，GPU 上做 3D）、LilyPond（乐谱雕版）、音乐制作工具链。办公：LibreOffice、Pandoc、PDF 工具箱、OCR（中英文）、LaTeX（Tectonic，支持中文）。AI：llama.cpp、OpenAI bridge（预览版）。3D 和科学：OpenSCAD、GNU Octave、科学 Python（numpy / scipy / matplotlib）。EDA：ngspice / gnucap、Icarus Verilog / Yosys。GPU：骁龙驱动（Vulkan / OpenGL / OpenCL）、Mali 驱动、GPU 跑分。网络：Cloudflare（wrangler）、rclone、QQ 机器人（原生 NapCat / SnowLuma，OneBot v11）。完整列表见 [这里](https://github.com/greyoak111/cccodroid-components#components)。索引是 ed25519 签名的，验不过就拒收；社区组件会标出来，没在真机上验证过的构建会先问你。
  - **自定义组件**：导入市场上没有的 Linux arm64 程序（单个二进制或 .tar.gz / .zip）。它会自己判断程序是 glibc、安卓原生、静态还是脚本，缺的 glibc 库从 Termux 的 glibc 仓库补；装好就是一个命令，Antigravity 和终端都能用。来源由你自己负责。
- **完整的开发工具链**（约 250 个包，取自官方 [Termux](https://termux.dev) 仓库）：
  - C/C++：clang 21 / lld、make / cmake / ninja、gdb / strace。
  - 语言：Python 3.14（pip、venv）、Node 26（npm、npx）。
  - 安卓构建：OpenJDK 21、aapt2 / d8 / apksigner——在手机上打包 APK。
  - 版本控制和网络：git、ssh、curl。
  - 音视频：ffmpeg 9（x264 / x265 / VP9 / AV1 / Opus…），手机上硬件编码（`h264_mediacodec` / `hevc_mediacodec`），比软件编码快 3 倍多。
  - 命令行工具：rg / fd / bat / jq / sqlite3 / typst / ImageMagick…交互式 bash 支持 Tab 补全；`hx-grammar` 只装你需要的 Helix 语法；typst 开箱就能找到系统 CJK 字体。
  - 缺什么：终端里 `pkg install` 从 Termux 仓库装，`pkg verified` 列出已验证能用的包。
- **系统权限（可选）**：[Shizuku](https://shizuku.rikka.app) 集成。终端里 `priv '<命令>'` 可以用 shell 用户身份跑 pm / am / settings / logcat / screencap…。
  - 设置里一键安装和激活：从 Shizuku 官方 release 下载（验签名证书），用系统安装器安装，
    再走无线调试激活——不用电脑。配对码在常驻通知里输入，配对对话框一直开着。
  - 重启后 agycodroid 自己重新打开无线调试并重新激活 Shizuku（需要 Wi-Fi）。
- **设备工具（默认关闭）**：在设置 → 设备工具里打开，Antigravity 就能发通知、读写剪贴板、分享文件给其他应用、打开链接或应用、查看电池和网络；读屏和点屏用无障碍，是另一个单独开关。底层是一个 MCP 服务器，经 Priv 调系统。日历、邮件之类只做预填，保存或发送由你自己来。
- **内存管家（默认关闭）**：跑构建、渲染这类重活之前，先停掉白名单之外的后台应用，跑的时候复活了再停。正在看的应用、分屏应用和有前台通知的一律不动。终端里用 `cc-mem run -- <命令>`。怎么读内存数字、怎么找吃内存的元凶：[docs/memory-management.md](docs/memory-management.md)。
- **Work Island（ColorOS，默认关闭）**：装了社区做的 Work Island 应用后，Antigravity 干活、等审批和完成任务的状态会显示在 ColorOS 16 的流体云岛上。见 [docs/work-island.md](docs/work-island.md)。
- **自动更新**（默认开，可以关，也可以在设置里手动触发）：
  - Antigravity CLI：按 Google 官方 manifest 静默更新（永远是 manifest 当时指的最新版；没有 stable / latest 频道，也不能固定装一个从没装过的旧版本——manifest 只给当前最新版）。正在跑的对话不受影响。每次安装都先按 manifest 的 sha512 校验，通过了才切 `current` 链接，上一版留着做回退。
  - agycodroid 自己：下载、验签名，再提示安装；有 Shizuku 时空闲会自动静默安装。两个 APK，targetSdk 28 和 36；更新跟着你已装的那个走，设置里可以切换（只接受 36 的系统切过去就回不来了）。
  - 工具链：只在 Wi-Fi 下预下载，下次打开应用时替换；你用 pip / npm -g 装的东西都留着。
  - 更新互相不打断：工具链在下载或替换时，应用更新会等着。替换前先按发布清单校验，万一被打断（应用重启、进程被杀），下次启动会接着完成或回滚。
  - 设置里的**校验 / 修复**会按记录的哈希逐个检查工具链文件；修复会重装同一版本，你自己的包留着。每次启动也会做一次快速检查。
- **扩展**：在扩展页添加、编辑和删除 MCP 服务器（长按或双击条目直接编辑；token 从不回显，只显示名字）。全部走 `agy mcp …`；命令失败就报 CLI 自己的错。Claude Code 的插件、技能和钩子**不支持**——Antigravity CLI 没有这些东西——扩展页会明说，而不是悄悄失败。
- **运行前先检查**：
  - Antigravity CLI 只有和安装时存下的 manifest 副本加自身 sha512 对得上才能跑。网关用自己的运行时副本，每次启动前按 APK 里的包校验，包升级和工具包更新都碰不到它。
  - 交给 Antigravity 的配置（项目说明、规则、组件里的文字、自动记忆）先扫一遍越狱特征。命中了那一轮就不跑，并告诉你是哪个文件哪一行。MCP 服务器按 `~/.claude.json` 里注册的原样传，不参与这次扫描。
  - 项目里会自己跑起来的配置（钩子、项目里的 MCP 服务器）不加载。之前对话留下的后台程序会先给你看，再继续。
- **排障**：
  - **安全模式**：插件、MCP 服务器或项目文件把事情搞坏了，开安全模式，Antigravity 用最小配置启动——不加载自定义内容，登录、密钥、会话和模型保持原样。什么都不移动、不改动；关掉就恢复。
  - **我卡住了 · 打包诊断**（设置里，安装失败屏上也有）：诊断信息、应用日志、网关日志和修复台账打成 zip 交给系统分享表。打包前先给你看装了什么。密钥、token、邮箱和你发给 Antigravity 的消息内容先脱敏，会话记录不放进去。
  - **首次安装的报错说人话**：下载前先检查剩余空间，告诉你还差多少。断网、限速、校验不通过这类失败都用大白话解释。*重试*会从已下载的部分接着下。
  - **修复台账**：每次工具链安装、校验、修复和启动恢复都记下来（发现了什么、做了什么、结果如何），在设置里能看。
  - **已知问题**：还没完全解释或排除的问题和目前所知，列在 [docs/known-issues.md](docs/known-issues.md)。
  - **权限**：每个权限是干什么的、什么时候问你、拒绝会怎样，见 [docs/permissions.md](docs/permissions.md)。发现安全问题？按 [SECURITY.md](SECURITY.md) 里说的私下报告。
- **USB 调试另一台设备**：用 OTG 线连上，跑 `usb-adb`，然后 `adb devices / install / shell` 照常使用。
- **自检**：`agycodroid-selftest` 会练 70 多个工具和用法（包括 ffmpeg 和硬件编码探测）；工具说明会塞进给 Antigravity 的指示里，让它知道自己有什么。

## 与 cccodroid 的区别

cccodroid 跑 Claude Code；agycodroid 跑 Antigravity CLI。应用壳、网关、工具链、组件和大部分界面是同一份代码。变了的是：

| 方面 | cccodroid（Claude Code） | agycodroid（Antigravity CLI） |
|---|---|---|
| 引擎 | `claude`（官方 linux-arm64 glibc 构建，经 glibc 加载器 + seccomp 垫片启动） | `agy`（官方安卓 bionic 构建，直接跑——不用加载器、不用垫片、不用 DNS 桥） |
| 安装 | 官方渠道 / npm 镜像，PGP + npm 签名 | 只有 Google 官方 manifest：读 manifest → 取 url + sha512 → 下载 → 校验 → 解包 → 落地为 `agy` |
| 聊天协议 | Claude stream-json（`system` / `assistant` / `user` / `result` / `control_request` …） | agy stream-json：只有三种事件——`init`、`step_update`、`result` |
| 会话 | 读 Claude 自己的 `$HOME/.claude/projects/*.jsonl` | 网关自己写 `~/agyapp-sessions/<项目>/<conversation_id>.jsonl`（记录格式相同） |
| 续接 | `--resume <sessionId>` | `--conversation <id>` / `-c`（用 stream 里的 `conversation_id`） |
| 审批 | 中途逐条审批弹窗（`control_request` → 界面弹窗 → `control_response`） | **没有。** headless 的 `agy` 会把没预先放行的软拒绝掉（见[权限](#权限先读这节)） |
| 权限模型 | `--permission-mode`（default / acceptEdits / plan / auto / dontAsk / bypassPermissions）+ PreToolUse 守卫钩子 | `toolPermission`（`request-review` / `proceed-in-sandbox` / `always-proceed` / `strict`）+ `agentMode` + `~/.gemini/antigravity-cli/settings.json` 里的 `permissions.allow` / `deny`，每次运行前由网关重写 |
| 登录 | `claude auth login`（OAuth）或经 `apiKeyHelper` 的 API Key | Google OAuth（交互登录一次，headless 复用缓存凭证）或经 `GEMINI_API_KEY` 的 Gemini API Key |
| 服务商 | Claude 账户 + Anthropic 兼容端点（DeepSeek、GLM、Qwen、Kimi…） | 只有 Google（OAuth）和 Gemini（API Key） |
| 模型 | Opus / Sonnet / Haiku / Fable + 各服务商列表 | 自由填写 slug（例如 `gemini-3.8-flash-medium`）；不自带列表；写错的 slug 运行时报错 |
| Effort | 按模型分档 | low / medium / high / xhigh / max（由 CLI 校验） |
| 命令 | `/compact`、`/context`、`/cost`、`/model`、`/autocompact`… | 只有 `/model`、`/models`、`/effort`（网关本地处理）；其余都当普通文本发给 `agy` |
| 技能 / 插件 / 钩子 | 完整支持（`~/.claude/skills`、插件市场、PreToolUse 钩子） | **砍掉。** `agy` 没有这些东西；扩展页会明确返回"不支持"，而不是悄悄失败 |
| MCP | `claude mcp …` 直通 | `agy mcp …` 直通（子命令输出格式按 best-effort 解析；`settings.json` 里的 MCP 服务器配置尚未确认） |
| 文件回退 | 文件检查点：撤销某条消息之后改过的文件 | **砍掉**（`agy` 没有检查点）。只截对话的回退（fork）还能用 |
| 压缩 | `/compact` + 空闲压缩 | **砍掉。** `agy` 没有压缩；长会话按 `conversation_id` 原样续接 |
| 用量 / 额度 | token 计量 + 费用 + 服务商额度（5 小时 / 每周上限） | 只有 token 计量（来自 stream 事件）；没有费用、没有额度——`agy` 都不报 |
| 本地模型 | 设备上的 llama.cpp 聊天 | **砍掉**（llama.cpp 组件本身还能装；聊天没接上去） |
| 包名 | `cc.codroid`（10 字符） | `cc.agyroid`（10 字符——工具链的等长前缀重定位要求恰好 10 字符；应用名仍是 `agycodroid`） |
| 工具链 pin 目标 | `cc.codroid` | 不变（`cc.codroid`——fork 继续用上游的工具链字节） |

## 社区与贡献

- **问题和想法**：新开一个 GitHub issue，中英文都行。
- **Bug**：在应用里点设置 → 在 GitHub 上报告；设备和自检结果会自动填好。

**非常欢迎帮忙。** 设备报告、翻译修正、组件配方、文档和代码都欢迎，不会写代码也能帮。见[贡献指南](CONTRIBUTING.md)。

## 架构

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/cccodroid-architecture.zh-CN-dark.png">
  <img alt="agycodroid 架构：用户在界面（WebView；前端是网关拼起来提供的 27 个部分）里操作，经 HTTP 和 SSE 与 127.0.0.2 上的网关对话（server.mjs 加 gw/ 下的功能模块，带 token 检查、逐请求签名和事件总线）。网关跑在 files/gw 里自己的运行时（Node 和 glibc）上，每次启动前按 APK 里钉住的哈希校验。网关由 GatewayService 前台服务启动和重启，读写 home/ 下的会话、设置和 token，经私有文件 socket 上的 Priv 中继够到 Shizuku，用 stream-json 驱动官方未修改的 Antigravity CLI，启动前按安装时存下的 manifest 副本加自身 sha512 校验。每次运行前，配置检查先扫一遍交给 Antigravity 的配置里的越狱特征，只放行检查过的。Antigravity 经 HTTPS 调 Google 的 API（Google 账户或 Gemini API Key，按对话选），经工具调用工具链（base 加可选模块）。targetSdk 36 的构建里，APK 自带的加载器（libldlinux.so）和一个 exec 垫片改写程序的启动方式。设备工具 MCP 是给 Antigravity 的 MCP 服务器，经本地 socket 走 Priv。Updater / Installer 从 GitHub、cccodroid.net 镜像和官方渠道下载，管理 28/36 的 APK、工具包模块和 Antigravity CLI。组件从组件市场取 ed25519 签名的索引和包，装进工具链（它们的 Claude 技能没有 Antigravity 等价物，不会安装）" src="docs/diagrams/cccodroid-architecture.zh-CN-light.png">
</picture>

交互版（引导视图、浅色/深色、导出）：下载 [`docs/diagrams/agycodroid-architecture.zh-CN.html`](docs/diagrams/agycodroid-architecture.zh-CN.html) 用浏览器打开；
源文件是同目录下的 `agycodroid-architecture.zh-CN.json`，每个组件都对应到它描述的源码行。用 [Archify](https://github.com/tt-a1i/archify) 生成。

## 工作原理

```
agycodroid.apk（Java 壳：安装器 + 前台服务 + WebView）
  ├─ files/usr/      工具链：官方 Termux 包，等长前缀重定位后原生运行
  ├─ 官方 Antigravity CLI（android-arm64 bionic 构建，未修改的二进制）
  │     └─ 直接经 /system/bin/linker64 跑——不用 glibc 加载器、不用 seccomp 垫片
  ├─ lib/arm64-v8a/libldlinux.so   网关自己的 Node 运行时用的 glibc 加载器；36 构建经它启动 glibc 程序
  ├─ files/gw/       网关自己的运行时（Node、glibc 等），每次启动前按应用包校验
  └─ gateway gateway/server.mjs + gw/（Node）：跑 agy、事件流、队列、服务商配置 → 界面 gateway/web/
```

- **等长前缀重定位**：Termux 的二进制在构建时就把 `/data/data/com.termux/` 烘进去了。包名 `cc.agyroid` 和 `com.termux` 一样恰好 10 个字符，逐字节替换就能修好所有 RUNPATH、shebang 和配置路径——不用 `LD_LIBRARY_PATH`、包装脚本或二进制补丁。zip / jmod 压缩包里的条目也一起改写。见 [devkit/README.md](devkit/README.md)。包名之所以是 `cc.agyroid` 而不是 `cc.agycodroid`（11 个字符会弄坏重定位），就是这个原因。
- **targetSdk 36**：从 Android 10 起，目标 SDK 29 及以上的应用不能执行自己数据目录里的文件。普通 APK 仍以 28 为目标。36 构建把 glibc 加载器放进 APK 的 native 库目录（系统允许执行），bionic 程序经 `/system/bin/linker64` 启动，一个 exec 垫片（[`exec-shim.c`](android/native/exec-shim.c)）把每次程序启动改写成这两种形式之一。两个 APK 功能相同；每个组件都在 36 构建的真机上跑过。`agy` 本身是 bionic 二进制，两个构建里都走系统链接器直接跑。
- **网关访问控制**：网关监听两个回环地址：127.0.0.2 专给界面，127.0.0.1 给本地工具。每个 `/api/*` 请求都要带应用私有目录里的 256 位 token，还要检查 Host 和 Origin。会话 cookie 只在到达 127.0.0.2 的请求上认，内置浏览器会拦这个地址，所以 cookie 到不了设备上的其他服务。应用本身从不直接发原始 token：每次请求签一次名（时间戳、一次性 nonce、启动 ID、监听地址、方法、body 哈希的 HMAC），截获的请求没法重放。交出任何凭证之前，应用还会先让网关用 token 做 key 回答一个 HMAC 挑战，证明应答的确实是真正的网关。设备上的其他应用和网页驱动不了它。
- **凭证**：Google 登录由 `agy` 自己完成。网关把授权链接交给系统浏览器，从不读取或保存 Google 凭证；一次性验证码也不经手（见[条款与合规](#条款与合规)）。Gemini API Key 放在应用私有目录里，只通过 `agy` 子进程的 `GEMINI_API_KEY` 环境变量传给它——这是 CLI 唯一会读的渠道，Key 从不写进 `agy` 会读的文件、从不记日志、也不发到别处。

## 工程历史

从第一个提交到 v0.7.0 用了 33 天：1,106 个提交、146 个 release。下表按工程阶段分组，每一行都能在提交历史和 [Releases](https://github.com/greyoak111/cccodroid/releases) 页面上追溯。agycodroid fork 自 cccodroid v0.7.9（提交 `fb2caea`）。

| 阶段 | 版本 | 关键工程 |
|---|---|---|
| 原型 | 建库之前 | 在 [DeepSeek Harness](https://github.com/woaiys3/deepseek-harness-android-app) 里验证过：官方 linux-arm64 Claude Code 由 glibc 加载器直接启动，因为 glibc 解析不了 DNS，配了一个 bionic 侧的本地反向代理；Java + WebView 壳加 Node 网关；claude 进程归网关管，用 SSE 事件总线流到界面 |
| 骨架 | 0.1.0 – 0.1.2 | 前台服务保活；工具链用官方 Termux 包组装，等长前缀重定位后原生运行；官方包下载和校验；seccomp SIGSYS 转成 ENOSYS（静态二进制再加 `enosys-run`）；Shizuku 特权命令走应用内 socket；网关 token 加 Host / Origin 检查 |
| 分发与生态 | 0.1.3 – 0.3.0 | 更新链：基于哈希的版本管理、可续传替换、MANIFEST 校验和修复；组件市场：配方 → CI → ed25519 签名索引 → 设备端校验标记；并行会话；`enosys-run -f` 覆盖整棵进程树；壳和网关的 i18n；Claude Code 多源下载，镜像包也要过官方清单、PGP 和 npm 签名检查；每个 PR 都有 CI 构建 |
| 重构 | 0.3.4 – 0.4.0 | 网关拆成路由层加 `gw/` 下的功能模块；前端拆成 `web/app/` 下的部件，由网关拼起来提供；工具包按模块安装和卸载，模块清单有签名；记录与磁盘主动对账；每个会话单独的模型和服务商，不同服务商的会话可以并行跑；targetSdk 36：经 linker64 和 APK 自带的 ld.so 执行，加 exec 垫片，做成 28 / 36 双 APK；定时任务由系统闹钟唤醒 |
| 体验与原创功能 | 0.4.1 – 0.5.0 | 分段并行下载加备用路线；`gw/streamfix.mjs` 给第三方流式回复补上缺失的流结束事件，整段答案不用重新生成；网关测试接进 CI 和发布门禁；Lineage：会话血缘图，带归档 ID 和窗口化懒加载；一种动效管所有进出；子智能体卡片和联络日志；界面设置收进 `ccapp-ui.json`；发布缩成一条流水线（构建 → 校验 → 发布 → 站点链接检查） |
| 加固 | 0.5.1 – 0.5.19 | 十多轮外部审查：原子写、环境变量黑名单、每个清单签名并绑定到具体 release 防重放；界面移到专用的回环地址 127.0.0.2，网关请求改逐请求 HMAC 签名，不再发原始 token；敏感操作前 PreToolUse 钩子再问一次；提示和会话日志加完整性封签；PR 投毒筛查，发布签名密钥只放给 main；特权命令白名单，白名单之外的都要原生确认 |
| 纵深审查 | 0.5.20 – 0.6.7 | 逐版本社区审查（0.6.0 一个版本就处理了 80 多条发现）加社区成员红队测试；改变宿主行为的开关（保活增强、特权命令免逐条确认、设备工具）只在系统锁屏检查后才生效，激活 Shizuku 要在原生对话框上点一下；项目里会自己跑的钩子和 MCP 服务器先问你再加载；界面和网关文件在启动时和运行中都按应用包校验；Claude Code 只允许跑过 Anthropic 签名清单的版本，网关跑在自己的运行时上；交给 Claude Code 的配置先扫越狱特征 |
| 加固与日常功能 | 0.6.8 – 0.6.13 | 越狱特征扫描反复加固：拆字、同形字和多层编码先归一化再扫；钩子注入的文字和项目配置也筛，应用自带一套防越狱规则；0.6.10 一次全面审计修了一百多个发现——发布密封、Git 只信任已登记的项目目录、内部动作 token 从系统 keystore 派生；会话变成永久的，带存储页和定时清理；文件管理器能浏览、解压和新建压缩包，自带 7-Zip；一键恢复初始设置；文件管理器里的 APK 可以直接安装 |
| 端点与稳定性 | 0.6.14 – 0.6.19 | 本地协议桥管理多个 API；自定义端点自动发现模型列表，默认 90 秒超时重试 3 次，接受中文和带括号的模型名；窗口未知时上下文压缩线正确回退；0.6.17 是稳定性专版，修了七十多个问题，组件市场多了 MCP 分类和 14 个组件；折叠屏和手势条布局；0.6.18 集中修长文本溢出；0.6.19 补齐预设模型列表 |
| 规则瘦身与端点示例 | 0.6.20 | 反越狱屏蔽块从 4,625 字砍到 706 字，去掉三轴分类、白名单、三遍审查和自测表；恢复致残、事后处置和致命参数、反调试/反反调试/杀软绕过和植入工具链的"任一即"表述，自有资产不再豁免破解、解包和反检测产品；声称的身份、虚构包装、编码、其他语言、片段和多轮请求不再改变判定；危机求助只给求助渠道；第三方端点加了示例模板和风险提示，README 措辞中立 |
| 承诺的版本 | 0.7.0 | 自动标题跟界面语言（#211）；顶栏的静态备用标题改成 cccodroid；0.6.20 告别信里承诺的版本 |
| **agycodroid fork** | **0.7.9 →** | **Claude Code 整套换成 Google Antigravity CLI**：manifest 安装器（没有 PGP / npm，只核 sha512）、agy stream-json 协议（`init` / `step_update` / `result`）、网关自己写会话、`toolPermission` + 有范围的 `permissions.allow` 替代逐条审批弹窗、Gemini API Key / Google OAuth 登录、技能 / 插件 / 钩子 / 压缩 / 文件回退砍掉并写明原因、包名改成 `cc.agyroid`（仍是 10 字符） |

项目一直守着的规则：

- **只启动官方包，绝不改动。** Antigravity CLI 只从 Google 官方 manifest 来。APK 里从不打包它。
- **不用 root，不用 proot。** 工具链原生跑。平台限制用前缀重定位处理，特权操作只走 Shizuku。
- **网关拥有运行。** 界面只订阅事件，所以页面刷新、切后台或并行会话都不会打断正在跑的一轮。
- **先校验再信任。** 工具包、模块、组件索引、通知和发布列表都按 ed25519 或 PGP 签名校验并绑定到具体 release；`agy` 本身按 Google 官方 manifest 里的 sha512 校验。
- **每次改动都要验证。** 网关测试只走 runner，每个发布和工具包发布步骤都校验哈希，组件会说明有没有在真机上验证过。

## 条款与合规

agycodroid 跑的是 Google 的 Antigravity CLI。用它要遵守 Google 自己对 CLI 的条款；下面是应用实际的做法，供你自己判断：

- **二进制怎么跑。** Antigravity CLI 文件是 Google 官方 android-arm64 构建的原样：按官方 manifest 里的 sha512 校验，从不打补丁。它是 bionic 二进制，直接经安卓系统链接器跑——不用加载器、不用 seccomp 垫片、不用任何形式的修补。
- **用 Google 账户登录。** 登录是 `agy` 自己的 OAuth 流程。你在浏览器的 Google 页面上授权，`agy` 把 token 写进自己的凭证存储（应用从不读那个文件），登录后 `agy` 直接和 Google 的 API 对话，不经过我们的任何进程。实际效果和 SSH 到一台你自己的 Linux 机器上跑 CLI 再登录是一样的：这里的 Linux 机器就是手机，应用是屏幕和键盘。每一轮都由你发起：要么是你发来的消息，要么是你自己设的定时任务。定时任务在你自己的手机上、用你自己的账户、跑同一个未修改的 CLI；跑的时候没人看着，需要审批的一律拒绝——应用永远不会替你批准工具调用。
- **一次性验证码。** 正常情况下浏览器会自动把验证码交回 `agy`，在本机完成，不经过应用。万一失败了，应用会打开内置终端跑 `agy`，你把验证码粘进 `agy` 自己的提示里。终端就是个通用字节通道，和 Termux 或 SSH 一样；应用没有接收验证码的输入框，从不解析、保存或记录它。
- **权限提示。** 和终端里的官方 CLI 不同，应用驱动的 headless 模式没法逐条问你。工具按你在设置里设的有范围的规则预先放行（见[权限](#权限先读这节)）；没预先放行的会被软拒绝，那一轮在没有它的情况下继续跑。默认是最严的那头：`request-review` 加一份很小的放行清单。
- **名字。** agycodroid 是 "Antigravity CLI On droid" 的缩写。项目不在名字、图标或包名里使用 Google 或 Antigravity 的名称或 logo（包标识符里的 "agy" 只是描述性的），也不声称是 Google 制作、背书或合作的。如果 Google 要求，项目会改名。
- **不转售、不做中间商。** agycodroid 免费开源，没有服务器，不提供、不付费也不转售任何 Antigravity 用量：你用自己的账户登录或自带 API Key，用量直接记在你账上。

### 本项目不做的事

agycodroid 免费开源，没有服务器，不提供、不付费也不转售任何 Antigravity 用量：你用自己的账户登录或自带 API Key，用量直接记在你账上。

- **不共享、不转售账户。** 几个人分一个订阅，或把订阅用量包装成 API 拿去卖，都不支持；我们不为此做功能、不接受加这种功能的 PR，组件市场也不收这类组件。
- **不越狱。** 绕过模型的安全限制、套出它本来会拒绝的有害内容，不支持。
- **不大规模操控账户。** 用智能体批量注册、养号、跑号，冒充真人去刷评论区，不支持。

我们不去管别人怎么选。但本项目不提供共享/转售功能，也不帮着排障这类用法。

## 构建

```sh
sh scripts/build.sh                 # javac → d8 → aapt2 → 签名，产出 dist/agycodroid.apk（targetSdk 28）
TARGET_SDK=36 sh scripts/build.sh   # 36 构建；scripts/ship.mjs 给发布版两个都构建
node devkit/devkit.mjs build --target cc.codroid   # 构建工具链（CI 也能做；目标仍是 cc.codroid——工具链与上游共用）
```

**不用自己搭环境**：GitHub Actions 每次拉 PR 和每次推 main 都会构建 APK，从那次运行的 Artifacts 里下载（见 [.github/workflows/apk.yml](.github/workflows/apk.yml)）。这个 fork 的构建在维护者提供发布 keystore 之前都用一次性测试密钥签名，所以要先卸载已发布的版本再装；最好用备用机。CI 里的指纹检查只在官方发布密钥存在时才跑。发布签名：想让 main 分支的构建用发布密钥而不是一次性测试密钥签名，把钥匙 JSON（`{"key": PEM 私钥, "cert": PEM 证书}`，base64）放进 `apk-release` 环境的 `AGYCODROID_RELEASE_KEY` secret；指纹检查随后会校验每个 APK 确实是这把钥匙签的。

要在自己的机器上构建，装 JDK 17、Node.js、Android SDK（build-tools 和一个 platform）和 NDK，再按 `build.sh` 顶部说的设环境变量。`apk.yml` 就是个能用的例子。脚本默认的工具路径指向作者的安卓平板。

工具链由 GitHub Actions 构建和发布：推一个 `devkit-YYYY.MM.DD` 这样的 tag（见 [.github/workflows/devkit.yml](.github/workflows/devkit.yml)）。
应用下载哪个版本的工具链由 [devkit-sources.txt](devkit-sources.txt) 定。那个版本的大小和 SHA-256 在 [devkit-pin.json](devkit-pin.json) 里，文件随 APK 一起发：首次安装（从 GitHub、cccodroid.net 镜像或本地文件）和本地文件检查都信任它，而不是信任下载来源。它还钉住了锁文件 `devkit.lock.json` 本身的 SHA-256，`build.sh` 在解开 glibc 加载器之前会先校验它，而不是只信 HTTPS。换版本时改前者，跑 `node scripts/pin-devkit.mjs "$(head -1 devkit-sources.txt)" devkit-pin.json`，两个一起提交；`build.sh` 会检查它们是否一致。

目录结构：

| 目录 | 内容 |
|---|---|
| `android/` | Java 壳、Manifest、资源、终端助手（`assets/bin/`）、native 库（`native/`）、APK 自带的原版 glibc 加载器（`prebuilt/glibc/`） |
| `gateway/` | 网关（`server.mjs` + `gw/` 下的功能模块，Node.js）和界面（`web/`，纯 JS，没有构建步骤） |
| `i18n/` | 界面翻译：每种语言一个 txt，加生成和检查脚本，见 [i18n/README.md](i18n/README.md) |
| `devkit/` | 工具链构建脚本和清单 |
| `docs/design-philosophy.md` | 项目为什么存在，背后的原则 |
| `docs/large-screen.md` | 大屏布局（平板、折叠屏）及代码位置 |
| `docs/known-issues.md` | 已知问题和未完全排除的风险，以及会制造假 bug 的测试动作 |
| `docs/download-sources.md` | 每条下载链：来源、信任锚、服务器镜像、改动后怎么检查和维护 |
| `docs/memory-management.md` | 怎么读内存数字、怎么找吃内存的进程、内存管家怎么工作 |
| `docs/work-island.md` | Work Island（ColorOS）集成：部件、开关、设计说明和已知限制 |
| `docs/permissions.md` | 每个权限是干什么的、什么时候问你、拒绝会怎样，以及三个重量级权限的风险 |
| `docs/agy-versions.md` | 设备端验证新版 Antigravity CLI、本地已验证记录，以及自动更新怎么用 manifest |
| `docs/diagrams/` | 架构图（Archify JSON 规格 → 交互式 HTML → 浅色 / 深色 PNG） |
| `third_party/` | Shizuku-API 13.1.5（MIT，Maven Central 原样） |

## 特别感谢

- **[cccodroid](https://github.com/greyoak111/cccodroid)**（greyoak111）：整个应用都是他们的工作——agycodroid 是换了引擎的 fork。下面的感谢原样继承自上游。
- **[DeepSeek Harness for Android](https://github.com/woaiys3/deepseek-harness-android-app)**（woaiys3）：不用 root 在手机上跑 AI 智能体、经 Shizuku 提权、用前台服务保活——这些路是它先走的。cccodroid 早期的探索和开发就是在它搭的环境里做的；今天 Claude Code 能这样在安卓上跑，基础是它和它的作者打下的。
- **[Archify](https://github.com/tt-a1i/archify)**（tt-a1i，MIT）：上面的架构图是用它做的，也过了它的布局检查；许可证在 [ThirdPartyLicenses/Archify](ThirdPartyLicenses/Archify/LICENSE)。
- **[Eruda](https://github.com/liriliri/eruda)**（liriliri，MIT）：预览和浏览器面板里的开发者工具；许可证在 [ThirdPartyLicenses/eruda](ThirdPartyLicenses/eruda/LICENSE)。
- **[Termux](https://termux.dev)**：工具链是用它的官方包组装的。
- **[Shizuku](https://shizuku.rikka.app)**（RikkaApps）：不用 root 的系统权限。
- **[OpenCC](https://github.com/BYVoid/OpenCC)** / [opencc-js](https://github.com/nk2028/opencc-js)：繁体中文界面字符串是用它转换的，再人工校对过。

### 社区贡献者

继承自 cccodroid——下面这些人建造了这个 fork 所站的应用：

- **[bmbmm-114514](https://github.com/bmbmm-114514)**：一次细致的代码审查，报了十个安全和稳定性问题，每个都带复现步骤和代码位置；0.3.2 全部修好。
- **[IVESHOWARD](https://github.com/IVESHOWARD)**：报了技能压缩包导入的问题（一次只导进一个技能、有的压缩包认不出来）；0.3.2 修好。
- **[CCB-Fox](https://github.com/CCB-Fox)**：Dimensity GPU 驱动组件（[cccodroid-components#46](https://github.com/greyoak111/cccodroid-components/pull/46)），由此有了 Mali 支持，0.3.3。
- **[Cosmosophius](https://github.com/Cosmosophius)**：一份详尽的 Dimensity 9300 报告（[cccodroid-components#47](https://github.com/greyoak111/cccodroid-components/issues/47)）。
- **[gogoiPhone](https://github.com/gogoiPhone)**：Redmi K70 Ultra 设备报告，带自己的 Vulkan 计算测试（[#14](https://github.com/greyoak111/cccodroid/issues/14)）。
- **[Slingerspir](https://github.com/Slingerspir)**：建议了 GitHub 加速路线和多线程下载；0.4.1 加了分段并行下载和 gh-proxy 备用。
- **[hye45402-pixel](https://github.com/hye45402-pixel)**：要了 LaTeX、语法高亮、代码块语言标签、删除线、粗斜体和任务列表；0.4.4 全部加上。
- **[STUTTEFRFIX](https://github.com/STUTTEFRFIX)**：Work Island 集成，在 ColorOS 16 流体云岛上显示 Claude 的工作状态（[#20](https://github.com/greyoak111/cccodroid/pull/20)、[#21](https://github.com/greyoak111/cccodroid/pull/21)），配套应用 [WorkIsland-Android](https://github.com/STUTTEFRFIX/WorkIsland-Android)。cccodroid 合并的第一个外部 PR；0.4.7 上线。
- **[ThinkReally114](https://github.com/ThinkReally114)**：0.3.x 期间的反馈和 bug 报告。
- **[wangxp12](https://github.com/wangxp12)**：0.3.x 期间的反馈和 bug 报告。
- **[unoyg](https://github.com/unoyg)**：0.3.x 期间的反馈和 bug 报告。
- **[fisHarly0](https://github.com/fisHarly0)**：0.3.x 期间的建议和 bug 报告。
- **[chenshi723](https://github.com/chenshi723)**：0.4.x 期间的前端建议。0.4.11 整套界面动效就是从他一句"动效感觉光秃秃的"开始的；他后来又指出侧边栏关闭时的残留动画、新聊天问候语渲染两次、流式卡顿、DeepSeek 余额显示 0 和字体不完全跟系统——0.4.11–0.4.12 陆续修好。0.5.15 的 OpenAI bridge 配置面板和安全卸载来自他的 PR（[#58](https://github.com/greyoak111/cccodroid/pull/58)），他还维护 [cccodroid-openai-bridge](https://github.com/chenshi723/cccodroid-openai-bridge) 组件。从 0.5.20 起他深度审查每个版本（0.6.0 一个版本 80 多条发现，0.6.4 十二份报告），还查出后台程序在点了"保留"之后还反复问确认的原因（[#167](https://github.com/greyoak111/cccodroid/issues/167)，0.6.7 修好）。
- **[leemwood](https://github.com/leemwood)**：指出网页预览缺元素点选，由此有了 0.4.14 的 DevTools 和"帮 Claude 点元素"。
- **[hwsyyds666](https://github.com/hwsyyds666)**：一加 Ace 5 ColorOS 16 的设备报告（[#61](https://github.com/greyoak111/cccodroid/issues/61)）。
- **[zx-5426](https://github.com/zx-5426)**、**[1fshi26](https://github.com/1fshi26)** 和 **[FatBrother1](https://github.com/FatBrother1)**：红队的核心，0.6.x 安全工作的一大半。
  - zx-5426 的红队材料让 0.6.7 的越狱检查抓住了好几种专门绕检测的写法。他还贡献了 21 个修复提交（分段下载写入、流修复、并发缩略图、定时任务、卡住的队列、台账健壮性等等），0.6.4–0.6.7 陆续合并。
  - 1fshi26 的越狱研究笔记进了 0.6.2 的加固：项目里会自己跑的钩子和 MCP 服务器现在先问你再加载。
  - FatBrother1 参加红队测试。

报告、设备测试和代码审查也是贡献，都记在这里。

## 许可证

agycodroid 本身按 [Apache License 2.0](LICENSE) 发布（另见 [NOTICE](NOTICE)）。

### 第三方组件

- **Antigravity CLI**：Google 的专有软件，**不随本项目分发**。使用要遵守 Google 对 Antigravity CLI 的条款。
- **cccodroid**：本 fork 所基于的上游项目，Apache-2.0，作者 greyoak111 及贡献者——见[上游仓库](https://github.com/greyoak111/cccodroid)。
- **工具链**：取自官方 Termux 仓库；每个组件按自己的许可证分发（包括 GPL）。版本、哈希和构建配方在每个 release 附带的 `devkit.lock.json` / `SBOM.tsv` 里。需要源码副本请在 Issues 里说。
- **glibc 动态加载器**（`lib/arm64-v8a/libldlinux.so`，随 APK 附带）：来自 Termux 的 glibc 包，LGPL-2.1-or-later。见 [android/prebuilt/glibc](android/prebuilt/glibc/README.md)。
- **Shizuku-API**：MIT，见 [third_party/shizuku/LICENSE](third_party/shizuku/LICENSE)。
- **xz-decompress**（构建工具链时用）：MIT。
- **[xterm.js](https://xtermjs.org)**（终端）：MIT，见 [ThirdPartyLicenses/xterm.js](ThirdPartyLicenses/xterm.js/LICENSE)。
- **[highlight.js](https://highlightjs.org)**（聊天里的代码高亮）：BSD-3-Clause，见 [ThirdPartyLicenses/highlight.js](ThirdPartyLicenses/highlight.js/LICENSE)。
- **[KaTeX](https://katex.org)**（聊天里的数学）：MIT，见 [ThirdPartyLicenses/KaTeX](ThirdPartyLicenses/KaTeX/LICENSE)。
- **[pdf.js](https://mozilla.github.io/pdf.js/)**（PDF 查看器）：Apache-2.0；它自带的 OpenJPEG / JBIG2 / QCMS 解码器各有自己的许可证。见 [ThirdPartyLicenses/pdf.js](ThirdPartyLicenses/pdf.js/)。
- **CC Mono**（界面和终端的等宽字体）：GitHub 的 [Monaspace Neon](https://github.com/githubnext/monaspace) 的子集，SIL OFL 1.1，按保留字体名条款改了名。见 [ThirdPartyLicenses/ccmono](ThirdPartyLicenses/ccmono/LICENSE)。
- **`android.jar`** 不随附（它的许可证禁止再分发）；想在手机上编译 APK 请自己下载。
