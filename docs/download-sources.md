# Multi-source downloads: maintenance guide

English | [中文](download-sources.zh-CN.md)

agycodroid fetches eight kinds of things from the network, most of them from more than one place. This guide records where each one comes from, why we trust it, where the code lives, and how to check it after a change.

**The rule: trust first, download second.** Every item has a trust anchor that does not depend on where the bytes came from: a hash pinned in the APK, or a signing key pinned in code. A mirror is just another route to the same file and needs no trust of its own. Adding a source never weakens security as long as its content is still checked against the anchor. Conversely, **no change may ever turn something fetched from a mirror into the anchor itself.**

Last verified: 2026-11-19 (agycodroid fork; the Antigravity CLI row was re-checked against the live official manifest — version at check time 1.5.12, always re-read the manifest, never pin it).

---

## Overview

| # | What | Sources (in order) | Trust anchor | Code |
|---|---|---|---|---|
| 1 | Devkit (by module from 0.3.9: ~330 MB by default, ~700 MB for all; older apps use the ~650 MB single package) | GitHub Release → dl.cccodroid.net/devkit/ | `devkit-pin.json` shipped in the APK (sha256 of the single-package gz / tar and of `modules.json`, which in turn holds each block's sha256) | `Installer.java`, `Updater.java`, `gateway/gw/modules.mjs` (adding modules later) |
| 2 | APK updates | Release list: GitHub API → cccodroid.net/dl/releases.json → dl.cccodroid.net/dl/releases.json; APK: GitHub Release → cccodroid.net/dl/ → dl.cccodroid.net/dl/ → gh-proxy | Android APK signature (only the same release key can update) + sha256 in the release list | `Updater.java` |
| 3 | Antigravity CLI (agy) | Official manifest only (antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json) | sha512 from Google's official manifest (no PGP signature exists for agy); version / URL / sha512 read from the manifest at install time, never hard-coded | `assets/scripts/install-agy.mjs` |
| 4 | Component index | GitHub Release → cccodroid.net/components/ | ed25519 key pinned in the gateway | `gateway/gw/components.mjs` `compFetchIndex` |
| 5 | Component packages | GitHub Release ⇄ dl.cccodroid.net/components/ (alternating, last success remembered) | sha256 from the signed index, then the in-package MANIFEST after unpacking | `gateway/gw/components.mjs` `compRunInstall` |
| 6 | pkg | Termux official → packages.termux.dev → grimler.se → TUNA/USTC/BFSU/NJU (main, x11) | Termux autobuilds key pinned in pkg, checks `Release.gpg` | `assets/bin/pkg.mjs` |
| 7 | glibc libs for custom components | Termux official glibc repo only | HTTPS + sha256 from `Packages` | `gateway/gw/custom.mjs` `customFetchLibs` |
| 8 | On-device models | ModelScope (official Qwen only) → HuggingFace → hf-mirror.com | sha256 pinned in the catalog (from HF LFS) | `gateway/gw/local.mjs` `LOCAL_CATALOG` |

**Two shared techniques since 0.4.1** (devkit, APK updates, component packages and Antigravity CLI):

- **Segmented parallel download**: for files of 16 MB or more from a server that honours Range, the remaining bytes are split into up to 4 segments fetched at once and written at their offsets into one `.part` (pre-sized to the full length). Per-segment progress lives in `.part.seg`, so an interrupted download, or one that switched sources, resumes from it; if `.seg` and `.part` disagree, both are discarded. A source without Range support falls back to a single connection. Measured on dl.cccodroid.net: about 2.7 MB/s on one connection, about 14 MB/s on four. Code: `fetchSegmented` in `Installer.java`, and `gateway/gw/pget.mjs`.
- **Switching away from slow sources** (since 0.4.2, Java downloads of the APK and devkit): each connection is measured in 30-second windows, and less than 600 KB in a window counts as a failure, which triggers a retry and then the next source. With no source left it keeps resuming without counting failures. Before, only a failed connection or 60 seconds without a byte switched sources, so a slow trickle from GitHub sat at 0% forever (reported for 0.3.16 → 0.4.1). Code: `Slow` in `Installer.java`.
- **gh-proxy.com as a last resort**: when every other source struggles, a GitHub URL is tried once more through `https://gh-proxy.com/github.com/…`. It is a third-party service and needs no trust: content is still checked against the trust anchors in the table above. (Suggested in discussion #15.)

Some components also download things on first run, e.g. Blender fetches itself from Debian and a patched Mesa from GitHub. Those first-run scripts check their own pinned sha256 and are **outside the multi-source system** described here.

---

## Server side (mirrors on cccodroid.net)

Two hostnames, one server:

| Host | Behind Cloudflare? | Serves |
|---|---|---|
| `cccodroid.net` | yes (proxied) | Website, APKs (`/dl/`), component indexes (`/components/<official\|community>/components.json(.sig)`), Antigravity CLI manifests (`/claude-code/`) |
| `dl.cccodroid.net` | no (DNS only, direct) | Devkits (`/devkit/`), component packages (`/components/<official\|community>/<file>`), Antigravity CLI manifests (`/claude-code/`, same copy) |

**Why two**: files of hundreds of MB don't belong on a CDN, and some networks in China only reach one of the two, so the Antigravity CLI manifests live on both.

**Who maintains them**: the generator `repos/agycodroid-site/src/build.mjs`, run every 30 minutes by `agycodroid-site.timer`. The service timeout is raised to 60 minutes by the drop-in `/etc/systemd/system/agycodroid-site.service.d/timeout.conf`. What each step does:

- **APKs and release list** (`fetchReleases`): only files whose sha256 matches GitHub's record; keeps the last 4 versions.
- **Devkits** (`fetchDevkits`): only the version pinned by the APK and the newest one, checked against `devkit.lock.json`.
- **Component indexes** (`fetchIndexes`): updated only when the ed25519 signature verifies; on failure the previous copy is kept.
- **Component packages** (`fetchComponentFiles`): only packages listed in a verified index, each checked by sha256. A verified file gets a `.ok` marker next to it (not publicly reachable); files no longer listed are deleted. This runs **after** the site switch, so the initial 4 GB sync doesn't hold up site updates.
- **Antigravity CLI manifests** (`fetchAntigravity`): version pointers for the stable and latest channels plus `manifest.json` and `.sig` for the last 12 versions, **accepted only if Anthropic's PGP signature verifies**. Only manifests are mirrored, never the binary; see section 3.

nginx config: `/etc/nginx/sites-available/agycodroid.conf` and `agycodroid-dl.conf`. Data lives in `/var/www/agycodroid/data/`, owned by `ccsite`. `/claude-code/` on `dl.cccodroid.net` is an `alias` to `data/current/claude-code/`, so it switches atomically with the site.

Deployment: see `repos/agycodroid-site/README.md`. **Other sites run on this server; touch only agycodroid files.**

---

## Details

### 1. Devkit

- On first install the setup page lets the user pick GitHub, the cccodroid.net mirror, or a local file. GitHub and the mirror back each other up, with gh-proxy tried last; sources are tried in order without going back, resuming the same `.part` file.
- Checksums come from `assets/devkit-pin.json` in the APK. It is generated by `scripts/pin-devkit.mjs`, and `build.sh` checks that it matches `devkit-sources.txt`.
- **To change the devkit version**: publish the devkit Release, update `devkit-sources.txt`, run `pin-devkit.mjs`, then build the APK. The server picks up the newly pinned version on its own.
- `pin-devkit.mjs` requires the lock file to be signed (`devkit.lock.json.sig`) and verifies it. Only the few releases before 10-29 were never signed; for those, after checking, rerun with `PIN_ALLOW_UNSIGNED=1` and the pin records `lockSigned:false`. Don't use this switch for new releases.
- Built-in component index (`components.json` and `.sig` on the `components` Release): `publish-devkit.mjs` verifies the published copy with the release key before merging and stops if it fails. With a private key, `components-index.mjs` also only merges an old index that verifies. A brand-new repository (no index on the Release yet) needs a one-time manual seed: run `INDEX_SIGNING_KEY_FILE=<key> node devkit/components-index.mjs <new-path>/components.json <URL prefix> <component-x.json>` against an output path that doesn't exist, upload the resulting `components.json` and `components.json.sig` to the `components` Release, then leave it to `publish-devkit.mjs`.

### 2. APK updates

- The GitHub API is tried first, then `cccodroid.net/dl/releases.json`, then `dl.cccodroid.net/dl/releases.json` (the same file, direct, not through Cloudflare). It has the same shape as GitHub's release list. Android itself enforces the APK signature.
- The APK is tried from GitHub Release → `cccodroid.net/dl/<version>/` → `dl.cccodroid.net/dl/<version>/` → gh-proxy, resuming the same `.part`. The dl host's `/dl/` was added for 0.4.2 (`agycodroid-dl.conf` on the VPS, sharing the main site's `data/dl/`); older versions only use the first two.
- For local testing, `home/.config/agycodroid/update-feed` overrides the release list URL.

### 3. Antigravity CLI (the hardest one)

**Manifest only — no mirrors, no fallback.** Antigravity CLI is closed source; hosting the binary ourselves would be redistribution and risks breaking the terms. Google publishes no per-version download address and no signature: the only source is the official manifest at `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json` (the same address the official `install.sh` uses: `DOWNLOAD_BASE_URL + "/manifests/" + platform + ".json"`). The manifest returns `{"version","url","sha512"}` — the version is whatever is current at that moment, the URL is the tar.gz, the sha512 is its checksum. Version / URL / sha512 are read live at install time and are never hard-coded anywhere in the app.

**Trust anchor (only one)**: the sha512 in Google's official manifest, fetched over TLS. There is no PGP signature list for agy — do not invent one, and do not add a key. The install flow (`android/assets/scripts/install-agy.mjs`):

1. Read the manifest, take `version` / `url` / `sha512`.
2. Download the tar.gz from the manifest's URL, verify sha512, refuse to install on mismatch.
3. Extract the member named `antigravity`, land it as `agy` (755).
4. Trial-run `agy --version`; only then switch the `current` symlink. Keep current + previous version only.
5. Save two records for the pre-start check: a copy of the manifest (`manifest.json`) and the binary's own sha512 (`agy.sha512`, computed at install time — the manifest's sha512 is the tar.gz's, not the binary's).

