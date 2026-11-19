# agycodroid

**English** · [简体中文](README.zh-CN.md) · [Contributing](CONTRIBUTING.md)

**A development launcher that runs Google Antigravity CLI (`agy`) on Android phones.** No root, no custom ROM, no chroot / proot / VM.

[![License](https://img.shields.io/github/license/Zmin2003/agycodroid)](LICENSE)
![Android 8.0+](https://img.shields.io/badge/Android-8.0%2B-3ddc84)

<p align="center"><img src="docs/assets/hero.jpg" width="880" alt="agycodroid on a tablet: the sidebar, the welcome screen with the input box, and the components page listing Blender, Godot, Cloudflare and other installable tools"></p>

Android already runs on a Linux kernel. Once the tools run natively on that kernel, a phone can do real AI-assisted development:
write code, compile C/C++, run Python / Node, build APKs and push with git — all on the phone.

> agycodroid is a third-party project and is **not affiliated with Google**. It runs the **official, unmodified Antigravity CLI**:
> downloaded from Google's official manifest at install time, verified against the manifest's sha512, never modified.

> agycodroid is a fork of [cccodroid](https://github.com/greyoak111/cccodroid) (v0.7.9), which runs Claude Code the same way.
> Everything in this README that is not about `agy` itself is inherited from cccodroid; see
> [What changed vs cccodroid](#what-changed-vs-cccodroid) for the full list of what was replaced, changed or dropped.

> **Thank you, greyoak111.** agycodroid stands on [cccodroid](https://github.com/greyoak111/cccodroid): the gateway, the UI, the toolchain and the installer are all your work — this fork only replaces Claude Code with Antigravity CLI. Thank you for building it and sharing it openly.

## Why

When you use AI on a phone and the model needs to actually do something (run code, edit files, build a package), the work usually goes to a cloud sandbox, and the phone is just a screen.
agycodroid brings execution back to your own device: the cloud does model inference, while your code, files and toolchain stay local, the environment persists across sessions, and the agent can reach the device itself.

## Install

1. Download the APK from the latest successful [apk run](https://github.com/Zmin2003/agycodroid/actions/workflows/apk.yml): open the run, download the `agycodroid-test-<short-sha>` artifact (kept 30 days), and install `agycodroid.apk` from it. If Android says it isn't compatible and won't install it, use `agycodroid-36.apk` from the same artifact instead (targets SDK 36, same features; see "Updates and repair" in the in-app help for how the two differ). (Once the maintainer publishes a Release, the APKs will be there too.)
2. Open the app. The first launch automatically:
   - downloads the toolchain: you pick modules first; the base is required, and the command-line tools and C/C++ compilers are ticked by default, about 350 MB in total (all modules about 740 MB); resumable, sha256-verified, then unpacked;
   - downloads Antigravity CLI from Google's official manifest (about 176 MB for the 1.3.5 package; the size varies by release). The manifest is read live at install time — the version, download URL and sha512 are never hard-coded in the app.
3. Choose how to connect in Settings: a Gemini API key, or sign in with your Google account (see [Login](#login)).
4. (Optional) Install and start Shizuku, then grant it in Settings to enable `priv` and stronger keep-alive.

Requirements: Android 8.0+, arm64, about 4 GB free space.

**Allow background running on vendor ROMs**: some vendors' power savers ignore foreground services and freeze the whole app in the background
(measured on RedMagic: frozen about 90 s after leaving the foreground), stopping any running task. When agycodroid detects a freeze during a running task, Settings tells you exactly where to fix it.
RedMagic / ZTE: App info → App battery usage → Battery optimization → **Background running: Allow**, **Auto-start: Allow**.

**Offline install**: download `devkit-cc.agyroid.tar.gz` to the phone first, then on first launch choose "Choose a local file…" and pick it. Nothing else is downloaded, and the file is checked against the published releases before installing. (The toolchain file carries the fork's own `cc.agyroid` name: agycodroid publishes its own toolchain, rebuilt for `cc.agyroid`.)

Versions with a suffix (such as `v0.2.0-rc1`) are pre-releases. In-app updates only offer stable releases; to try a specific commit's build, download that run's Artifacts by hand.

### Upgrading from 1.0 to 1.0.1

- **Upgrade the toolchain first, then the APK.** 1.0.1 uses the fork's own toolchain (devkit-2026.11.19 onwards, target `cc.agyroid`); the 1.0 toolchain (target `cc.codroid`, upstream-signed) is refused at startup under 1.0.1 — the gateway reports a manifest mismatch and bash/curl in the terminal will not start. In 1.0, check for updates and install the new toolchain, then update the APK. Components and modules installed on the old toolchain do not carry over automatically; reinstall them from the extensions page afterwards.
- **First launch after upgrading downloads about 655 MB** (the gateway runtime, which 1.0 never wrote to disk) — unless the new toolchain is already installed, in which case the runtime is copied locally and nothing is downloaded. Keep about 1 GiB free before upgrading.
- **If the gateway does not come up, wait.** After a failed fetch the app does not retry the network for 30 minutes; restarting the app and going back in is the fastest way through. Do not reinstall repeatedly.
- **Updates only accept the new release certificate.** In-app updates reject packages signed by upstream (or from anywhere but the GitHub Release) and delete the downloaded file. Update only from the [GitHub Release](https://github.com/Zmin2003/agycodroid/releases).
- **Components** now come from the fork's own repository: [Zmin2003/agycodroid-components](https://github.com/Zmin2003/agycodroid-components). Until its first `components` Release is published, the extensions page cannot fetch the component list — see [docs/known-issues.md](docs/known-issues.md).

## Login

Two ways in, in Settings → provider card. The gateway checks the login state with a tiny headless probe (`agy -p "ping"`); it can tell you *whether* you are logged in, but not your email, plan or quota — the probe does not report them.

- **Gemini API Key** (simplest). Paste the key in Settings. It is stored in the app's private directory and is handed to `agy` only as the `GEMINI_API_KEY` environment variable of the `agy` child process at spawn time — that is the only way the CLI reads it (a `settings.json` entry alone does nothing, and `GOOGLE_API_KEY` is not accepted). Get a key at https://aistudio.google.com/apikey. In this mode the CLI needs `modelProvider: "gemini"` in its settings file; the gateway writes that for you.
- **Google account (OAuth)**. Tap "Log in with Google account". `agy` prints an authorization URL; open it in your system browser, sign in, and the CLI picks up the saved token. Headless runs then reuse the cached credentials, so authenticate once interactively first. The gateway never sees or stores your Google credentials; the one-time code, if the flow asks for one, is pasted into `agy`'s own prompt, never into an app field.

## Permissions — read this first

This is the biggest difference from Claude Code, and the hardest design problem in the port.

**`agy` in headless mode cannot ask you per tool call.** There is no approval pop-up mid-run: a tool that is not pre-approved is *soft-denied* — the run continues, exits `0`, and prints a notice to stderr naming the tool and how to allow it. Even reading a file can be refused this way. The app does not, and cannot, click "Allow" for you.

What agycodroid does instead:

- **Default: `request-review` + scoped pre-approval.** Before every run the gateway rewrites the CLI's settings file (`~/.gemini/antigravity-cli/settings.json`) with the permission mode and a scoped `permissions.allow` list built from your Settings (allowed tools, allowed directories). `deny` rules apply in every mode. The mode and the agent mode (`default` / `accept-edits` / `auto` / `plan`) are picked in Settings, under the input box, and per conversation.
- **No `--dangerously-skip-permissions` by default.** It exists in the CLI and auto-approves everything, including file writes and command execution. The app never turns it on for you; if you want it, you know what you are doing.
- **Pre-grant what you trust, keep the rest denied.** If a run is soft-denied, the notice tells you which rule to add; add it in Settings and run again. Scheduled tasks run unattended, so anything that needs approval is refused there — plan the allow-list before scheduling.

## Features

<p align="center"><img src="docs/assets/gallery.jpg" width="880" alt="Four phone screens: optional components, a new scheduled task, general settings with appearance and fonts, and the built-in help"></p>

- **Official Antigravity CLI with a GUI**: chat, streaming output, tool calls, file browser, session history.
  - One long-lived `agy` process per turn (`--input-format stream-json --output-format stream-json`); the next message resumes the same conversation by its `conversation_id`. Each reply shows a live generation timer that settles to the total time when it finishes.
  - Messages sent while Antigravity is working wait at the end of the chat marked *Queued*; **Send now** delivers one into the running turn without interrupting it. **Stop only stops** — queued messages are paused, never sent automatically.
  - **A quiet top bar**: the top right shows a single ⋯; tap it and Files, Terminal, Browser, Command palette and New session slide out, tap again to tuck them away. If the page ever stops scrolling, long-press the title in the top bar to rebuild it.
  - **Appearance and fonts**: three palettes (Native, Qiusuo and Zhuyue), light or dark or following the system (status bar included); the launch screen, first-run setup screen and in-app browser follow along. Fonts ship with the app, so the phone's system font doesn't change how it looks: Inter with Source Han Sans for the interface, and serif Spectral with Source Han Serif for replies by default. Settings lets you change the interface font, the response font (serif / sans) and the text size (small / medium / large). Code and the terminal use the CC Mono monospace font.
  - **Interface motion**: the sidebar, menus, pages and panels show where they come from and where they go, with a spring feel and matching exits; the sidebar follows your finger when you swipe it open or push it back. Only position and opacity animate, never streaming text or long lists, so older phones stay smooth. Reply text is released at an even pace, so it no longer lurches when a provider sends a big chunk at once. Settings → General → Interface motion: System / On / Off.
  - Your messages sit on the right and replies span the width, as in the desktop app. Tool calls between two pieces of reply text fold into one "N steps" line; tap to see each step. Groups with a failure open by themselves. Under each reply: **Copy** (the raw Markdown) and **Share** (system share sheet). Replies render Markdown with tables, task lists, LaTeX math and syntax-highlighted code blocks.
  - **Built-in help** (sidebar → More → Help): a full user guide and advanced tips, with a table of contents, in Chinese and English. Next to it, Release notes collects every version's notes and is searchable.
  - **Tablets in landscape and unfolded foldables**: depending on the window width, the layout becomes two columns (chat plus a workspace on the right) or three (plus a docked sidebar). Files, the viewer, the terminal and the in-app browser open on the right without covering the chat, and you can drag the divider between them. Phones in portrait and narrow split screens look the same as before. **Foldable layout (experimental)**: on foldables the columns line up with the fold, the input box moves below the fold when the device stands half-open, and a tri-fold gets one column per panel.
  - **Work survives the background**: you get a system notification when a turn finishes. It shows no heads-up banner. If the system kills the app, reopening it marks the unfinished turn as *Interrupted* with a *Continue* button, and queued messages are still there.
  - **Session management**: the Chats page in the sidebar searches message content and filters, and you can pin the chats you use most. Deleted sessions go to a recycle bin first (restorable for 30 days). Pick sessions one by one or all at once and export them as a zip — save it anywhere with the system *Save to* picker, or share it directly — then import the zip on another device and carry on where you left off. Sessions are stored by the gateway itself (`~/agyapp-sessions/`, one JSONL file per conversation); Antigravity's own on-disk transcript location is not relied on.
  - **Terminal** (top bar): a real terminal with tabs, running the same bash and toolchain Antigravity uses — hx (Helix), less, top, git and the rest. A row of extra keys supplies what phone keyboards lack (Esc, Tab, sticky Ctrl / Alt, arrows, Home / End, PgUp / PgDn, paste, font size); a text view lets you long-press to select and copy output. Terminals keep running when you close the panel and replay their output when you come back. In the terminal, `agy` works the way it does on a desktop: type `agy` to start an interactive session.
  - **File viewer / editor** (from the file browser): edit text and code and save — if the file changed on disk after you opened it (say Antigravity edited it), you are asked before anything is overwritten. Markdown renders with an edit toggle; images open fit-to-screen and tap to 1:1; PDFs render with [pdf.js](https://mozilla.github.io/pdf.js/) (CJK text and password-protected files included), pages drawn only as they scroll into view. Word and Excel files open directly; PowerPoint and legacy .doc files are converted to PDF once the LibreOffice component is installed. `.html` files show as live pages — CSS, JS and images they reference (in the same folder or a parent folder) load, and the page reloads when the file changes, so a browser game Antigravity wrote is playable with one tap. The top-right button is **Share**, which hands the file to the system share sheet.
  - **DevTools**: HTML previews and the in-app browser can open the bundled [Eruda](https://github.com/liriliri/eruda) — elements, console, network, storage — offline. With it on, **Pick element** puts the selector and a short HTML snippet of whatever you tap into the message box, so you can tell Antigravity what to change.
  - **Writing in Markdown**: while you edit, math and code blocks are typeset in place and show their source only when the cursor is on them; the word count keeps up as you type, and unsaved drafts are kept automatically. Manuscripts of millions of characters open and edit fine (up to 16 MB), with the preview laying out only what's near the screen, so scrolling stays smooth.
  - **Git panel** (from the file browser or the editor): see changes, history and line-by-line diffs, tick files and write a message to commit, and also discard changes, switch or create branches, pull and push.
  - **Switch right under the input box**: model, thinking effort and permission mode. On a new chat's start screen you can pick the project and model before you say anything. The model is a free-text slug (for example `gemini-3.8-flash-medium`); the app does not ship a model list, because Antigravity publishes no stable one — an unknown slug fails at run time with an error, it never silently falls back. Effort is low / medium / high / xhigh / max.
  - `/goal <condition>` keeps Antigravity going turn after turn until the condition is met, with checks and elapsed time shown above the input box.
  - **Rewind to here**: every message you sent can cut the chat back to that point in a new session and ask again (conversation fork). Undoing the *files* Antigravity changed since that point is **not** possible — Antigravity keeps no file checkpoints. Any reply can also be **forked** into a new session, leaving the original alone. When Antigravity works through a long job, its **task list** sits above the input box when it reports progress, and subagents get a card of their own: one row each with status and current step. Background commands are listed there too; when there are several they fold into one line you can open to see and stop each one.
  - **Lineage** (sidebar): forks, continuations and rewinds between sessions are drawn as a metro map (or an indented tree), so you can see where each session came from. Every session gets a file number automatically; tap a stop to jump straight to that chapter. Older sessions can be filed in one go, and a short tour explains how to read the map the first time you open it.
  - **Attachments**: the top row of the ＋ panel is Attach file, Take photo, Screenshot and Browse files. Take photo opens the system camera; the photo is scaled to 2048 px on the long side and turned upright before it's attached. Screenshots go through Shizuku; long-press Screenshot to take one in 5 seconds, giving you time to switch to the app you want. Sharing to agycodroid from another app attaches the file too.
  - A **↓ button** appears when you scroll up through a long chat; tap it to jump to the latest message. A dot on it means new output arrived meanwhile.
  - **Paths in replies are links**: tap an absolute path such as `/storage/emulated/0/…/report.pdf` (or `file.js:12`) and it opens in the viewer; a folder opens in the file browser. Tool cards that read or write a file get a ↗ button too.
  - **In-app browser** (globe in the top bar): web links in replies open inside the app — handy for checking a dev server at `http://127.0.0.1:<port>/`. On wide screens it opens in the workspace on the right, next to the chat. It uses the system WebView, so it adds no download. Sign-in pages still go to your normal browser.
  - UI in 10 languages: 简体中文, 繁體中文, English, Français, Español, Русский, العربية (RTL), 日本語, 한국어, Bahasa Indonesia (machine-translated draft; corrections welcome).
- **Projects and scheduled tasks**:
  - A project is a working directory plus its default provider, model, effort and permissions; sessions are grouped under projects by directory.
  - Scheduled tasks have Antigravity do something on a schedule — daily, weekly, monthly, every few hours, once, or a cron expression — woken on time by a system alarm. You can limit a task to read-only, to this project, or to chosen tools, and cap the duration of a run and the total per day. Nobody is watching while it runs, so anything that needs your approval is refused.
- **Usage**: the second half of the context line under the top bar shows the tokens used in the current session (input / output / thinking / cache-read / total, as reported by `agy`'s stream-json events). The Usage page records conversations, active days and models used, with a monthly report card to save or share; it counts usage only, never content. There is no quota display — Antigravity reports no quota — and no cost: `agy` reports no prices.
- **The toolchain installs by module** (Extensions → Toolkit modules): it is split into base, command-line tools, C/C++ compilers, Java and Android packaging, graphics libraries, audio/video, docs and data, Go and the Node.js ecosystem. You pick modules on first install and can add or remove them later. Each one lists its purpose, main commands, size, dependencies and which components use it; typing a command from a module you have not installed tells you where to find it.
- **Optional components** (Extensions → Optional components): large tools that don't ship with the app; download them only if you need them. Each build matches a specific toolchain release, is checked against its SHA-256 and a per-file manifest before anything is installed, and uninstalls cleanly.
  - **Browser component (headless Chromium 155)**, about 254 MB to download and 750 MB installed: lets Antigravity open pages headlessly — screenshots, PDF export, the rendered DOM, and scripted browsing with puppeteer-core.
  - **Community components** from the [agycodroid-components](https://github.com/Zmin2003/agycodroid-components) repository (the fork's own; the upstream components live in [cccodroid-components](https://github.com/greyoak111/cccodroid-components)). Dev: GitHub CLI (gh), Godot (headless runs, APK export), Graphviz / PlantUML diagrams, Hugo, reverse engineering (rizin, binwalk). Media: Blender (headless compositing and rendering, 3D on the GPU), LilyPond (music engraving), a music production toolchain. Office: LibreOffice, Pandoc, a PDF toolbox, OCR (Chinese and English), LaTeX (Tectonic, with Chinese support). AI: llama.cpp, OpenAI bridge (preview). 3D and science: OpenSCAD, GNU Octave, scientific Python (numpy / scipy / matplotlib). EDA: ngspice / gnucap, Icarus Verilog / Yosys. GPU: Snapdragon driver (Vulkan / OpenGL / OpenCL), Mali driver, GPU benchmarks. Net: Cloudflare (wrangler), rclone, QQ bots (native NapCat / SnowLuma, OneBot v11). See the [full list](https://github.com/Zmin2003/agycodroid-components#components). Indexes are ed25519-signed and rejected if they do not check out; community components are labelled as such, and builds nobody has verified on a real device ask first.
  - **Custom components**: import a Linux arm64 program the market doesn't have (a single binary or a .tar.gz / .zip). It works out whether the program is glibc, Android-native, static or a script, and pulls missing libraries from the Termux glibc repository; once installed it is one command that both Antigravity and the terminal can use. Where it comes from is your responsibility.
- **A complete development toolchain** (about 250 packages, taken from the official [Termux](https://termux.dev) repositories):
  - C/C++: clang 21 / lld, make / cmake / ninja, gdb / strace.
  - Languages: Python 3.14 (pip, venv), Node 26 (npm, npx).
  - Android builds: OpenJDK 21, aapt2 / d8 / apksigner — build APKs on the phone.
  - VCS and network: git, ssh, curl.
  - Audio and video: ffmpeg 9 (x264 / x265 / VP9 / AV1 / Opus…) with hardware encoding on the phone (`h264_mediacodec` / `hevc_mediacodec`), more than 3× faster than software encoding.
  - CLI tools: rg / fd / bat / jq / sqlite3 / typst / ImageMagick… Tab completion works in interactive bash; `hx-grammar` installs just the Helix syntax grammars you need; typst finds the system CJK fonts out of the box.
  - Anything missing: `pkg install` in the terminal installs it from the Termux repositories, and `pkg verified` lists the packages tested to work.
- **System privileges (optional)**: [Shizuku](https://shizuku.rikka.app) integration. In the terminal, `priv '<cmd>'` runs pm / am / settings / logcat / screencap… as the shell user.
  - One-tap install and activation from Settings: downloaded from Shizuku's official release (signing certificate verified), installed with the system installer,
    then activated over Wireless debugging — no computer needed. The pairing code is entered in a notification that stays at the top of the screen, so the pairing dialog stays open.
  - After a reboot, agycodroid turns Wireless debugging back on and re-activates Shizuku by itself (Wi‑Fi required).
- **Device tools (off by default)**: turn them on in Settings → Device tools and Antigravity can post notifications, read and write the clipboard, share files to other apps, open links or apps, and check battery and network; reading and tapping the screen uses accessibility and is a separate switch. Under the hood this is an MCP server that calls the system through Priv. Calendar, mail and the like are only pre-filled; you save or send them yourself.
- **Memory manager (off by default)**: before heavy jobs such as builds or renders, it stops background apps outside an allowlist through Shizuku, and stops them again if they come back while the job runs. The app you're looking at, split-screen apps and anything with a foreground notification are left alone. In the terminal, use `cc-mem run -- <command>`. How to read memory numbers and find the culprit: [docs/memory-management.md](docs/memory-management.md).
- **Work Island (ColorOS, off by default)**: with the community-built Work Island app installed, Antigravity working, waiting and finishing a task show up on the ColorOS 16 Fluid Cloud island. See [docs/work-island.md](docs/work-island.md).
- **Automatic updates** (on by default; can be turned off or triggered manually in Settings):
  - Antigravity CLI: silent updates from Google's official manifest (always the latest version the manifest points at; there are no stable / latest channels and no pinned-version installs of versions never installed — the manifest only ever names the current release). Running conversations are not affected. Each install is verified against the manifest's sha512 before the `current` link is switched, and the previous version is kept as a fallback.
  - agycodroid itself: downloaded, signature-checked, then offered for install; installed silently when idle if Shizuku is available. There are two APKs, targetSdk 28 and 36; updates follow the one you have installed, and you can switch in Settings (a system that only accepts 36 won't let you switch back to 28).
  - Toolchain: pre-downloaded on Wi‑Fi only and swapped in the next time the app opens; anything you installed with pip / npm -g is kept.
  - Updates never cut each other off: while the toolchain is downloading or being replaced, the app update waits. The replacement is checked against the release manifest before the old toolchain is touched, and if it is interrupted (app restart, process killed) the next launch finishes it or rolls back.
  - **Verify / Repair** in Settings checks every toolchain file against its recorded hash; Repair reinstalls the same version and keeps your own packages. A quick check also runs at each launch.
- **Extensions**: add, edit or remove MCP servers from the Extensions tab (long-press or double-tap an entry to edit it directly; tokens are never echoed, only their names). Everything goes through `agy mcp …`; a command that fails reports the CLI's own error. Claude Code plugins, skills and hooks are **not** supported — Antigravity CLI has no equivalent — and the Extensions tab says so instead of pretending otherwise.
- **Checked before anything runs**:
  - Antigravity CLI only runs if it matches the manifest copy saved at install time plus its own recorded sha512. The gateway uses its own copy of its runtime, checked against the app package before every start, so package upgrades and toolkit updates can't touch it.
  - Config handed to Antigravity (project instructions, rules, text in components, auto memory) is scanned for jailbreak patterns first. If something matches, that turn doesn't run and you're told which file and line. MCP servers are passed on as registered; their definitions aren't part of this scan.
  - Project config that would run on its own (hooks, MCP servers in project files) isn't loaded. Background programs left by an earlier conversation are shown to you before anything continues.
- **Troubleshooting**:
  - **Safe mode**: if a plugin, MCP server or project file breaks things, turn on safe mode and Antigravity starts with a minimal configuration — no customizations loaded, while sign-in, keys, sessions and model stay as they are. Nothing is moved or edited; turning it off restores everything.
  - **I'm stuck · bundle diagnostics** (in Settings, and on the install-failure screen): diagnostics, the app log, the gateway log and the repair ledger, packed into a zip and handed to the system share sheet. Before packing, you see a list of what goes in. Keys, tokens, email addresses and the content of your messages to Antigravity are scrubbed first, and conversation transcripts are not included.
  - **Plain-language first-install errors**: the app checks free space before downloading and tells you how much it needs. Failures such as being offline, rate limiting or a checksum mismatch are explained in plain words. *Retry* resumes from what was already downloaded.
  - **Repair ledger**: every toolchain install, verification, repair and startup recovery is recorded (what was found, what was done, the result) and can be read in Settings.
  - **Known issues**: problems not yet fully explained or ruled out, and what we know about each, are listed in [docs/known-issues.md](docs/known-issues.md).
  - **Permissions**: what each permission is for, when you're asked and what happens if you say no, in [docs/permissions.md](docs/permissions.md). Found a security problem? Report it privately as described in [SECURITY.md](SECURITY.md).
- **USB debugging of another device**: connect it with an OTG cable and run `usb-adb`, then `adb devices / install / shell` as usual.
- **Self-test**: `agycodroid-selftest` exercises more than 70 tools and usages (including ffmpeg and a hardware-encoding probe); the tool notes are injected into Antigravity's instructions so it knows what it has.

## What changed vs cccodroid

cccodroid runs Claude Code; agycodroid runs Antigravity CLI. The app shell, gateway, toolchain, components and most of the UI are the same code. What changed:

| Area | cccodroid (Claude Code) | agycodroid (Antigravity CLI) |
|---|---|---|
| Engine | `claude` (official linux-arm64 glibc build, started through the glibc loader + seccomp shim) | `agy` (official Android bionic build, runs directly — no loader, no shim, no DNS bridge) |
| Install | Official channel / npm mirrors, PGP + npm signatures | Google's official manifest only: read manifest → take url + sha512 → download → verify → unpack → land as `agy` |
| Chat protocol | Claude stream-json (`system` / `assistant` / `user` / `result` / `control_request` …) | agy stream-json: exactly three event types — `init`, `step_update`, `result` |
| Sessions | Read Claude's own `$HOME/.claude/projects/*.jsonl` | Gateway writes its own `~/agyapp-sessions/<project>/<conversation_id>.jsonl` (same record shape) |
| Resume | `--resume <sessionId>` | `--conversation <id>` / `-c` (by `conversation_id` from the stream) |
| Approval | Per-tool approval pop-up mid-run (`control_request` → UI dialog → `control_response`) | **None.** Headless `agy` soft-denies anything not pre-granted (see [Permissions](#permissions--read-this-first)) |
| Permission model | `--permission-mode` (default / acceptEdits / plan / auto / dontAsk / bypassPermissions) + PreToolUse guard hooks | `toolPermission` (`request-review` / `proceed-in-sandbox` / `always-proceed` / `strict`) + `agentMode` + scoped `permissions.allow` / `deny` in `~/.gemini/antigravity-cli/settings.json`, rewritten by the gateway before every run |
| Login | `claude auth login` (OAuth) or API key via `apiKeyHelper` | Google OAuth (authenticate once interactively, headless reuses the cached token) or Gemini API key via `GEMINI_API_KEY` |
| Providers | Claude account + Anthropic-compatible endpoints (DeepSeek, GLM, Qwen, Kimi, …) | Google (OAuth) and Gemini (API key) only |
| Models | Opus / Sonnet / Haiku / Fable + provider lists | Free-text slug (e.g. `gemini-3.8-flash-medium`); no shipped list; unknown slug errors at run time |
| Effort | Per-model effort levels | low / medium / high / xhigh / max (the CLI validates) |
| Commands | `/compact`, `/context`, `/cost`, `/model`, `/autocompact`, … | `/model`, `/models`, `/effort` only (gateway-local); everything else is plain text to `agy` |
| Skills / plugins / hooks | Full support (`~/.claude/skills`, plugin marketplaces, PreToolUse hooks) | **Dropped.** `agy` has no equivalent; the Extensions tab returns a clear "not supported" instead of failing silently |
| MCP | `claude mcp …` passthroughs | `agy mcp …` passthroughs (the subcommand's output format is parsed best-effort; MCP server config in `settings.json` is unconfirmed) |
| File rewind | File checkpoints: undo files changed since a message | **Dropped** (no checkpoints in `agy`). Conversation-only rewind (fork) still works |
| Compaction | `/compact` + idle compaction | **Dropped.** `agy` has no compaction; long sessions are resumed by `conversation_id` as-is |
| Usage / quota | Token meter + cost + provider quota (5-hour / weekly limits) | Token meter only (from stream events); no cost, no quota — `agy` reports neither |
| Local model | On-device llama.cpp chat | **Dropped** (the llama.cpp component itself is still installable; chat through it is not wired up) |
| Package name | `cc.codroid` (10 chars) | `cc.agyroid` (10 chars — the toolchain's same-length prefix relocation requires exactly 10; the app label stays `agycodroid`) |
| Devkit pin target | `cc.codroid` | `cc.agyroid` (the fork publishes its own toolchain, rebuilt with `--target cc.agyroid`) |

## Community and contributing

- **Questions and ideas**: open a GitHub issue, in English or Chinese.
- **Bugs**: in the app, tap Settings → Report on GitHub; your device and self-test results are filled in for you.

**Help is very welcome.** Device reports, translation fixes, component recipes, docs and code are all welcome, and you can help without writing code. See the [contributing guide](CONTRIBUTING.md).

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/cccodroid-architecture.en-dark.png">
  <img alt="agycodroid architecture: the user works in the UI (a WebView; the front end is 27 parts the gateway joins and serves), which talks over HTTP and SSE to the gateway on 127.0.0.2 (server.mjs plus feature modules in gw/, with token checks, per-request signatures and an event bus). The gateway runs on its own runtime in files/gw (Node and glibc), checked against hashes pinned in the APK. The gateway is started and restarted by the GatewayService foreground service, reads and writes sessions, settings and the token under home/, reaches Shizuku through the Priv relay over a private file socket, and drives the official, unmodified Antigravity CLI over stream-json, which is checked against the manifest copy saved at install time plus its own sha512. Before each run, the config check scans the config handed to Antigravity for jailbreak patterns and passes on only what it has checked. Antigravity calls the Google APIs over HTTPS (a Google account or a Gemini API key, chosen per conversation) and the devkit toolchain (a base plus optional modules) through its tools. In the targetSdk 36 build, the loader shipped in the APK (libldlinux.so) and an exec shim rewrite how programs are started. The device tools MCP is an MCP server for Antigravity that goes through Priv over a local socket. Updater / Installer download from GitHub and official channels, and manage the 28/36 APKs, toolkit modules and Antigravity CLI. Components fetch an ed25519-signed index and packages from the component market and install them into devkit (their Claude skills have no Antigravity equivalent and are not installed)." src="docs/diagrams/cccodroid-architecture.en-light.png">
</picture>

Interactive version (guided views, light/dark, export): download [`docs/diagrams/agycodroid-architecture.en.html`](docs/diagrams/agycodroid-architecture.en.html) and open it in a browser;
the source is `agycodroid-architecture.en.json` in the same directory, with every component tied to the source lines it describes. Generated with [Archify](https://github.com/tt-a1i/archify).

## How it works

```
agycodroid.apk (Java shell: installer + foreground service + WebView)
  ├─ files/usr/      toolchain: official Termux packages, run natively after same-length prefix relocation
  ├─ official Antigravity CLI (android-arm64 bionic build, unmodified binary)
  │     └─ runs directly through /system/bin/linker64 — no glibc loader, no seccomp shim
  ├─ lib/arm64-v8a/libldlinux.so   the glibc loader for the gateway's own Node runtime; the 36 build starts glibc programs through it
  ├─ files/gw/       the gateway's own runtime (Node, glibc and so on), checked against the app package before every start
  └─ gateway gateway/server.mjs + gw/ (Node): runs agy, event stream, queue, provider config → UI gateway/web/
```

- **Same-length prefix relocation**: Termux binaries have `/data/data/com.termux/` baked in at build time. The package name `cc.agyroid` has exactly the same 10 characters as `com.termux`, so a byte-for-byte replacement fixes every RUNPATH, shebang and config path — no `LD_LIBRARY_PATH`, wrapper scripts or binary patching. Entries inside zip / jmod archives are rewritten too. See [devkit/README.md](devkit/README.md). This is why the package name is `cc.agyroid` and not `cc.agycodroid` (11 characters would break the relocation).
- **targetSdk 36**: since Android 10, apps targeting SDK 29 or later can't execute files in their own data directory. The regular APK still targets 28. The 36 build puts the glibc loader in the APK's native library directory, which the system does allow, starts bionic programs through `/system/bin/linker64`, and an exec shim ([`exec-shim.c`](android/native/exec-shim.c)) rewrites every program launch into one of those two forms. Both APKs have the same features; every component has been run on a real device with the 36 build. `agy` itself is a bionic binary, so it runs through the system linker in both builds.
- **Gateway access control**: the gateway listens on two loopback addresses: 127.0.0.2, dedicated to the UI, and 127.0.0.1 for local tools. Every `/api/*` request must carry a 256-bit token from the app private directory, and Host and Origin are checked. The session cookie is honored only on requests that arrive at 127.0.0.2, and the built-in browser blocks that address, so the cookie never reaches other services on the device. The app itself never sends the raw token: each request is signed once (an HMAC over a timestamp, a single-use nonce, the boot ID, the listening address, the method and the body hash), so a captured request cannot be replayed. Before handing over any credentials, the app also challenges the gateway to answer an HMAC keyed with the token, proving that whatever answers on the port is the real gateway. Other apps and web pages on the device cannot drive it.
- **Credentials**: Google sign-in is done by `agy` itself. The gateway hands the authorization URL to the system browser and never reads or stores Google credentials; it does not handle the one-time authorization code either (see [Terms and compliance](#terms-and-compliance)). A Gemini API key lives in the app's private directory and reaches `agy` only through the `GEMINI_API_KEY` environment variable of the `agy` child process — that is the only channel the CLI reads it from, and the key is never written to a file `agy` would read, never logged, and never sent anywhere else.

## Engineering history

From the first commit to v0.7.0 took 33 days: 1,106 commits and 146 releases. The table groups the work by engineering phase; every row can be traced in the commit history and on the [Releases](https://github.com/greyoak111/cccodroid/releases) page. The agycodroid fork starts from cccodroid v0.7.9 (commit `fb2caea`).

| Phase | Versions | Key engineering |
|---|---|---|
| Prototype | before the repo | Proven inside [DeepSeek Harness](https://github.com/woaiys3/deepseek-harness-android-app): the official linux-arm64 Claude Code launched directly by the glibc loader, with a bionic-side local reverse proxy because glibc couldn't resolve DNS; a Java + WebView shell with a Node gateway; claude processes owned by the gateway and streamed to the UI over an SSE event bus |
| Skeleton | 0.1.0 – 0.1.2 | Foreground-service keep-alive; toolchain assembled from official Termux packages and run natively after same-length prefix relocation; official package download and verification; seccomp SIGSYS turned into ENOSYS (plus `enosys-run` for static binaries); Shizuku privileged commands through an in-app socket; gateway token plus Host / Origin checks |
| Distribution and ecosystem | 0.1.3 – 0.3.0 | Update chain: hash-based versioning, resumable replacement, MANIFEST verification and repair; component market: recipe → CI → ed25519-signed index → on-device verification marks; parallel sessions; `enosys-run -f` covering the whole process tree; i18n across shell and gateway; multi-source Claude Code downloads where mirrored packages must still pass the official manifest, PGP and npm signature checks; CI builds for every PR |
| Restructuring | 0.3.4 – 0.4.0 | Gateway split into a routing layer plus feature modules under `gw/`; front end split into parts under `web/app/` that the gateway joins and serves; toolkit installed and removed per module, with signed module manifests; active reconciliation of records against disk; per-session model and provider, so sessions pinned to different providers run in parallel; targetSdk 36: exec through linker64 and an ld.so shipped in the APK, with an exec shim, shipped as twin 28 / 36 APKs; scheduled tasks woken by system alarms |
| Experience and original features | 0.4.1 – 0.5.0 | Segmented parallel downloads with fallback routes; `gw/streamfix.mjs` adds the missing end-of-stream events to third-party streaming replies so whole answers aren't regenerated; gateway tests wired into CI and the release gate; Lineage: a session ancestry graph with archive IDs and windowed lazy loading; one motion system for every enter and exit; subagent cards and a contact log; UI settings consolidated into `ccapp-ui.json`; releases reduced to one pipeline (build → verify → publish → site link check) |
| Hardening | 0.5.1 – 0.5.19 | More than ten rounds of external review: atomic writes, an environment-variable deny-list, every manifest signed and bound to its release against replay; the UI moved to a dedicated loopback address, 127.0.0.2, with per-request HMAC signatures to the gateway instead of the raw token; a PreToolUse hook that asks again before sensitive actions; integrity seals on prompts and session logs; PR poisoning screening, with the release signing key released only to main; an allow-list for privileged commands, with a native confirmation for everything outside it |
| Review and defense in depth | 0.5.20 – 0.6.7 | Release-by-release community review (0.6.0 alone handled more than 80 findings) plus red-team testing by community members; switches that change how the host behaves (keep-alive boost, no per-command confirmation for privileged commands, device tools) only take effect after the system lock-screen check, and activating Shizuku needs a tap on a native dialog; project hooks and MCP servers that would run on their own are asked about first; UI and gateway files are checked against the app package at startup and while running; Claude Code is allowed to run only against Anthropic's signed manifest, and the gateway runs on its own runtime; config handed to Claude Code is scanned for jailbreak patterns |
| Hardening and everyday features | 0.6.8 – 0.6.13 | Repeated hardening of jailbreak-pattern scanning: split characters, homoglyphs and layered encodings are normalized before scanning; hook-injected text and project config are screened too, and a jailbreak-resistance ruleset ships with the app; 0.6.10 fixed more than a hundred findings from a full audit — release sealing, Git trusting only registered project directories, internal action tokens derived from the system keystore; sessions became permanent, with a storage page and scheduled cleanup; the file manager browses, extracts and creates archives, with 7-Zip bundled; one-tap reset to initial settings; APKs in the file manager can be installed directly |
| Endpoints and stability | 0.6.14 – 0.6.19 | The local protocol bridge manages multiple APIs; custom endpoints discover model lists automatically, default to a 90-second timeout with 3 retries, and accept Chinese and bracketed model names; the context compression line falls back correctly when the window is unknown; 0.6.17 was a stability pass with more than seventy fixes, and the component market gained an MCP category and 14 components; foldable-screen and gesture-bar layout; 0.6.18 concentrated on long-text overflow; 0.6.19 completed the preset model lists |
| Slimmer rules and endpoint example | 0.6.20 | The anti-jailbreak block went from 4,625 to 706 characters, dropping the three-axis classification, allow-list, three-pass review and self-test tables; restored incapacitation, post-incident disposal and lethal parameters, anti-debugging/anti-anti-debugging/AV evasion and the "any one of" wording for implant toolchains, and own assets no longer exempt cracking, unpacking or anti-detection products; claimed roles, fiction wrappers, encoding, other languages, fragments and multi-turn requests no longer change the judgment; crisis requests get help channels only; third-party endpoints gained an example template and risk note, and the README became neutral |
| The promised release | 0.7.0 | Automatic titles follow the interface language (#211); the static fallback title in the top bar is now cccodroid; the version promised in the 0.6.20 farewell letter |
| **agycodroid fork** | **0.7.9 →** | **Claude Code replaced by Google Antigravity CLI end to end**: manifest-based installer (no PGP / npm, sha512 only), agy stream-json protocol (`init` / `step_update` / `result`), gateway-written sessions, `toolPermission` + scoped `permissions.allow` instead of per-tool approval pop-ups, Gemini API key / Google OAuth login, skills / plugins / hooks / compaction / file rewind dropped with the reasons written down, package renamed to `cc.agyroid` (still 10 characters) |

Rules the project has held to throughout:

- **Launch the official package, never modify it.** Antigravity CLI comes from Google's official manifest only. The APK never bundles it.
- **No root, no proot.** The toolchain runs natively. Platform limits are handled with prefix relocation, and privileged actions go only through Shizuku.
- **The gateway owns runs.** The UI only subscribes to events, so a page reload, going to the background or parallel sessions never interrupt a turn in progress.
- **Verify before trusting.** Toolkits, modules, component indexes, notices and release lists are checked against ed25519 or PGP signatures bound to a specific release; `agy` itself is checked against the sha512 in Google's official manifest.
- **Every change gets verified.** Gateway tests run only through the runner, every release and toolkit publish step checks hashes, and components state whether they have been verified on a real device.

## Terms and compliance

agycodroid runs Google's Antigravity CLI. Google's own terms for the CLI apply to your use of it; the summary below is what the app does, so you can judge for yourself:

- **How the binary runs.** The Antigravity CLI file is byte-for-byte Google's official android-arm64 build: checked against the sha512 in the official manifest and never patched. It is a bionic binary, so it runs directly through Android's system linker — no loader, no seccomp shim, no patching of any kind.
- **Signing in with a Google account.** Sign-in is `agy`'s own OAuth flow. You authorize on Google's page in your browser, `agy` writes the token to its own credential store (the app never reads that file), and while signed in `agy` talks to Google's APIs directly, not through any process of ours. In practice this is the same as SSHing into a Linux machine you own, running the CLI there and signing in: here the Linux machine is the phone, and the app is the screen and keyboard. Every turn starts with you: either a message you send, or a scheduled task you set up yourself. Scheduled tasks run on your own phone, under your own account, with the same unmodified CLI; since nobody is watching, anything that needs approval is refused — the app never approves a tool call for you.
- **The one-time authorization code.** Normally the browser hands the code back to `agy` automatically, on this device, without passing through the app. If that fails, the app opens its built-in terminal and runs `agy` there; you paste the code into `agy`'s own prompt. The terminal is a generic byte channel, like Termux or SSH; the app has no field that accepts the code and never parses, saves or logs it.
- **Permission prompts.** Unlike the official CLI in a terminal, the headless mode the app drives cannot ask you per tool call. Tools are pre-approved by scoped rules you set in Settings (see [Permissions](#permissions--read-this-first)); anything not pre-approved is soft-denied and the run goes on without it. The default is the restrictive end: `request-review` with a small allow-list.
- **The name.** agycodroid stands for "Antigravity CLI On droid". The project does not use Google's or Antigravity's names or logos in its name, icon or package name beyond the descriptive "agy" in the package identifier, and does not claim to be made, endorsed or partnered with by Google. If Google asks, the project will be renamed.
- **No resale, no middleman.** agycodroid is free and open source, has no server, and does not provide, pay for or resell any Antigravity usage: you sign in with your own account or bring your own API key, and usage is billed to you directly.

### What this project does not do

agycodroid is free and open source, has no server, and does not provide, pay for or resell any Antigravity usage: you sign in with your own account or bring your own API key, and usage is billed to you directly.

- **No shared or resold accounts.** Splitting one subscription among multiple people, or repackaging subscription usage as an API for sale, is not supported; we don't build features for it or accept PRs that add it, and the component market does not accept such components.
- **No jailbreaking.** Getting around a model's safety limits to extract harmful content it would otherwise refuse is not supported.
- **No mass-controlled accounts.** Using agents to register, farm or run accounts in bulk to flood comment sections while passing as real people is not supported.

We don't police other people's choices. But this project does not provide shared/resale features, and does not help troubleshoot those uses.

## Build

```sh
sh scripts/build.sh                 # javac → d8 → aapt2 → sign, produces dist/agycodroid.apk (targetSdk 28)
TARGET_SDK=36 sh scripts/build.sh   # the 36 build; scripts/ship.mjs builds both for a release
node devkit/devkit.mjs build --target cc.agyroid   # build the toolchain (CI can do this too; the fork publishes its own toolchain, rebuilt for cc.agyroid)
```

**No setup needed**: GitHub Actions builds an APK for every pull request and every push to main; download it from that run's Artifacts (see [.github/workflows/apk.yml](.github/workflows/apk.yml)). Builds from this fork are signed with a throwaway test key until the maintainer provides a release keystore, so you have to uninstall the released app first; a spare device is best. The fingerprint check in CI only runs when the official release key is present. Release signing: to make main-branch builds sign with the release key instead of a throwaway test key, put the key JSON (`{"key": PEM private key, "cert": PEM certificate}`, base64) in the `AGYCODROID_RELEASE_KEY` secret of the `apk-release` environment; the fingerprint check then verifies each APK was signed with that key.

To build on your own machine, install JDK 17, Node.js, the Android SDK (build-tools and a platform) and the NDK, then set the environment variables described at the top of `build.sh`. `apk.yml` is a working example. The script's default tool paths point at the author's Android tablet.

The toolchain is built and published by GitHub Actions: push a tag like `devkit-YYYY.MM.DD` (see [.github/workflows/devkit.yml](.github/workflows/devkit.yml)).
Which toolchain version the app downloads is set in [devkit-sources.txt](devkit-sources.txt). The size and SHA-256 of that version live in [devkit-pin.json](devkit-pin.json), which ships inside the APK: the first install (from GitHub or a local file) and the check on local files both trust it rather than the download source. It also pins the SHA-256 of the lock file `devkit.lock.json` itself, which `build.sh` checks before extracting the glibc loader instead of relying on HTTPS alone. When you switch versions, edit the former, run `node scripts/pin-devkit.mjs "$(head -1 devkit-sources.txt)" devkit-pin.json`, and commit both; `build.sh` checks that they match.

Layout:

| Directory | Contents |
|---|---|
| `android/` | Java shell, Manifest, resources, terminal helpers (`assets/bin/`), native libraries (`native/`), the original glibc loader shipped in the APK (`prebuilt/glibc/`) |
| `gateway/` | Gateway (`server.mjs` + feature modules in `gw/`, Node.js) and UI (`web/`, plain JS, no build step) |
| `i18n/` | UI translations: one txt per language plus the generate and check scripts, see [i18n/README.md](i18n/README.md) |
| `devkit/` | Toolchain build script and manifests |
| `docs/design-philosophy.md` | Why the project exists and the principles behind it |
| `docs/large-screen.md` | Large-screen layout (tablets, foldables) and where its code lives |
| `docs/known-issues.md` | Known issues and unresolved risks, plus test actions that create fake bugs |
| `docs/download-sources.md` | Every download chain: sources, trust anchors, server mirrors, how to check and maintain them |
| `docs/memory-management.md` | Reading memory numbers, finding the process that eats memory, and how the memory manager works |
| `docs/work-island.md` | The Work Island (ColorOS) integration: parts, turning it on and off, design notes and known limits |
| `docs/permissions.md` | What each permission is for, when you're asked, what happens if you refuse, and the risks of the three heavy ones |
| `docs/agy-versions.md` | On-device verification of new Antigravity CLI releases, the local verified record, and how auto-update uses the manifest |
| `docs/diagrams/` | Architecture diagrams (Archify JSON specs → interactive HTML → light / dark PNG) |
| `third_party/` | Shizuku-API 13.1.5 (MIT, unmodified from Maven Central) |

## Special thanks

- **[cccodroid](https://github.com/greyoak111/cccodroid)** (greyoak111): this whole app is their work — agycodroid is a fork that swaps the engine. Upstream's thanks below are inherited unchanged.
- **[DeepSeek Harness for Android](https://github.com/woaiys3/deepseek-harness-android-app)** (woaiys3): running AI agents on a phone without root, elevating through Shizuku, keeping alive with a foreground service — it walked these paths first. cccodroid's early exploration and development happened inside the environment it built; that Claude Code runs on Android the way it does today rests on the foundation laid by it and its author.
- **[Archify](https://github.com/tt-a1i/archify)** (tt-a1i, MIT): the architecture diagram above was made with it and passed its layout checks; license in [ThirdPartyLicenses/Archify](ThirdPartyLicenses/Archify/LICENSE).
- **[Eruda](https://github.com/liriliri/eruda)** (liriliri, MIT): the developer tools in previews and the browser pane; license in [ThirdPartyLicenses/eruda](ThirdPartyLicenses/eruda/LICENSE).
- **[Termux](https://termux.dev)**: the toolchain is assembled from its official packages.
- **[Shizuku](https://shizuku.rikka.app)** (RikkaApps): system privileges without root.
- **[OpenCC](https://github.com/BYVoid/OpenCC)** / [opencc-js](https://github.com/nk2028/opencc-js): the Traditional Chinese UI strings were converted with it, then reviewed by hand.

### Community contributors

Inherited from cccodroid — the people below built the app this fork stands on:

- **[bmbmm-114514](https://github.com/bmbmm-114514)**: a careful code review that reported ten security and stability problems, each with reproduction steps and code locations; all fixed in 0.3.2.
- **[IVESHOWARD](https://github.com/IVESHOWARD)**: reported the skill archive import problems (only one of several skills imported, archives sometimes not recognised); fixed in 0.3.2.
- **[CCB-Fox](https://github.com/CCB-Fox)**: the Dimensity GPU driver component ([cccodroid-components#46](https://github.com/greyoak111/cccodroid-components/pull/46)), which led to Mali support in 0.3.3.
- **[Cosmosophius](https://github.com/Cosmosophius)**: a thorough Dimensity 9300 report ([cccodroid-components#47](https://github.com/greyoak111/cccodroid-components/issues/47)).
- **[gogoiPhone](https://github.com/gogoiPhone)**: a Redmi K70 Ultra device report with their own Vulkan compute test ([#14](https://github.com/greyoak111/cccodroid/issues/14)).
- **[Slingerspir](https://github.com/Slingerspir)**: suggested a GitHub acceleration route and multi-threaded downloads; 0.4.1 added segmented parallel downloads and a gh-proxy fallback.
- **[hye45402-pixel](https://github.com/hye45402-pixel)**: asked for LaTeX, syntax highlighting, code-block language labels, strikethrough, bold italic and task lists; all added in 0.4.4.
- **[STUTTEFRFIX](https://github.com/STUTTEFRFIX)**: the Work Island integration, which shows Claude's working status on the ColorOS 16 Fluid Cloud island ([#20](https://github.com/greyoak111/cccodroid/pull/20), [#21](https://github.com/greyoak111/cccodroid/pull/21)), with the companion app [WorkIsland-Android](https://github.com/STUTTEFRFIX/WorkIsland-Android). The first outside pull request merged into cccodroid; shipped in 0.4.7.
- **[ThinkReally114](https://github.com/ThinkReally114)**: feedback and bug reports throughout 0.3.x.
- **[wangxp12](https://github.com/wangxp12)**: feedback and bug reports throughout 0.3.x.
- **[unoyg](https://github.com/unoyg)**: feedback and bug reports throughout 0.3.x.
- **[fisHarly0](https://github.com/fisHarly0)**: suggestions and bug reports during 0.3.x.
- **[chenshi723](https://github.com/chenshi723)**: front-end suggestions during 0.4.x. The whole interface motion system in 0.4.11 started from their remark that the app's motion felt bare; they then pointed out the sidebar's leftover animation when closing, the new-chat greeting rendering twice, choppy streaming, the DeepSeek balance showing 0 and fonts not fully following the system — fixed across 0.4.11–0.4.12. The OpenAI bridge configuration panel and safe uninstall in 0.5.15 came from their PR ([#58](https://github.com/greyoak111/cccodroid/pull/58)), and they maintain the [cccodroid-openai-bridge](https://github.com/chenshi723/cccodroid-openai-bridge) component. From 0.5.20 on they have reviewed every release in depth (more than 80 findings for 0.6.0, twelve reports for 0.6.4), and they tracked down why background programs kept asking for confirmation after "Keep" ([#167](https://github.com/greyoak111/cccodroid/issues/167), fixed in 0.6.7).
- **[leemwood](https://github.com/leemwood)**: pointed out that the web preview lacked element picking, which led to the DevTools and "pick an element for Claude" in 0.4.14.
- **[hwsyyds666](https://github.com/hwsyyds666)**: device report for the OnePlus Ace 5 on ColorOS 16 ([#61](https://github.com/greyoak111/cccodroid/issues/61)).
- **[zx-5426](https://github.com/zx-5426)**, **[1fshi26](https://github.com/1fshi26)** and **[FatBrother1](https://github.com/FatBrother1)**: the core of the red team, and a big part of the 0.6.x security work.
  - zx-5426's red-team material let the 0.6.7 jailbreak check catch several kinds of wording written specifically to dodge detection. They also contributed 21 fix commits (segmented download writes, the stream fix, concurrent thumbnails, scheduled tasks, a stuck queue, ledger robustness and more), merged across 0.6.4–0.6.7.
  - 1fshi26's jailbreak research notes went into the 0.6.2 hardening: hooks and MCP servers in a project that would run on their own now ask you before loading.
  - FatBrother1 takes part in red-team testing.

Reports, device testing and code review are contributions too, and they're recorded here.

## License

agycodroid itself is released under the [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)).

### Third-party components

- **Antigravity CLI**: proprietary software by Google, **not distributed with this project**. Its use is subject to Google's terms for the Antigravity CLI.
- **cccodroid**: the upstream project this fork is based on, Apache-2.0, by greyoak111 and contributors — see the [upstream repository](https://github.com/greyoak111/cccodroid).
- **Toolchain**: taken from the official Termux repositories; each component is distributed under its own license (including GPL). Versions, hashes and build recipes are in the `devkit.lock.json` / `SBOM.tsv` attached to each release. If you need a copy of the source, ask in Issues.
- **glibc dynamic loader** (`lib/arm64-v8a/libldlinux.so`, shipped in the APK): from Termux's glibc package, LGPL-2.1-or-later. See [android/prebuilt/glibc](android/prebuilt/glibc/README.md).
- **Shizuku-API**: MIT, see [third_party/shizuku/LICENSE](third_party/shizuku/LICENSE).
- **xz-decompress** (used at toolchain build time): MIT.
- **[xterm.js](https://xtermjs.org)** (terminal): MIT, see [ThirdPartyLicenses/xterm.js](ThirdPartyLicenses/xterm.js/LICENSE).
- **[highlight.js](https://highlightjs.org)** (code highlighting in chat): BSD-3-Clause, see [ThirdPartyLicenses/highlight.js](ThirdPartyLicenses/highlight.js/LICENSE).
- **[KaTeX](https://katex.org)** (math in chat): MIT, see [ThirdPartyLicenses/KaTeX](ThirdPartyLicenses/KaTeX/LICENSE).
- **[pdf.js](https://mozilla.github.io/pdf.js/)** (PDF viewer): Apache-2.0; its bundled OpenJPEG / JBIG2 / QCMS decoders carry their own licenses. See [ThirdPartyLicenses/pdf.js](ThirdPartyLicenses/pdf.js/).
- **CC Mono** (monospace font for the UI and terminal): a subset of [Monaspace Neon](https://github.com/githubnext/monaspace) by GitHub, SIL OFL 1.1, renamed as the Reserved Font Name clause requires. See [ThirdPartyLicenses/ccmono](ThirdPartyLicenses/ccmono/LICENSE).
- **`android.jar`** is not shipped (its license forbids redistribution); download it yourself if you want to compile APKs on the phone.
