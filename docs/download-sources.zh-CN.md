# 多源下载：维护手册

[English](download-sources.md) | 中文

agycodroid 要从网上取的东西有八类，大多有不止一个来源。这份文档写清楚每一类从哪下、凭什么信、在哪改、改完怎么验。

**一条总原则：先有信任锚，再下载。** 每一类东西都有一个不依赖下载来源的校验依据：钉在 APK 里的哈希，或者钉在代码里的签名公钥。镜像只是换条线路取同一份文件，不需要被信任。新增来源时，只要内容仍然按信任锚核对，就不会降低安全性。反过来，**任何改动都不能让「从镜像拿到的东西」变成信任锚本身。**

最后核对：2026-11-19（agycodroid fork；Antigravity CLI 那一行按官方 manifest 现查过——核对时版本是 1.5.12，永远现读 manifest，不要钉死）。

---

## 一览

| # | 下载什么 | 来源（按尝试顺序） | 信任锚 | 代码 |
|---|---|---|---|---|
| 1 | 开发工具包（0.3.9 起按模块：默认约 330 MB，全部约 700 MB；旧版 App 用整包约 650 MB） | 只走 GitHub Release——fork 暂无镜像站（见下面“服务器端”） | APK 自带的 `devkit-pin.json`（整包 gz / tar 与 `modules.json` 的 sha256，`modules.json` 里再有每块的 sha256） | `Installer.java`、`Updater.java`、`gateway/gw/modules.mjs`（扩展页加装） |
| 2 | APK 更新 | 发布列表：只查 GitHub API；APK：GitHub Release → gh-proxy | Android 的 APK 签名（同一把发布钥匙才能覆盖安装）+ 发布列表里的 sha256 | `Updater.java` |
| 3 | Antigravity CLI（agy） | 只有官方 manifest（antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json） | Google 官方 manifest 给的 sha512（agy 没有 PGP 签名）；版本 / URL / sha512 安装时现读，不硬编码 | `assets/scripts/install-agy.mjs` |
| 4 | 组件索引 | 只走 GitHub Release（fork 暂无镜像站） | 钉在网关里的 ed25519 公钥 | `gateway/gw/components.mjs` `compFetchIndex` |
| 5 | 组件包 | 只走 GitHub Release（fork 暂无镜像站） | 签名索引里的 sha256，解包后再按包内 MANIFEST 逐个核对 | `gateway/gw/components.mjs` `compRunInstall` |
| 6 | pkg 装软件 | Termux 官方 → packages.termux.dev → grimler.se → 清华/中科大/北外/南大（main、x11） | 钉在 pkg 里的 Termux 自动构建钥，验 `Release.gpg` | `assets/bin/pkg.mjs` |
| 7 | 自定义组件补 glibc 库 | Termux 官方 glibc 仓库（只此一个） | HTTPS + `Packages` 里的 sha256 | `gateway/gw/custom.mjs` `customFetchLibs` |

**0.4.1 起的两项通用做法**（工具包、APK 更新、组件包、Antigravity CLI 都适用）：

- **分段并行**：文件不小于 16 MB、服务器认 Range 时，把没下的部分切成最多 4 段同时下，按偏移写进同一个 `.part`（先占满到总大小），每段进度记在 `.part.seg`。被打断或换来源后按它续传；`.seg` 和 `.part` 对不上就两个都作废重来。来源不认 Range 时退回单连接。上游镜像 dl.cccodroid.net 上的实测（fork 之前；fork 暂无镜像站）：单线约 2.7 MB/s，4 路约 14 MB/s。代码：`Installer.java` 的 `fetchSegmented`、`gateway/gw/pget.mjs`。
- **低速换源**（0.4.2 起，APK 与工具包的 Java 下载）：每条连接每 30 秒一窗，不到 600 KB 就当这次失败，触发重试与换源；已经没有别的来源时不计失败次数、接着续传。以前只有连不上、或 60 秒一个字节不来才换源，GitHub 慢慢滴的时候会一直卡在 0%（群友报的 0.3.16 → 0.4.1）。代码：`Installer.java` 的 `Slow`。
- **gh-proxy.com 兜底**：GitHub 地址在其余来源都不顺时，最后再试一次 `https://gh-proxy.com/github.com/…`。这是第三方服务，不需要信任它：内容照样按上表的信任锚核对。（讨论区 #15 的建议）

另外，有的组件首次运行时还会自己下东西，比如 Blender 从 Debian 官方仓库取本体、从 GitHub 取补丁版 Mesa。这部分由组件自己的首次运行脚本负责，按脚本里钉的 sha256 核对，**不在本文的多源机制内**。