**Limits the manifest imposes** (not our choice):

- The manifest only ever names the latest release: a version that is not the manifest's current one cannot be installed unless it is already on the device (a version directory with a saved `manifest.json` copy can be switched back to without downloading).
- There are no stable / latest channels and no pinned-version installs of never-installed versions.
- `agy` is an official bionic Android build and runs directly: no glibc loader, no seccomp shim, no DNS bridge.

**Download behaviour**:

- Downloads resume from a `.part` file; the expected sha512 is kept in `.part.sha512` so a resumed download is still verified.
- When the manifest is unreachable, the install fails with a plain-language error; there is no mirror to fall back to.

**Testing**: one environment variable overrides the manifest URL to simulate an unreachable official server (content still has to pass the sha512 check):

```sh
AGAPP_AGY_MANIFEST_URL=https://127.0.0.1:9/x   # make the official manifest unreachable
bash install-agy.sh latest        # or an exact version, if already installed
```

Cover at least: manifest reachable, install succeeds and `agy --version` matches; manifest unreachable, install fails cleanly; tar.gz sha512 mismatch, install refuses; switching back to a previously installed version works offline.

### 4 & 5. Component index and packages

- Index: GitHub first, `COMP_INDEX_MIRROR` (cccodroid.net) as backup. The ed25519 key is pinned in the gateway, and the server checks the same key before mirroring.
- Packages: `compMirrorUrl(b)` maps a GitHub URL to `dl.cccodroid.net/components/<official|community>/<file>` (`preset` maps to `official`). Up to 4 attempts alternate between the two; the winner is remembered in `compMirrorFirst` until the process restarts. The progress bar shows the current source (`progress.via`).
- **Publishing a new component needs no extra step**: the generator mirrors it on its next run. Confirm with the check script below.

