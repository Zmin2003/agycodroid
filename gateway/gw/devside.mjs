import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { CFG, PATHS, PREFIX, log, tz } from "./config.mjs";
import { verifiedInfo } from "./agyverified.mjs";
import { ledger } from "./agy.mjs";
import { onSealUnknown } from "./agyseal.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { cmpVer } from "./notices.mjs"; // 与 notices.mjs 共用同一 cmpVer（NT-14，semver §11），不要各写一份
import { termEnv } from "./terminal.mjs";
import { ccMem, privCall } from "./usage.mjs";

// ── 开发端（非 agycodroid 布局）：没有 Java 那一层，更新和 Shizuku 状态由网关自己做 ──────────
// agycodroid 里这些在 App 进程（Updater / ShizukuSetup）；开发端只有一个 runtime/agy 二进制，priv 走 rish。

const DEV_UPD_FILE = path.join(CFG.home, "agyapp-update.json");
// 官方 manifest 服务（见官方 install.sh：https://antigravity.google/cli/install.sh）：
//   {base}/manifests/<platform>.json → { version, url, sha512 }；平台名见 agyPlatform()。
// 没有 stable / latest 频道：manifest 永远指向最新版。
const AGY_MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
/** 本机平台（官方 install.sh 的映射：uname -s / -m + musl 检测 + Termux 判 Android）。
 *  Node 没有 uname -o：Termux 靠 TERMUX_VERSION 环境变量或 /system/bin/linker64 认。 */
function agyPlatform() {
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
  if (!arch) return "";
  if (process.platform === "darwin") return `darwin_${arch}`;
  if (process.platform === "linux") {
    if (process.env.TERMUX_VERSION || fs.existsSync("/system/bin/linker64")) return `android_${arch}`;
    const musl = fs.existsSync("/lib/libc.musl-x86_64.so.1") || fs.existsSync("/lib/libc.musl-aarch64.so.1");
    return musl ? `linux_${arch}_musl` : `linux_${arch}`;
  }
  return "";
}
const devUpd = {
  auto: true, lastCheck: 0, checking: false, error: "",
  // 注意：这里的 id 仍是 "claude"——它是 UI（10-settings-device.js）、Java Updater.java、reconcile.mjs 共用的线上传输键，
  // 四处都认 "claude"，只改一处会断。用户看到的名字是下面的 name："Antigravity CLI"，已经改对了。
  agy: { id: "claude", name: "Antigravity CLI", current: "", latest: "", state: "unknown", message: "", done: 0, total: 0 },
};
try { Object.assign(devUpd, JSON.parse(fs.readFileSync(DEV_UPD_FILE, "utf8")), { checking: false, error: "" }); devUpd.agy.state = devUpd.agy.state === "installing" ? "unknown" : devUpd.agy.state; } catch {}
const devUpdSave = () => { try { fs.writeFileSync(DEV_UPD_FILE, JSON.stringify(devUpd)); } catch {} };
/** 跑某个 agy 二进制的 --version（新下载的那个在换上去之前先这样试跑一次）。
 *  agy 是原生 bionic / 系统二进制，直接跑，不用经过 glibc 加载器。 */
function agyVersionOf(bin) {
  return new Promise((ok) => {
    execFile(bin, ["--version"], { timeout: 30000 }, (e, out) => {
      const m = String(out || "").match(/\d+\.\d+\.\d+/);
      ok(m ? m[0] : "");
    });
  });
}

