# Permissions

English | [中文](permissions.zh-CN.md)

agycodroid asks for a fair number of permissions. This page explains what each one is for, when you're asked, and what happens if you say no.

The most important point first: **inside agycodroid, Antigravity can run any command as this app.** That's what the app is for. Whatever the app is allowed to do, the commands Antigravity runs can do too. Keep that in mind when deciding what to grant. The next section is the gate *inside* that: which of Antigravity's own tool calls need your approval first.

## At a glance

| Permission | What it's for | When you're asked | If you say no |
|---|---|---|---|
| Network (`INTERNET`, `ACCESS_NETWORK_STATE`) | Talking to the model API, downloading Antigravity CLI and the toolkit; checking whether you're on Wi-Fi (the scheduled-task "Wi-Fi only" condition) | Never; granted on install | The app can't work |
| Storage (`READ/WRITE_EXTERNAL_STORAGE`; the targetSdk 36 build also needs "All files access", `MANAGE_EXTERNAL_STORAGE`) | Reading and writing `/sdcard/agycodroid`: APKs handed to other apps, screenshots, offline toolkits; also lets Antigravity work on files you keep in shared storage | The 28 build asks on first launch; the 36 build asks once and takes you to system settings | Works, but output stays in the app's private folder where other apps can't see it |
| Notifications (`POST_NOTIFICATIONS`) | Telling you a background run finished, scheduled-task results, actions waiting for approval | First launch | Works, but no alerts while the app is in the background |
| Lock-screen check (`USE_BIOMETRIC`) | Confirming a protected switch with your screen lock before it's saved for the next launch (background keep-alive, device tools, privileged-command bypass, web debugging) | When you turn on a protected switch (a lock-screen confirmation, not a permission prompt) | The switch still works for this run, but is forgotten when you restart the app |
| Foreground service, wake lock (`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `WAKE_LOCK`) | Keeping the gateway alive so a run finishes after you switch away or lock the screen | Never | Can't be refused; without it the network drops a few seconds after leaving the app |
| Ignore battery optimizations (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) | Stopping power saving from freezing long background jobs | When you tap "Background running" in settings | Long jobs and scheduled tasks may be stopped after the screen locks |
| Exact alarms, boot broadcast (`SCHEDULE_EXACT_ALARM`, `RECEIVE_BOOT_COMPLETED`) | Waking the gateway for scheduled tasks; re-activating Shizuku after a reboot (only if you have paired and turned auto-activation on in settings; it's off by default) | Never | Scheduled tasks may run a little late; Shizuku needs manual activation after reboot |
| Install apps (`REQUEST_INSTALL_PACKAGES`) | In-app updates; installing APKs Antigravity built on the device | The first time, the system asks you to allow it in settings | You update by downloading the APK yourself |
| Set alarm (`SET_ALARM`) | The device tool "set an alarm for me", handed to the system clock app | Never | The device tool can't set alarms |
| Full-screen notification (`USE_FULL_SCREEN_INTENT`) | Keeping the Shizuku pairing notification (with its input box) pinned at the top of the screen | Never | The pairing notification may collapse; pull down the shade to find it |
| Shizuku (`moe.shizuku.manager.permission.API_V23`) | Optional. Gets the shell identity (uid 2000) for installs without prompts, granting itself all-files access, and device tools | When you turn it on in settings | Those features don't work; everything else does |
| Write secure settings (`WRITE_SECURE_SETTINGS`) | Only grantable through Shizuku. Used to turn wireless debugging back on after a reboot and re-activate Shizuku, and to switch agycodroid's own accessibility service on and off as needed | Granted along with Shizuku | Shizuku needs manual activation after each reboot; accessibility must be turned on in system settings |

## Antigravity's own permissions: what the agent may do without asking

The Android permissions above decide what the *app* can reach. Inside the app, a second gate decides what *Antigravity* may do without asking you: its permission engine. Every sensitive operation is a resource written as `action(target)`, checked against three lists in agy's `settings.json` (`permissions.allow`, `permissions.ask`, `permissions.deny`; on a desktop the file is `~/.gemini/antigravity-cli/settings.json`, on the phone it lives under agycodroid's home directory):

- **deny**: blocked immediately, in every mode.
- **ask**: pauses for your approval before proceeding.
- **allow**: runs without prompting.

Precedence is strict: **deny beats ask beats allow**. An ask rule still prompts under `always-proceed`; a deny rule still blocks under every preset and under `--dangerously-skip-permissions`.

### The rules

| Action | Target | Default |
|---|---|---|
| `read_file` | `read_file(/path)`, `read_file(dir)`, `read_file(*)` | Ask (allowed in the workspace) |
| `write_file` | `write_file(/path)`, `write_file(*)` | Ask (allowed in the workspace) |
| `read_url` | `read_url(domain)`, `read_url(*)` | Ask |
| `execute_url` | `execute_url(domain)`, `execute_url(*)` | Ask |
| `download_url` | `download_url(domain)`, `download_url(*)` | Ask |
| `command` | `command(prefix)`, `command(regex:pattern)`, `command(*)` | Ask (allowed inside the terminal sandbox under the Default and Auto presets) |
| `mcp` | `mcp(server/tool)`, `mcp(server/*)`, `mcp(*)` | Ask |

Matching notes: `command(...)` matches by word/token prefix; a `regex:` target matches the whole line. Shell tricks that can hide another command behind a benign prefix — `$(...)`, backticks, `{a,b}`, redirections — turn prefix matching off for that line: it runs unprompted only on a character-for-character rule match, otherwise it asks. `write_file` on a path also grants `read_file` there; denying `read_file` also denies `write_file` there.

Example rules (under `permissions` in `settings.json`):

```json
{
  "permissions": {
    "allow": ["command(git)", "command(npm test)", "write_file(src/)"],
    "ask": ["command(git push)"],
    "deny": ["command(rm -rf)", "command(sudo)", "write_file(.git/)"]
  }
}
```

### toolPermission: four levels

| `toolPermission` | Behaviour |
|---|---|
| `request-review` (default) | Prompts for write, terminal, web and MCP tools unless an allow rule covers them |
| `proceed-in-sandbox` | Runs terminal commands without prompting when the sandbox is on and the command runs inside it; asks outside the sandbox |
| `always-proceed` | Runs commands, web requests and MCP tools without prompting unless an ask or deny rule matches |
| `strict` | Prompts before every tool action, including file reads, even if an allow rule matches |

Set it in `settings.json`, or for one interactive session with `/config`. `--dangerously-skip-permissions` switches a single run to `always-proceed` (see below).

### agentMode: who approves file edits

| `agentMode` | File edits | Terminal commands |
|---|---|---|
| `default` | Shows a diff and waits for you | Asks first (per `toolPermission`) |
| `accept-edits` | Applied automatically inside the workspace | Asks first (per `toolPermission`) |
| `auto` | Applied automatically | Run in the sandbox; outside it, safe reversible commands run and risky ones ask |
| `plan` | None until you approve a plan | Reads and proposes first |

Set it with `--mode=<mode>` for one run, or `"agentMode"` in `settings.json` for the default. `Shift+Tab` cycles the modes in an interactive session.

### Headless: an ask nobody can answer is a soft deny

agycodroid runs agy headless (`-p`): there is nobody to answer a prompt mid-run. When a tool call needs approval and no one can give it, agy **soft-denies** it — the run continues, and a notice on stderr names the tool and the allow rule you would have needed to pre-grant it. It does not hang, and it does not silently approve. So anything an unattended run must be able to do has to be in `permissions.allow` beforehand; a broad `ask` list turns into a block list for headless runs.

### `--dangerously-skip-permissions` is an escape hatch, not a default

The flag auto-approves all tool permission requests for that one invocation — the equivalent of `always-proceed` for a single run. agycodroid does **not** pass it by default. Use it only for a single run you have already scoped (for example inside a sandbox), and prefer narrow `permissions.allow` rules instead: they unblock the exact tools a headless run needs while deny rules keep blocking the destructive ones. Deny rules still apply when the flag is on.

## Not requested

Camera, microphone, location, contacts, SMS and call logs are not requested.

Taking a photo (the camera option in the composer's "+" menu) hands off to the system camera app, so no camera permission is needed.

## The three heavy ones

**All files access.** Once granted, the app — and Antigravity — can read and write all of shared storage, not just `/sdcard/agycodroid`. If your photos and documents live there, commands Antigravity runs can reach them too. If you don't want that, leave it off and stick to the private folder.

**Shizuku and write secure settings.** This is the shell identity, which can do far more than a normal app, such as installing and removing apps or changing system settings. Everything agycodroid does with it is logged in the Privileged command log, in the Shizuku section of settings. Device tools (letting Antigravity take screenshots, tap the screen, toggle system settings) and the accessibility service are **off by default** and only turn on when you enable them; accessibility switches itself off after a period of inactivity.

Two things to keep in mind. First, the grant goes to the agycodroid app as a whole, not to one button: any code running inside the app — commands Antigravity runs, components you install — can reach the shell identity through it, and auto-activation on boot keeps that access alive across restarts. Turning on Shizuku means trusting everything that runs in agycodroid. So that quiet use at least gets noticed, only read-only commands such as dumpsys with a service name, pm list and settings get, plus the app-stopping and background-restriction commands the memory manager uses (am force-stop / stop-app / set-bg-restriction-level), run straight through `priv`; anything else (installing or removing apps, changing settings, screenshots, simulated taps, reading the system-wide log with logcat, reading files in shared storage and so on) first asks you in agycodroid, and is refused when agycodroid isn't in the foreground. It's a speed bump, not a wall. When you no longer need it, revoke the grant in Shizuku (auto-activation is off by default; if you turned it on, turn it off too). Second, the privileged command log lives in the app's own folder. It's there for you to review, not a tamper-proof audit trail: code running in the app could edit it.

**Install apps.** The system shows a confirmation page every time, and nothing installs until you tap it. With Shizuku, installs can skip the prompt; those are logged in the privileged command log as well.

## Found a security problem?

See [SECURITY.md](../SECURITY.md) and report it privately, not in public.