### 6. pkg

- Repositories are listed in `REPOS`, each with a `base` and a list of `mirrors`.
- **Verification**: fetch `Release` and `Release.gpg` and verify against `TERMUX_KEYS`; check `Packages.gz` against the sha256 in `Release`; check each `.deb` against the sha256 in `Packages`.
  - Signature missing means the source is skipped, Termux's own hosts included; if every source fails, the cached index is used.
  - **Any other mirror with a missing or bad signature is not used.**
- **Mirrors in China**: TUNA, USTC, BFSU and NJU carry main and x11 only, **no glibc repo** (checked 2026-10-20); Aliyun has no Termux mirror. They lag the official repo by 10–15 hours, so an index from the official repo may point at packages a mirror doesn't have yet (404); the code just moves to the next source.
- **Packages are fetched first from whichever source served the index** (`repo.from`), so an unreachable official host doesn't stall every package.
- A repo whose index can't be fetched is skipped; only failing all of them is an error.
- Termux signing key: `CC72CF8BA7DBFA0182877D045A897D96E57CF20C` (RSA, termux-autobuilds). It matched in three places: `packages/termux-keyring/termux-autobuilds.gpg` in termux-packages, keyserver.ubuntu.com and keys.openpgp.org. **If Termux rotates the key, pkg will fail verification on every source**; verify the new key the same way and update the pin.
- **The source file is `android/assets/bin/pkg.mjs`.** `android/assets/app/` is build output that `build.sh` wipes and regenerates every time; edits there are lost.