---

## 服务器端（暂无镜像站——下面是上游 cccodroid.net 的说明，仅供参考）

**Fork 现状（2026-11-19）：agycodroid 没有域名、没有 VPS、没有镜像站。** 下面这张表和生成器说明写的是*上游* cccodroid.net 的做法，留着参考，等 fork 有了自己的基础设施再说；今天对 agycodroid 一条都不适用。下载目前只走 GitHub Release（见上面一览表）。`scripts/publish-devkit.mjs`（mirror 步）和 `scripts/ship.mjs`（site 步）在有这套基础设施之前是停用/跳过的。

两个域名，同一台服务器（仅限上游）：

| 域名 | 经 Cloudflare？ | 放什么 |
|---|---|---|
| `cccodroid.net` | 是（橙云） | 网页、APK（`/dl/`）、组件索引（`/components/<official\|community>/components.json(.sig)`）、Antigravity CLI 清单（`/claude-code/`） |
| `dl.cccodroid.net` | 否（灰云，直连） | 工具包（`/devkit/`）、组件包（`/components/<official\|community>/<文件名>`）、Antigravity CLI 清单（`/claude-code/`，与上面同一份） |

**为什么要两个**：几百 MB 的大文件不该走 CDN；另外国内有的网络只能通其中一条线，所以 Antigravity CLI 的清单在两边都放了一份。

**谁在维护**：生成器 `repos/agycodroid-site/src/build.mjs`，由服务器上的 `agycodroid-site.timer` 每 30 分钟运行一次。服务的超时时间用 drop-in 放宽到 60 分钟，见 `/etc/systemd/system/agycodroid-site.service.d/timeout.conf`。各项内容的生成方式：

- **APK、发布列表**（`fetchReleases`）：只收 sha256 和 GitHub 记录一致的文件，保留最近 4 个版本。
- **工具包**（`fetchDevkits`）：只留 APK 绑定的那一版和最新的一版，sha256 与 `devkit.lock.json` 核对。
- **组件索引**（`fetchIndexes`）：ed25519 签名验过才更新，拉取失败就沿用上次的结果。
- **组件包**（`fetchComponentFiles`）：只收验过签名的索引里列出的包，逐个核对 sha256，核过的在旁边写一个 `.ok` 记号，对外访问不到；索引里已经没有的包会被删掉。这一步放在网页换版**之后**才跑，第一次同步 4 GB，不耽误整站更新。
- **Antigravity CLI 清单**（`fetchAntigravity`）：同步 stable、latest 两个渠道的版本号，以及最近 12 个版本的 `manifest.json` 和 `.sig`，**Anthropic 的 PGP 签名验过才收**。只镜像清单，不镜像程序本身，见下面第 3 节。

nginx 配置：`/etc/nginx/sites-available/agycodroid.conf` 和 `agycodroid-dl.conf`。数据目录是 `/var/www/agycodroid/data/`，属 `ccsite` 用户。`dl.cccodroid.net` 的 `/claude-code/` 是 `alias` 到 `data/current/claude-code/` 的，跟着网页一起原子换版。

部署方法见 `repos/agycodroid-site/README.md`。**这台服务器上还跑着别的站点，只动 agycodroid 相关的文件。**

---

## 分项说明

### 1. 开发工具包

- 首次安装时，安装页让用户选来源：GitHub 或本地文件（fork 暂无镜像站，上游的 cccodroid.net 镜像不可用）。最后再试 gh-proxy；按顺序依次换、不回头，用同一个 `.part` 文件接着续传。
- 校验值以 APK 里的 `assets/devkit-pin.json` 为准。这个文件由 `scripts/pin-devkit.mjs` 生成，`build.sh` 会核对它和 `devkit-sources.txt` 是不是同一版。
- **改工具包版本时**：先发布 devkit Release，再更新 `devkit-sources.txt`，然后跑 `pin-devkit.mjs`，最后打 APK。新绑定的版本从 GitHub Release 取：pin 跟着 APK 走，工具包从 Release 上下载——fork 没有自己的服务器。
- `pin-devkit.mjs` 要求锁文件带签名（`devkit.lock.json.sig`）并验过。只有 10-29 之前那几版本来就没签，这种情况确认无误后加 `PIN_ALLOW_UNSIGNED=1` 重跑，生成的 pin 里会记 `lockSigned:false`。新版本不要用这个开关。
- 预置组件索引（`components` Release 上的 `components.json` 和 `.sig`）：`publish-devkit.mjs` 合并前先用发布钥匙验线上那份，验不过就停。`components-index.mjs` 在有私钥时也只合并验得过的旧索引。全新的仓库（Release 上还没有索引）第一次要手工播种：对一个不存在的输出路径跑 `INDEX_SIGNING_KEY_FILE=<钥匙> node devkit/components-index.mjs <新路径>/components.json <URL 前缀> <component-x.json>`，把生成的 `components.json` 和 `components.json.sig` 传到 `components` Release，之后就交给 `publish-devkit.mjs`。