// 检查途中换了渠道：这次的结果是旧渠道的，不能记到新渠道名下；结束后按新渠道再查一次（#136）
// agy 没有频道：下面这段只防并发检查重叠（devUpdAgain 仍复用）。
let devUpdAgain = false;
async function devUpdCheck() {
  if (devUpd.checking) { devUpdAgain = true; return; }
  devUpd.checking = true; devUpd.error = "";
  const c = devUpd.agy;
  try {
    if (!c.current || c.state !== "installing") c.current = await agyVersionOf(PATHS.agy);
    const platform = agyPlatform();
    if (!platform) throw new Error(tz("这台机器的平台不在官方支持列表里（只支持 64 位 Windows、macOS、Linux）"));
    const r = await fetch(`${AGY_MANIFEST_BASE}/manifests/${platform}.json`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const man = await r.json();
    const v = String(man.version || "").trim();
    if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error(tz("版本号不对：{v}", { v: v.slice(0, 40) }));
    if (!man.url || !/^[a-f0-9]{128}$/.test(String(man.sha512 || ""))) throw new Error(tz("manifest 里没有可用的下载地址或 sha512"));
    c.latest = v; c.manifest = man;
    if (c.state !== "installing") {
      const d = cmpVer(v, c.current);
      c.state = d === 0 ? "uptodate" : "available";
      c.message = d < 0 && c.current ? `将换成 ${v}（比当前的 ${c.current} 旧）` : "";
    }
    devUpd.lastCheck = Date.now();
  } catch (e) { devUpd.error = tz("连不上官方 manifest：{err}", { err: e.message }); }
  finally {
    devUpd.checking = false; devUpdSave();
    if (devUpdAgain) { devUpdAgain = false; setImmediate(devUpdCheck); }
  }
}

/**
 * 换新版（官方 manifest 流程，同 install-agy.mjs）：
 *   下到 agy.part（断点续传）→ 核 sha512 → 从 tar.gz 里解出 antigravity 成员 → 试跑 --version
 *   → 旧的改名 agy.prev（留一版可回退）→ 新的换上。
 * 正在跑的 agy 已经映射了旧文件，换名不影响它；下一轮对话起用新版。
 */
async function devUpdInstall() {
  const c = devUpd.agy;
  if (c.state === "installing" || !c.latest || !c.manifest) return;
  c.state = "installing"; c.message = ""; c.done = 0; c.total = 0;
  const want = c.latest, man = c.manifest;   // 开装时定死：装的途中 manifest 变了，下载地址、校验值、试跑核对要是同一份
  const part = PATHS.agy + ".part", tag = PATHS.agy + ".part.sha512";
  try {
    const url = man.url, sha512 = man.sha512;
    if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new Error(tz("manifest 里的下载地址不对"));
    let have = 0;
    try { if (fs.readFileSync(tag, "utf8").trim() === sha512) have = fs.statSync(part).size; } catch {}
    if (!have) { fs.rmSync(part, { force: true }); fs.writeFileSync(tag, sha512); }
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {} });
        if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
        if (r.status === 200) { have = 0; fs.rmSync(part, { force: true }); }
        const out = fs.openSync(part, "a");
        try { for await (const chunk of r.body) { fs.writeSync(out, chunk); have += chunk.length; c.done = have; } }
        finally { fs.closeSync(out); }
        break;
      } catch (e) {
        if (attempt >= 8) throw e;
        c.message = `网络中断（${e.message}），${attempt * 3} 秒后续传…`;
        await new Promise((ok) => setTimeout(ok, attempt * 3000));
        have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      }
    }
    c.message = "校验 sha512…";
    const h = crypto.createHash("sha512");
    for await (const b of fs.createReadStream(part)) h.update(b);
    const got = h.digest("hex");
    if (got !== sha512) { fs.rmSync(part, { force: true }); throw new Error(tz("sha512 不符（期望 {want}…，实得 {got}…）", { want: sha512.slice(0, 12), got: got.slice(0, 12) })); }
    // 解出 antigravity 成员（tar.gz；系统 tar，开发机上都有）
    const stage = part + ".d";
    fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
    await new Promise((ok, no) => {
      execFile("tar", ["-xzf", part, "-C", stage, "antigravity"], { timeout: 120000 }, (e) => (e ? no(e) : ok()));
    });
    const bin = path.join(stage, "antigravity");
    if (!fs.existsSync(bin)) throw new Error(tz("压缩包里没有 antigravity"));
    fs.chmodSync(bin, 0o755);
    const v = await agyVersionOf(bin);
    if (v !== want) throw new Error(tz("新版试跑失败（--version 得到「{v}」）", { v }));
    fs.rmSync(PATHS.agy + ".prev", { force: true });
    try { fs.renameSync(PATHS.agy, PATHS.agy + ".prev"); } catch {}
    fs.renameSync(bin, PATHS.agy);
    fs.rmSync(part, { force: true }); fs.rmSync(tag, { force: true }); fs.rmSync(stage, { recursive: true, force: true });
    // 存下这次的 manifest 副本：agyseal.mjs 下次起进程前就按它核程序
    try { fs.writeFileSync(path.join(path.dirname(PATHS.agy), "manifest.json"), JSON.stringify({ version: want, url, sha512 }, null, 2)); } catch {}
    log(`Antigravity CLI 已更新 ${c.current} → ${v}`);
    c.current = v; c.state = "uptodate"; c.message = `已更新到 ${v}（下一轮对话起生效；旧版留在 agy.prev）`;
  } catch (e) {
    c.state = "error"; c.message = e.message;
  } finally { devUpdSave(); }
}

