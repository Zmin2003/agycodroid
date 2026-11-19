# agy versions: on-device verification and known issues

[中文](agy-versions.zh-CN.md) | English

agycodroid runs the official Antigravity CLI (`agy`) binary, unmodified. Every new Google release can reach agycodroid users, and a release that works on a desktop can still break on Android. For example, if it starts using a newer system call, Android's seccomp filter may block it and the feature that needed the call breaks. `agy` is an official bionic Android build and runs directly — there is no glibc loader and no seccomp shim (no `enosys-run`) to soften that, so on-device verification matters more, not less.

So the maintainer verifies new releases on a real device. The record is **local and unsigned**: this fork has no signing key, so nothing is published or fetched. The app reads only the on-device record at `home/.cache/agycodroid/agy-verified.json`, written by the verification script itself.

## Where versions come from

The source of truth is Google's official manifest for Android arm64:

`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json`

It carries three fields per release: `version`, `url` (a tar.gz to download) and `sha512`. agycodroid downloads the tarball from `url`, checks it against `sha512`, and unpacks it. The version changes with every release — it is never hard-coded anywhere. There are no stable / latest channels here: one manifest, one current version per architecture.

## The record

Each verified release gets one row. The record format is:

| version (from the manifest) | sha512 (from the manifest) | Verified on (device, Android version) | Date verified | Notes |
|---|---|---|---|---|
| _—_ | _—_ | _—_ | _—_ | _—_ |

There are no rows yet: no agy release has been verified on-device under the agy port, and no version, hash, device or date is recorded here until a real verification run produces it.

The record lives in two places, and they are **not** synced:

- **On the device**: `home/.cache/agycodroid/agy-verified.json` — written directly by `scripts/verify-agy.mjs` when a check passes. The version picker and auto-update read this file only.
- **In this repo**: `agy/verified.json` — the maintainer's local record, kept with `scripts/agy-verified.mjs`. It is not signed, not published, and the app never downloads it. It exists so a maintainer can keep notes and mark bad versions while working on the code.

## What you see

In **Settings → Updates → Antigravity CLI version**:

| Mark | Meaning |
|---|---|
| **Verified** | This version was run on a real device (the on-device record says which device and Android version; "(N devices)" if several) |
| **not verified yet** | Nobody has checked this version yet. It doesn't mean it's broken |
| **Known issue: …** | Confirmed broken on agycodroid, with the reason and a workaround; once a fixed release exists it says "fixed in x.y.z". You're asked to confirm before switching to it |

Auto-update: if the manifest moves to a version with a known issue, it isn't installed automatically, even on Wi-Fi, and the update status says why. You can still install it yourself with "Update" or from the version picker. Pinned versions aren't affected.

## What's checked, and what isn't

The on-device check installs the version into a temporary directory without touching the one you use, checked against the manifest `sha512` as usual. Then it runs two steps directly (no supervisor, no shim):

1. **version**: `agy --version` reports the manifest version
2. **tools**: one model call that uses a terminal tool to write a file and read it back. This covers spawning processes, file I/O and streaming output

The `tools` step makes a real model call (using agy's own login / configuration on that device, costing very little).

Not checked: every UI feature, every third-party provider, every device and ROM. "Verified" means "the core path works on this device", not "nothing can break". Please keep reporting problems; once confirmed, the version gets marked as having a known issue.

## Maintainers: verifying and recording

On the phone, in agycodroid's terminal (uses your own login; the two steps cost very little):

```sh
node verify-agy.mjs <version>
```

(The script lives in the app's scripts directory and needs the terminal's `PREFIX` / `AGAPP_BIN`. If the version you want to check is the one already installed, it is used directly without downloading; `--bin` checks a given binary instead.) The result is written to `agy-verify-<version>.json` in the current directory, and a passing result is merged into the on-device record right away. Ideally run it once with the targetSdk 28 package and once with the 36 package, since they execute binaries differently.

On the release machine, to maintain the repo record:

```sh
node scripts/agy-verified.mjs add agy-verify-<version>.json …
node scripts/agy-verified.mjs bad <version> --zh "…" --en "…"
node scripts/agy-verified.mjs bad <version> --zh "…" --en "…" --fixed <version>
node scripts/agy-verified.mjs unbad <version>
node scripts/agy-verified.mjs rm <version>
node scripts/agy-verified.mjs list
```

Nothing here signs or publishes anything: the repo record is a local note, and the app never reads it. `add` refuses results that didn't pass, and results that weren't produced in agycodroid's terminal (no app version or package type).

## Where the code lives

| Path | What it does |
|---|---|
| `scripts/verify-agy.mjs` | On-device verification (runs on the phone); writes the on-device record |
| `scripts/agy-verified.mjs` | Maintaining the repo record `agy/verified.json` (local, unsigned, unpublished) |
| `gateway/gw/agyverified.mjs` | Reading the on-device record from `home/.cache/agycodroid/agy-verified.json` |
| `gateway/web/app/10-settings-device.js` | Marks and confirmation in the version picker |
| `android/java/cc/agyroid/Updater.java` (`knownBad`) | Auto-update skips versions with known issues |
