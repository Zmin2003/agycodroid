# 权限说明

[English](permissions.md) | 中文

agycodroid 申请的权限不少。这一页逐个说明每个权限拿来干什么、什么时候才会问你、不给会怎样。

先说最要紧的一点：**Antigravity 在 agycodroid 里能以这个应用的身份执行任意命令**，这本来就是它的用途。所以应用拿到的每一项权限，Antigravity 跑的命令也都拿得到。给权限之前，请按这个前提来判断。下一节是这层之内的第二道关：Antigravity 自己的工具调用，哪些要先问你。

## 一览

| 权限 | 用来做什么 | 什么时候问 | 不给会怎样 |
|---|---|---|---|
| 网络（`INTERNET`、`ACCESS_NETWORK_STATE`） | 连模型接口、下载 Antigravity CLI 和工具包；看当前连的是不是 Wi-Fi（定时任务的「只在 Wi-Fi 下」） | 不用问，装上就有 | 没法用 |
| 存储（`READ/WRITE_EXTERNAL_STORAGE`，36 版另要「所有文件访问」`MANAGE_EXTERNAL_STORAGE`） | 读写 `/sdcard/agycodroid`：交付给别的应用的 APK、截图、离线工具包；也让 Antigravity 能处理你放在共享存储里的文件 | 28 版首次打开时；36 版问一次，带你去系统设置 | 能用，产物只留在应用私有目录，别的应用看不到 |
| 通知（`POST_NOTIFICATIONS`） | 后台跑完、定时任务结果、需要你确认的操作 | 首次打开 | 能用，只是在后台时收不到提醒 |
| 锁屏验证（`USE_BIOMETRIC`） | 把需要长期保存的安全开关（后台保活增强、设备工具、特权命令免确认、网页调试）用锁屏再确认一遍 | 打开受保护的开关时（系统锁屏确认，不是权限弹窗） | 开关只在这次运行有效，重启应用后要重新打开 |
| 前台服务、保持唤醒（`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_SPECIAL_USE`、`WAKE_LOCK`） | 让网关在你切走、锁屏后继续把这一轮跑完 | 不用问 | 不能拒绝；没有它，切到后台几秒就会断网、中断 |
| 忽略电池优化（`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`） | 让系统省电策略别冻结后台的长任务 | 你在设置里点「后台运行」时 | 长任务、定时任务在锁屏后可能被系统停掉 |
| 精确闹钟、开机广播（`SCHEDULE_EXACT_ALARM`、`RECEIVE_BOOT_COMPLETED`） | 定时任务到点叫醒网关；开机后重新激活 Shizuku（只在你配对过、且在设置里打开了自动激活时，默认关） | 不用问 | 定时任务可能晚一点才跑；开机后要手动激活 Shizuku |
| 安装应用（`REQUEST_INSTALL_PACKAGES`） | 应用内更新 agycodroid；把 Antigravity 在本机打包好的 APK 装上 | 第一次装的时候，系统让你在设置里允许 | 更新要自己去下载安装 |
| 设置闹钟（`SET_ALARM`） | 设备工具里「帮我定个闹钟」：交给系统时钟应用 | 不用问 | 设备工具没法定闹钟 |
| 全屏通知（`USE_FULL_SCREEN_INTENT`） | 配对 Shizuku 时，让带输入框的配对通知一直停在屏幕顶部 | 不用问 | 配对通知可能自己收起，要下拉通知栏去找 |
| Shizuku（`moe.shizuku.manager.permission.API_V23`） | 可选。拿到 shell 身份（uid 2000），用于免确认安装、给自己开所有文件访问、设备工具 | 你在设置里主动开启时 | 这几样功能用不了，其余照常 |
| 写安全设置（`WRITE_SECURE_SETTINGS`） | 只能经 Shizuku 授予。用来在重启后自己打开无线调试、重新激活 Shizuku；按需开关 agycodroid 自己的无障碍服务 | Shizuku 授权时一并给 | 每次重启要手动激活 Shizuku；无障碍要自己去系统设置开 |

## Antigravity 自己的权限：哪些事不用问你就能做

上面 Android 的权限决定的是*应用*能碰到什么。应用里面还有第二道关，决定 *Antigravity* 哪些事不用问你就能做：它的权限引擎。每个敏感操作都是一条 `action(target)` 形式的资源，按 agy 的 `settings.json` 里 `permissions.allow`、`permissions.ask`、`permissions.deny` 三张表来判（桌面端这个文件在 `~/.gemini/antigravity-cli/settings.json`，手机上在 agycodroid 的 home 目录下）：

- **deny（拒绝）**：立刻拦下，任何模式下都拦。
- **ask（询问）**：先停下来等你点头再做。
- **allow（允许）**：不用问，直接做。

优先级是死的：**deny 高于 ask，ask 高于 allow**。`always-proceed` 下 ask 规则照样会问；任何预设、`--dangerously-skip-permissions` 下 deny 规则照样拦。

### 规则长什么样

| 动作 | 目标 | 默认 |
|---|---|---|
| `read_file` | `read_file(/路径)`、`read_file(目录)`、`read_file(*)` | 问（工作区里默认允许） |
| `write_file` | `write_file(/路径)`、`write_file(*)` | 问（工作区里默认允许） |
| `read_url` | `read_url(域名)`、`read_url(*)` | 问 |
| `execute_url` | `execute_url(域名)`、`execute_url(*)` | 问 |
| `download_url` | `download_url(域名)`、`download_url(*)` | 问 |
| `command` | `command(前缀)`、`command(regex:正则)`、`command(*)` | 问（Default / Auto 预设下，沙箱里的命令默认允许） |
| `mcp` | `mcp(服务器/工具)`、`mcp(服务器/*)`、`mcp(*)` | 问 |