function devUpdStatus() {
  const { agy, ...rest } = devUpd;
  return { ok: true, ...rest, items: [agy] };
}

// 自动：启动 1 分钟后、之后每 30 分钟看一眼，距上次检查超过 6 小时就查；有新版且开着自动就装
if (!PREFIX) {
  const tick = async () => {
    if (!devUpd.auto || Date.now() - devUpd.lastCheck < 6 * 3600_000) return;
    await devUpdCheck();
    if (devUpd.auto && devUpd.agy.state === "available") devUpdInstall();
  };
  setTimeout(tick, 60_000);
  setInterval(tick, 30 * 60_000);
}

// agycodroid：版本目录里有 agy 程序却没有安装时存下的 manifest 副本（网关每轮起 agy 前靠它核程序，见 agyseal.mjs），
// 连得上官方 manifest 时补核一次 sha512、存下 manifest（install-agy.mjs --recheck）。启动 2 分钟后、之后每 6 小时看一眼
if (PREFIX && process.env.AGAPP_BIN) {
  const dest = path.join(CFG.home, ".local", "share", "agycodroid", "agy");
  const script = path.join(process.env.AGAPP_BIN, "..", "scripts", "install-agy.mjs");
  const recheck = () => {
    let pending = false;
    try { pending = fs.readdirSync(dest).some((d) => /^\d/.test(d) && fs.existsSync(path.join(dest, d, "agy")) && !fs.existsSync(path.join(dest, d, "manifest.json"))); } catch {}
    if (!pending || !fs.existsSync(script)) return;
    execFile(path.join(PREFIX, "bin", "node"), [script, "--recheck"], { env: termEnv(), timeout: 600000 }, (e, out) => {
      const msg = String(out || "").trim();
      if (msg) log("[agy 补核] " + msg.replace(/\n/g, "；"));
      if (e && e.code === 3) ledger("verify", false, "Antigravity CLI 与 manifest 不符", msg);
      else if (/^✓/m.test(msg)) ledger("verify", true, "Antigravity CLI 已按 manifest 补核", msg);
    });
  };
  setTimeout(recheck, 120_000);
  setInterval(recheck, 6 * 3600_000);
  // 起 agy 前发现版本目录里没有 manifest（agyseal.mjs）：别等 6 小时。发行版补核拿到 manifest 之前不起，用户在等，一分钟内最多补核一次
  let lastAsk = 0;
  onSealUnknown(() => { if (Date.now() - lastAsk < 60_000) return; lastAsk = Date.now(); setTimeout(recheck, 1000); });
}

/** 开发端的 priv 状态：真跑一次 priv 'id -u'（rish → Shizuku），拿到 2000/0 才算就绪 */
export function devPrivStatus() {
  return new Promise((ok) => {
    execFile("priv", ["id -u"], { timeout: 8000, env: process.env }, (e, out, err) => {
      const uid = String(out || "").trim();
      if (uid === "2000" || uid === "0") return ok({ state: "ok", installed: true, running: true, granted: true, uid: +uid, wireless: false, paired: true, dev: true });
      const msg = String(err || out || (e && e.message) || "").trim();
      ok({ state: /not running|binder|没在运行|isn't running/i.test(msg) ? "not_running" : "no_permission", installed: true, running: false, granted: false,
        wireless: false, paired: true, dev: true, message: msg.slice(0, 200) });
    });
  });
}