### 2. APK 更新

- 先查 GitHub API。fork 只有 GitHub API 这一个发布列表来源（上游的 `cccodroid.net/dl/releases.json` 和 `dl.cccodroid.net/dl/releases.json` 镜像不提供 agycodroid）。APK 本身由 Android 按签名把关。
- APK 依次试 GitHub Release → gh-proxy，同一个 `.part` 接着续传。（上游还会试 `cccodroid.net/dl/<版本>/` 和 `dl.cccodroid.net/dl/<版本>/`；那两个镜像只服务上游，不提供 agycodroid。）
- 本地测试可以写 `home/.config/agycodroid/update-feed` 来覆盖发布列表的地址。

### 3. Antigravity CLI（最复杂的一项）

**只有 manifest，没有镜像，没有后备。** Antigravity CLI 是闭源软件，我们自己托管二进制属于再分发，有违反条款的风险。Google 不提供按版本的下载地址，也没有签名：唯一的来源是官方 manifest，`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json`（和官方 `install.sh` 用的地址一样：`DOWNLOAD_BASE_URL + "/manifests/" + platform + ".json"`）。manifest 返回 `{"version","url","sha512"}`——版本就是当时的最新版，URL 是 tar.gz 的地址，sha512 是它的校验和。版本 / URL / sha512 都是安装时现读的，应用里任何地方都不写死。

**信任锚（只有一个）**：Google 官方 manifest 里的 sha512，经 TLS 取回。agy 没有像 Anthropic 那样的 PGP 签名清单——不要编造签名 / 公钥，也不要加钥匙。安装流程（`android/assets/scripts/install-agy.mjs`）：

1. 读 manifest，取 `version` / `url` / `sha512`。
2. 按 manifest 的 URL 下载 tar.gz，核 sha512，对不上就不装。
3. 解出名字叫 `antigravity` 的成员，落地为 `agy`（755）。
4. 先试跑 `agy --version`，跑得起来才切 `current` 软链。只留当前版 + 上一版。
5. 存两份记录供启动前核验：manifest 的副本（`manifest.json`）和程序本身的 sha512（`agy.sha512`，安装时现算——manifest 的 sha512 是 tar.gz 的，不能直接拿来比程序）。

**manifest 带来的限制**（不是我们定的）：

- manifest 永远只给最新版：要装的版本如果不是 manifest 当时的最新版、本地又没装过，就装不了（没有按版本取包的官方地址）。
- 没有 stable / latest 频道，也不能固定装一个从没装过的旧版本。
- `agy` 是官方 bionic 安卓构建，直接跑：不用 glibc 加载器、不用 seccomp 垫片、不用 DNS 桥。

**下载行为**：

- 用 `.part` 文件续传；期望的 sha512 存在 `.part.sha512` 里，续传下来的照样校验。
- manifest 连不上，安装就按大白话报错失败；没有镜像可以 fallback。

**测试**：一个环境变量可以替换 manifest 地址，用来模拟官方连不上（换了地址，内容照样要过 sha512）：

```sh
AGAPP_AGY_MANIFEST_URL=https://127.0.0.1:9/x   # 让官方 manifest 连不上
bash install-agy.sh latest        # 或具体版本号（如果已经装过）
```

至少要覆盖这几个场景：manifest 能连上，安装成功且 `agy --version` 对得上；manifest 连不上，安装干净失败；tar.gz 的 sha512 对不上，安装拒绝；切回以前装过的版本可以离线完成。

### 4、5. 组件索引与组件包

- 索引：只走 GitHub（fork 暂无镜像站；上游的 `COMP_INDEX_MIRROR`（cccodroid.net）备用不适用）。ed25519 公钥钉在网关里。
- 组件包：目前只走 GitHub（fork 暂无镜像站；上游把 GitHub 地址映射到 `dl.cccodroid.net/components/<official|community>/<文件名>` 的 `compMirrorUrl(b)` 不适用）。界面的进度条会显示当前来源（`progress.via`）。
- **新发布组件时不需要做任何额外的事**：生成器下一轮会自动把新包同步过去。可以用下面的检查脚本（「定期检查」一节）确认。