匹配细节：`command(...)` 默认按单词/词元前缀匹配；`regex:` 开头的按整行匹配。能把另一条命令藏在良性前缀后面的写法——`$(...)`、反引号、`{a,b}`、重定向——会让这一整行失去前缀匹配：只有整行和规则逐字对上才不用问，否则照样问。`write_file` 允许了某个路径，就等于也允许了那里的 `read_file`；`read_file` 被拒了，那里的 `write_file` 也一起被拒。

规则示例（写在 `settings.json` 的 `permissions` 里）：

```json
{
  "permissions": {
    "allow": ["command(git)", "command(npm test)", "write_file(src/)"],
    "ask": ["command(git push)"],
    "deny": ["command(rm -rf)", "command(sudo)", "write_file(.git/)"]
  }
}
```

### toolPermission：四档

| `toolPermission` | 行为 |
|---|---|
| `request-review`（默认） | 写文件、终端、联网、MCP 工具都要问，除非 allow 规则盖住了 |
| `proceed-in-sandbox` | 沙箱开着、命令又在沙箱里跑，就不用问；沙箱外面的要问 |
| `always-proceed` | 命令、联网、MCP 工具都不问，除非 ask 或 deny 规则命中 |
| `strict` | 每次工具调用都问，连读文件都问，哪怕 allow 规则盖住了 |

在 `settings.json` 里改，交互会话里也可以用 `/config` 改。`--dangerously-skip-permissions` 是把某一次运行切到 `always-proceed`（见下）。

### agentMode：文件改动谁说了算

| `agentMode` | 文件改动 | 终端命令 |
|---|---|---|
| `default` | 先给你看 diff，等你点头 | 先问（按 `toolPermission`） |
| `accept-edits` | 工作区里的改动直接生效 | 先问（按 `toolPermission`） |
| `auto` | 直接生效 | 沙箱里直接跑；沙箱外面，安全可逆的直接跑，有风险的先问 |
| `plan` | 先批计划，批了才动 | 先读、先提方案 |

一次运行用 `--mode=<模式>` 指定，默认写 `settings.json` 里的 `"agentMode"`。交互会话里按 `Shift+Tab` 轮换。

### 无人值守：没人回答的询问算软拒绝

agycodroid 跑 agy 是 headless（`-p`）：跑到一半没人能回答确认。某个工具调用需要批准、又没人能批时，agy 会**软拒绝**它——这一轮继续跑，stderr 里会写明是哪个工具、以及事先要在 allow 里放哪条规则。它既不会卡住，也不会悄悄放行。所以无人值守的轮次必须用到的工具，要事先放进 `permissions.allow`；ask 表列得越宽，headless 下拦得越多。

### `--dangerously-skip-permissions` 只是逃生口，不是默认

这个旗标让某一次运行里的全部工具权限请求自动通过——相当于单次的 `always-proceed`。agycodroid **默认不传它**。只在你已经圈好范围的某一次运行里用（比如已经在沙箱里），平时要放行 headless 轮次，优先用收紧的 `permissions.allow` 规则：只放开那一轮确实要用的工具，破坏性的照样被 deny 拦住。开了这个旗标，deny 规则仍然生效。

## 没有申请的

相机、麦克风、定位、通讯录、短信、通话记录都没有申请。

拍照（输入栏「＋」里的拍照）是交给系统相机应用拍完再传回来，所以不需要相机权限。

## 三项重权限，单独说

**所有文件访问。** 给了以后，应用和 Antigravity 能读写整个共享存储，不只是 `/sdcard/agycodroid`。要是你的照片、文档也放在共享存储里，Antigravity 跑的命令同样碰得到。不想这样就别开，只用应用私有目录。

**Shizuku 与写安全设置。** 这是 shell 身份，能做的事比普通应用多得多，比如装卸应用、改系统设置。agycodroid 用它做的事都记在设置里 Shizuku 那一栏的「特权命令记录」里。设备工具（让 Antigravity 截屏、点屏幕、开关系统设置）和无障碍服务**默认都是关的**，要你自己打开；无障碍闲置一段时间会自动关掉。

有两点要心里有数。第一，授权给的是 agycodroid 这个应用，不是某一个按钮：应用里跑的任何代码，包括 Antigravity 执行的命令、你装的组件，都能经应用转一手拿到 shell 身份；开机自动激活又会让这份权限一直延续下去。所以开了 Shizuku，就等于信任在 agycodroid 里跑的一切。为了让偷偷借用至少有动静：经 `priv` 跑的命令，只有带服务名的 dumpsys、pm list、settings get 这类查看命令，以及内存管家要用的停止应用、限制应用后台（am force-stop / stop-app / set-bg-restriction-level）直接执行，其余（装卸应用、改设置、截屏、模拟点按、读全机日志 logcat、读共享存储里的文件等）都会先在 agycodroid 里弹窗等你点允许，agycodroid 不在前台时直接拒绝。这是一道提醒，不是隔离墙。不需要了，到 Shizuku 里撤销授权（自动激活默认关，打开过的话也关掉）。第二，特权命令记录存在应用自己的目录里，是给你查看用的，不是防篡改的审计日志：在应用里跑的代码本身就有办法改它。

**安装应用。** 系统每次都会弹确认页，你点了才装。有 Shizuku 时可以免确认，这种情况同样会记进特权命令记录。

## 发现了安全问题

请看 [SECURITY.md](../SECURITY.md)，私下报告，别发在公开的地方。
