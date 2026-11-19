# agy 版本：真机验证与已知问题

中文 | [English](agy-versions.md)

agycodroid 跑的是官方原版 Antigravity CLI（`agy`），一个字节都不改。Google 每发一版，agycodroid 用户都可能拿到，可这一版在电脑上没问题，不代表在安卓上也没问题。比如它开始用一个新的系统调用，安卓的 seccomp 可能会把这个调用拦下来，相应的功能就会出毛病。`agy` 是官方 bionic 安卓构建，直接跑——没有 glibc 加载器，也没有 seccomp 垫片（没有 `enosys-run`）兜底，所以真机验证更重要，不是更不重要。

所以维护者会在真机上验新版。验证记录是**本机、不签名的**：这个 fork 没有签名私钥，什么都不发布、不下发。App 只读本机记录 `home/.cache/agycodroid/agy-verified.json`，由验证脚本自己写。

## 版本从哪来

唯一的依据是 Google 的官方清单（Android arm64）：

`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json`

每个版本有三个字段：`version`、`url`（要下载的 tar.gz）和 `sha512`。agycodroid 从 `url` 下载，拿 `sha512` 核对，解包安装。版本号随发版变，任何地方都不硬编码。这里没有 stable / latest 两个渠道：一个清单、一个架构对应一个当前版本。

## 验证记录

每个验过的版本占一行，格式是：

| version（取自清单） | sha512（取自清单） | 验证设备（机型、Android 版本） | 验证日期 | 备注 |
|---|---|---|---|---|
| _—_ | _—_ | _—_ | _—_ | _—_ |

现在还没有记录：agy 移植之后，还没有哪个 agy 版本在真机上验过。版本号、哈希、设备、日期都要等真实的验证跑出来再写，不事先填。

记录放在两个地方，**互不同步**：

- **手机上**：`home/.cache/agycodroid/agy-verified.json`——`scripts/verify-agy.mjs` 验通过后直接写。版本选单和自动更新只读这一份。
- **仓库里**：`agy/verified.json`——维护者用 `scripts/agy-verified.mjs` 维护的本地记录。不签名、不发布，App 也不会去下载它。留着是为了维护者在改代码时记笔记、标有问题的版本。

## 用户看到什么

**设置 → 更新 → Antigravity CLI 版本**的选单里：

| 标记 | 意思 |
|---|---|
| **已验证** | 这一版在真机上跑过（本机记录里写着哪台设备、哪个 Android 版本；多台时写「等 N 台」） |
| **还没验证** | 这一版还没人验过，不代表有问题 |
| **有已知问题：……** | 维护者确认这一版在 agycodroid 上有问题，后面写着原因和绕法；修好的版本出来后会注明「x.y.z 已修」。选这一版之前会先问你 |

自动更新：清单走到一个**有已知问题**的版本时，连着 Wi-Fi 也不会自动装。更新状态里会写明原因。你自己点「更新」或在选单里选它，照样能装。固定了版本的不受影响。

## 验了什么，没验什么

真机验证先把要验的版本装进临时目录，不动当前装的那一版；装的时候照常按清单核 `sha512`。之后直接跑两步（不用监督器、不用垫片）：

1. **version**：`agy --version` 报的是清单里这一版
2. **tools**：调一次模型，让它用终端工具写一个文件再读出来。拉子进程、读写文件、流式输出都走一遍

`tools` 这一步要真的调模型（用这台机上 agy 自己的登录 / 配置，消耗很少）。

没验的：界面里每一个功能、各家第三方接口、每一种设备和 ROM。「已验证」的意思是「核心链路在这台设备上通了」，不是「什么都不会坏」。遇到问题请照常反馈，确认后这一版会被标成有问题。

## 维护者：怎么验、怎么记

在手机上（agycodroid 的终端，用你自己的登录，两步只花很少的额度）：

```sh
node verify-agy.mjs <版本号>
```

（脚本在 App 的 scripts 目录里，要用到终端的 `PREFIX` / `AGAPP_BIN`。要验的正好是当前装的那一版就直接用它，不再下载；`--bin` 可以直接验给定的二进制。）结果写成当前目录下的 `agy-verify-<版本>.json`，通过了就同时并进本机验证记录。28 版和 36 版安装包最好各跑一次（执行方式不同）。

在发布机上，维护仓库里的记录：

```sh
node scripts/agy-verified.mjs add agy-verify-<版本>.json …    # 并进验证记录
node scripts/agy-verified.mjs bad <版本> --zh "…" --en "…"        # 标成有问题
node scripts/agy-verified.mjs bad <版本> --zh "…" --en "…" --fixed <版本>   # 有修好的版本了
node scripts/agy-verified.mjs unbad <版本>     # 撤掉「有问题」
node scripts/agy-verified.mjs rm <版本>        # 删掉这一版的验证记录
node scripts/agy-verified.mjs list
```

这里什么都不签名、不发布：仓库里的记录只是本地笔记，App 也不会去读它。`add` 会拒收没通过的结果，也拒收不是在 agycodroid 终端里跑出来的结果（没有 App 版本或安装包类型的那种）。

## 代码在哪

| 位置 | 做什么 |
|---|---|
| `scripts/verify-agy.mjs` | 真机验证（手机上跑）；写本机验证记录 |
| `scripts/agy-verified.mjs` | 维护仓库里的记录 `agy/verified.json`（本地、不签名、不发布） |
| `gateway/gw/agyverified.mjs` | 读本机记录 `home/.cache/agycodroid/agy-verified.json` |
| `gateway/web/app/10-settings-device.js` | 版本选单里的标记与确认 |
| `android/java/cc/agyroid/Updater.java`（`knownBad`） | 自动更新跳过有问题的版本 |