### 6. pkg

- 仓库列表在 `REPOS`，每个仓库有一个 `base` 和一组 `mirrors`。
- **验签**：先取 `Release` 和 `Release.gpg`，用 `TERMUX_KEYS` 验签；`Packages.gz` 按 `Release` 里记的 sha256 核对；每个 `.deb` 再按 `Packages` 里的 sha256 核对。
  - 签名文件取不到的源一律不用，Termux 自己的域名也一样；全都取不到时用缓存的旧索引。
  - **其他镜像拿不到签名或签名不对，一律不用。**
- **国内镜像**：清华、中科大、北外、南大都只同步了 main 和 x11，**没有 glibc 仓库**（2026-10-20 核实）；阿里云没有 Termux 镜像。国内镜像比官方晚 10 到 15 个小时：索引从官方拿、包从镜像下时，可能遇到 404，代码会自动换下一个来源。
- **索引从哪个来源拿到的，下载包时就先试那个来源**（`repo.from`），免得官方连不上时，每个包都先在官方地址上空等。
- 某个仓库取不到索引时只跳过这一个仓库，全部取不到才报错。
- Termux 签名钥：`CC72CF8BA7DBFA0182877D045A897D96E57CF20C`（RSA，termux-autobuilds）。取自 termux-packages 仓库里的 `packages/termux-keyring/termux-autobuilds.gpg`，以及 keyserver.ubuntu.com、keys.openpgp.org，三处一致。**Termux 换钥匙的话，pkg 会对所有来源都验签失败**，届时要按同样的流程核实新钥后更新。
- **源文件是 `android/assets/bin/pkg.mjs`**。`android/assets/app/` 是构建产物，每次 `build.sh` 都会清掉重新生成，改在那里会被冲掉。

### 7. 自定义组件补 glibc 库

只有 Termux 官方的 glibc 仓库可用，因为国内没有镜像。用户连不上时，分析结果会把这些库列为「找不到来源」，装还是能装，只是可能跑不起来。以后想补的话，可以在 fork 自己的服务器（目前还没有）上镜像 `termux-glibc`，并像 pkg 那样验 `Release.gpg`。

---

## 定期检查（发版前或出问题时）

```sh
# agy 官方 manifest 能取到且 version/url/sha512 齐全；索引里每个组件包在 GitHub 上都在、大小一致（暂无镜像站可核）
node scripts/check-mirrors.mjs

#（没有可查的镜像服务器：fork 没有 VPS；上游的 agycodroid-site 服务不是我们的）
```

**常见问题**：

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| 安装日志里写「cccodroid.net 镜像的签名文件取不到」 | fork 没有镜像站，只走 GitHub（再试 gh-proxy） | 正常——如果接下来走到了 GitHub；如果它点名 cccodroid.net，那是上游残留引用，请反馈 |
| 组件包在 GitHub 上 404 | 刚发布，Release 附件还没传完 | 等一等再试；没有镜像生成器可催（fork 没有镜像服务器） |
| pkg 报「镜像的 Release 签名取不到」 | 镜像没同步 `Release.gpg`，或者镜像不完整 | 正常，换下一个来源；如果某个镜像长期这样，就从列表里拿掉 |
| pkg 所有来源都验签失败 | Termux 换了签名钥 | 按第 6 节的方法核实新钥后更新 `TERMUX_KEYS` |
| agy 安装失败：manifest 连不上 | Google 的 manifest 端点挂了或当前网络被挡 | 没有后备——等一等再试；也可以在浏览器里打开 manifest 地址看通不通 |
| agy 安装失败：sha512 对不上 | 下载损坏，或者下载中途 manifest 变了 | 重试；安装器会重新读 manifest、从头校验 |
| 装好的 agy 比 manifest 旧 | 有新版发布了 | 正常——去设置里更新；上一版会留着做回退 |

---

## 新增一个来源时的检查单

1. 它提供的文件和原始来源是否**逐字节相同**？抽一个文件核对 sha256。
2. 信任锚是否仍然不依赖这个来源？也就是说，内容是否照样按钉住的哈希或签名核对？
3. 失败时会不会拖慢其他来源？比如有没有连接超时，或者卡住时能不能被速度下限判定后切走。
4. 能不能和已有来源续传同一个 `.part` 文件？
5. 写进本文的「一览」表和对应的分项小节。