### 7. glibc libs for custom components

Only the official Termux glibc repo is used, since no Chinese mirror exists. If the user can't reach it, the analysis lists those libraries as "no source found"; the program still installs but may not run. A future fix would be to mirror `termux-glibc` on our server and verify `Release.gpg` as pkg does.

### 8. On-device models

Every catalog entry has a pinned sha256. Official Qwen models try ModelScope first; everything else tries HuggingFace, then hf-mirror.com. URLs pasted by the user must be https.

---

## Routine checks (before a release or when something breaks)

```sh
# agy official manifest is reachable and has version/url/sha512; every component package in the indexes exists on dl.cccodroid.net with the right size
node scripts/check-mirrors.mjs

# The generator's latest runs
ssh <server> 'journalctl -u agycodroid-site -n 20 --no-pager'
```

**Common symptoms**:

| Symptom | Likely cause | What to do |
|---|---|---|
| Install log says the cccodroid.net mirror's signature can't be fetched | The user's route to Cloudflare is unstable | Normal; dl.cccodroid.net is tried next, then gh-proxy |
| Component package 404 on the mirror | Just published, generator hasn't run yet | Wait 30 minutes or run `systemctl start agycodroid-site` |
| pkg says a mirror's Release signature is missing | Mirror doesn't sync `Release.gpg`, or is incomplete | Normal, next source is used; drop the mirror from the list if it persists |
| pkg fails verification on every source | Termux rotated its key | Verify and update `TERMUX_KEYS` (section 6) |
| agy install fails: manifest unreachable | Google's manifest endpoint is down or blocked on this network | Nothing to fall back to — wait and retry; check whether the manifest URL loads in a browser |
| agy install fails: sha512 mismatch | Download corrupted, or the manifest changed mid-download | Retry; the installer re-reads the manifest and re-verifies from scratch |
| Installed agy is older than the manifest | A newer release exists | Normal — update from Settings; the previous version is kept as a fallback |

---

## Checklist for adding a source

1. Are its files **byte-identical** to the original? Spot-check a sha256.
2. Is the trust anchor still independent of it, i.e. is content still checked against the pinned hash or signature?
3. Can it slow down other sources when it fails? Check for a connect timeout and that a stall trips the speed limit.
4. Can it resume the same `.part` file as existing sources?
5. Add it to the overview table and the matching section of this guide.