async function devApp(op, b) {
  if (op === "upd_status") {
    if (!devUpd.lastCheck && !devUpd.checking) devUpdCheck();
    else if (!devUpd.agy.current) devUpd.agy.current = await agyVersionOf(PATHS.agy);
    return devUpdStatus();
  }
  if (op === "upd_check") { devUpdCheck(); await new Promise((r) => setTimeout(r, 200)); return devUpdStatus(); }
  if (op === "upd_set") {
    // agy 没有频道：stable / latest / pinned 都不认，只跟随官方 manifest 的最新版
    if (b.channel === "pinned" || b.channel === "stable" || b.channel === "latest") return { ok: false, message: tz("agycodroid 跟随官方 manifest 的最新版，没有版本频道可切") };
    if (typeof b.auto === "boolean") devUpd.auto = b.auto;
    devUpdSave();
    return devUpdStatus();
  }
  if (op === "upd_apply") {
    if (b.item !== "claude") return { ok: false, message: tz("开发端只管 Antigravity CLI（应用本体由你在本机构建安装）") };
    if (devUpd.agy.state !== "available" && devUpd.agy.state !== "error") return { ok: false, message: tz("没有可装的新版，先检查更新") };
    devUpdInstall();
    return { ok: true, message: tz("开始更新 Antigravity CLI") };
  }
  return { ok: false, message: tz("开发端不支持：{op}", { op }) };
}

// ── Antigravity CLI 版本选单：只有官方 manifest 的最新版 ─────────────────────────
// agy 没有公开的版本列表接口：manifest 只给最新版（version/url/sha512）。
// 版本列表、stable、latest 都返回这一个版本；取不到就留空，不编版本号。
let agyVersionsCache = { at: 0, data: null };
async function agyVersions(force) {
  if (!force && agyVersionsCache.data && Date.now() - agyVersionsCache.at < 600e3) return agyVersionsCache.data;
  let data = { ok: false, versions: [], stable: "", latest: "", message: "" };
  try {
    const platform = agyPlatform();
    if (!platform) throw new Error(tz("这台机器的平台不在官方支持列表里"));
    const r = await fetch(`${AGY_MANIFEST_BASE}/manifests/${platform}.json`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const man = await r.json();
    const v = String(man.version || "").trim();
    if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error(tz("版本号不对"));
    data = { ok: true, versions: [v], stable: v, latest: v, message: "" };
    agyVersionsCache = { at: Date.now(), data };
  } catch (e) {
    data.message = tz("取不到版本列表：{err}", { err: e.message });
  }
  return data;
}

// /api/app/* 各操作收哪些字段（对照 Priv.java、Updater.set、Notify.set、DeviceTools.set）
const APP_FIELDS = {
  upd_apply: { item: "string", version: "string" },
  upd_set: { auto: "boolean", channel: "string", version: "string", flavor: "string" },
  upd_verify: { full: "boolean" }, upd_repair: { full: "boolean" },
  share_file: { path: "string", mime: "string" },
  apk_install: { path: "string" },
  shz_pair: { code: "string" }, shz_autostart: { enable: "boolean" },
  notify_set: { done: "boolean", ask: "boolean" },
  dev_set: { on: "boolean", tool: "string", enabled: "boolean", a11y: "string", idle: "number" },
};

// ── 路由：/api/mem/status /api/mem/clear /api/priv/status /api/priv/request /api/priv/open /api/priv/audit /api/priv/keepalive /api/app/ ──
export async function routeDevside(req, res, u, p) {
  if (req.method === "GET" && p === "/api/claude/versions") {
    // 路径名还是 /api/claude/versions（设置页调它；改路径要 UI 一起改，先留着，内容已经是 agy 的）
    const [vs, vi] = await Promise.all([agyVersions(u.searchParams.get("refresh") === "1"), verifiedInfo((u.searchParams.get("lang") || "zh").startsWith("zh") ? "zh" : "en")]);
    return sendJson(res, 200, { ...vs, ...vi });
  }
  if (req.method === "GET" && p === "/api/mem/status") return sendJson(res, 200, await ccMem(["status", "--json"]));
  if (req.method === "POST" && p === "/api/mem/clear") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await ccMem(["clear", "--json", ...(b.hard ? ["--hard"] : []), ...(b.dryRun ? ["--dry-run"] : [])]));
  }
  if (req.method === "GET" && p === "/api/priv/status") return sendJson(res, 200, await privCall({ op: "status" }));
  if (req.method === "POST" && p === "/api/priv/request") return sendJson(res, 200, await privCall({ op: "request" }));
  if (req.method === "POST" && p === "/api/priv/open") return sendJson(res, 200, await privCall({ op: "open_manager" }));
  // 特权命令记录：agycodroid 的 Priv.java 每执行一条就往 home/priv-audit.jsonl 记一行。最新的在前
  if (req.method === "GET" && p === "/api/priv/audit") {
    const f = path.join(CFG.home, "priv-audit.jsonl"), items = [];
    for (const ff of [f, f + ".1"]) {
      let txt = ""; try { txt = fs.readFileSync(ff, "utf8"); } catch {}
      for (const l of txt.split("\n").reverse()) { if (items.length >= 300) break; try { if (l) items.push(JSON.parse(l)); } catch {} }
      if (items.length >= 300) break;
    }
    return sendJson(res, 200, { ok: true, supported: !!PREFIX, items });
  }
  if (req.method === "POST" && p === "/api/priv/noask") {
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    // 时长只认固定几档（应用侧同样只认这几档，别的按 24 小时），最长一周（11-08 用户定）
    const hours = [1, 4, 24, 72, 168].includes(+b.hours) ? +b.hours : 24;
    return sendJson(res, 200, await privCall({ op: "noask", enable: b.enable === true, hours }, 90000));
  }
  if (req.method === "POST" && p === "/api/priv/keepalive") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await privCall({ op: "keepalive", enable: b.enable !== false }, 60000));
  }
  // 更新（APK / 工具包 / Antigravity CLI）与 Shizuku 一键安装激活：都在应用进程里做，这里只转话
  if (p.startsWith("/api/app/")) {
    const op = p.slice(9);
    const OPS = ["upd_status", "upd_check", "upd_apply", "upd_set", "upd_verify", "upd_repair", "share_logs", "factory_reset", "share_file", "apk_install", "shz_install", "shz_activate", "shz_pair", "shz_autostart", "shz_repair", "open_app_settings", "freeze_ack", "notify_status", "notify_set", "notify_settings", "dev_status", "dev_set", "a11y_settings"];
    if (!OPS.includes(op)) return sendJson(res, 404, { ok: false, message: tz("未知操作") });
    const raw = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    // 只转各操作认的字段、认的类型：应用那头也逐项校验，这里再挡一道（11-01 独立审查低-3）
    const b = {};
    for (const [k, ty] of Object.entries(APP_FIELDS[op] || {})) {
      const v = raw && raw[k];
      if (v === undefined) continue;
      if (typeof v !== ty || (ty === "string" && v.length > 4096) || (ty === "number" && !Number.isFinite(v))) return sendJson(res, 400, { ok: false, message: tz("请求参数不对") });
      b[k] = v;
    }
    if (!PREFIX) return sendJson(res, 200, await devApp(op, b));
    // 激活 / 打开自动激活要等用户在原生对话框里点（最多 60 秒），和 keepalive 一样放长；装 APK 还要先把包拷进暂存再等确认
    return sendJson(res, 200, await privCall({ ...b, op }, op === "shz_activate" || op === "shz_autostart" ? 65000 : op === "apk_install" ? 120000 : undefined));
  }
  return NEXT;
}
