#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  verify-agy.mjs —— 在真机上验一版 agy 能不能在 agycodroid 里正常用（在 agycodroid 的终端里跑）
//
//  node verify-agy.mjs [版本号|latest] [--model <型号>] [--out <目录>] [--keep] [--bin <agy 二进制>]
//  （要验的正好是当前装的那一版就直接用它，不再下载；--bin 直接验给定的二进制，版本号以它 --version 报的为准）
//
//  做什么（不动你当前装的那一版）：
//   1. 用 App 自带的 install-agy.mjs 把这一版装进临时目录（同样按官方 manifest 核 sha512）
//   2. 直接跑两步（agy 是官方 bionic 构建，不用 glibc 加载器、不用 seccomp 垫片）：
//        version  agy --version 报的是这一版
//        tools    -p 一轮：让它用 Bash 工具写一个文件再读出来（拉子进程、读写文件、流式输出都走一遍）
//   3. 结果写成 agy-verify-<版本>.json（设备、Android 版本、App 与工具包版本、每步结果、sha512）。
//      通过了就同时并进本机真机验证记录 home/.cache/agycodroid/agy-verified.json，
//      网关（gw/agyverified.mjs）与 Java 自动更新直接读它：版本选单标「已验证」，有问题的版本不自动装。
//  tools 一步要真的调模型（用这台机上 agy 自己的登录 / 配置，消耗很少）。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const MODEL = opt("--model"), OUTDIR = opt("--out") || process.cwd(), KEEP = flag("--keep"), GIVEN = opt("--bin");
const WANT = argv[0] || "latest";
const say = (s) => console.log(s);
const die = (s) => { console.log("✗ " + s); process.exit(1); };

const { PREFIX, HOME, AGAPP_BIN } = process.env;
if (!PREFIX || !AGAPP_BIN) die("要在 agycodroid 的终端里跑（没有 PREFIX / AGAPP_BIN）");
const APP = path.dirname(AGAPP_BIN);
const MANIFEST_URL = process.env.AGAPP_AGY_MANIFEST_URL
  || "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json";
const VERIFIED_CACHE = path.join(HOME, ".cache", "agycodroid", "agy-verified.json");
for (const f of [path.join(APP, "scripts/install-agy.mjs")]) if (!fs.existsSync(f)) die("找不到 " + f + "（App 太旧？）");

const tmpBase = fs.mkdtempSync(path.join(process.env.TMPDIR || path.join(PREFIX, "tmp"), "agy-verify-"));
const cleanup = () => { if (!KEEP) fs.rmSync(tmpBase, { recursive: true, force: true }); };
process.on("exit", cleanup);

const getprop = (k) => spawnSync("/system/bin/getprop", [k], { encoding: "utf8" }).stdout?.trim() || "";
const device = { model: getprop("ro.product.model"), maker: getprop("ro.product.manufacturer"), android: getprop("ro.build.version.release"),
  sdk: +getprop("ro.build.version.sdk") || 0, kernel: os.release(), targetSdk: +process.env.AGAPP_TARGET_SDK || 0, exec: process.env.AGAPP_EXEC || "" };

// 端口只认数字：带 @ 之类会把令牌头送到别的主机
const PORT = /^\d{1,5}$/.test(process.env.AGAPP_PORT || "") ? process.env.AGAPP_PORT : "8791";
// App / 工具包版本：问本机网关（终端里有它的令牌文件）
async function appInfo() {
  try {
    // 令牌就在 home 的固定位置（和 cc-archive.mjs 一样直接读），否则这里整段失败、结果里没有 App 版本
    const tf = process.env.AGAPP_TOKEN_FILE || path.join(HOME || os.homedir(), ".gateway-token");
    const tok = fs.readFileSync(tf, "utf8").trim(), mac = (s) => crypto.createHmac("sha256", tok).update(s).digest("hex");
    // 不发令牌原文：先核身份（端口上可能是网关没起来时抢占的应用），再按 sig2 一次一签
    const n = crypto.randomBytes(16).toString("hex");
    const [boot, pm] = (await (await fetch(`http://127.0.0.1:${PORT}/__proof?for=tool&n=${n}`, { signal: AbortSignal.timeout(8000) })).text()).trim().split(" ");
    if (!/^[0-9a-f]{32}$/.test(boot || "") || pm !== mac(`tproof:${n}:${boot}:127.0.0.1`)) throw new Error("not the gateway");
    const sig = (p) => { const ts = Date.now(), r = crypto.randomBytes(16).toString("hex"); return { "X-CC-Sig": `${ts}.${r}.${mac(`sig2:${boot}:127.0.0.1:GET:${ts}:${r}:${crypto.createHash("sha256").update("").digest("hex")}:${p}`)}` }; };
    const r = await fetch(`http://127.0.0.1:${PORT}/api/app/upd_status`, { headers: sig("/api/app/upd_status"), signal: AbortSignal.timeout(8000) });
    const j = await r.json(), it = (id) => (j.items || []).find((x) => x.id === id)?.current || "";
    return { app: it("app"), devkit: it("devkit"), current: it("claude") };
  } catch { return { app: "", devkit: "", current: "" }; }
}

// latest 现在是哪一版：直接问官方 manifest（agy 没有 stable 渠道）
async function latestVersion() {
  try {
    const j = await (await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(15000) })).json();
    return /^\d+\.\d+\.\d+/.test(j?.version || "") ? j.version : "";
  } catch { return ""; }
}

// ── 1. 装进临时目录 ───────────────────────────────────────────
const info = await appInfo();
say(`设备 ${device.maker} ${device.model} · Android ${device.android}（SDK ${device.sdk}）· App ${info.app || "?"} · ${info.devkit || "工具包 ?"}`);
const installed = path.join(HOME, ".local/share/agycodroid/agy");
let VER = "", BIN = "";
if (GIVEN) {
  BIN = path.resolve(GIVEN);
  VER = /\d+\.\d+\.\d+/.exec(spawnSync(BIN, ["--version"], { encoding: "utf8" }).stdout || "")?.[0] || "";
  if (!VER) die(`${BIN} 报不出版本号`);
  say(`\n── 直接验 ${BIN}（${VER}）`);
}
// 当前装的：网关说的为准，取不到读 current 链接；latest 拿不到就直接问官方 manifest
if (!info.current) try { info.current = path.basename(fs.readlinkSync(path.join(installed, "current"))); } catch {}
const target = WANT === "latest" ? await latestVersion() : WANT;
if (!GIVEN && target && target === info.current && fs.existsSync(path.join(installed, info.current, "agy"))) {
  VER = info.current; BIN = path.join(installed, VER, "agy");
  say(`\n── ${VER} 就是当前装的，直接用`);
} else if (!GIVEN) {
  const scratchHome = path.join(tmpBase, "home");
  fs.mkdirSync(scratchHome, { recursive: true });
  say(`\n── 下载 ${WANT}${target ? `（${target}）` : ""}，装在临时目录，不动当前的 ${info.current || "版本"}`);
  const inst = spawnSync(path.join(PREFIX, "bin/node"), [path.join(APP, "scripts/install-agy.mjs"), WANT], { env: { ...process.env, HOME: scratchHome }, stdio: ["ignore", "inherit", "inherit"] });
  const dest = path.join(scratchHome, ".local/share/agycodroid/agy");
  try { VER = path.basename(fs.readlinkSync(path.join(dest, "current"))); } catch {}
  if (inst.status !== 0 || !VER) die("下载没成功");
  BIN = path.join(dest, VER, "agy");
}
const sha = crypto.createHash("sha512").update(fs.readFileSync(BIN)).digest("hex");

// ── 2. 两步实跑 ──────────────────────────────────────────────
// agy 直接跑，不套加载器、不挂 preload
const work = path.join(tmpBase, "work");
fs.mkdirSync(work, { recursive: true });
function run(args, ms = 180000) {
  return new Promise((ok) => {
    const t0 = Date.now();
    const p = spawn(BIN, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), ms);
    p.on("close", (code, sig) => {
      clearTimeout(timer);
      ok({ code, sig, out, err, ms: Date.now() - t0 });
    });
  });
}
const events = (out) => out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const steps = {};
const tail = (s) => String(s || "").trim().split("\n").slice(-6).join("\n").slice(0, 600);

say(`\n── version`);
{
  const r = await run(["--version"], 60000);
  const pass = r.code === 0 && r.out.includes(VER);
  steps.version = { pass, ms: r.ms, ...(pass ? {} : { detail: tail(r.err || r.out) || `退出码 ${r.code} ${r.sig || ""}` }) };
  say(pass ? `✓ ${r.out.trim()}` : `✗ ${steps.version.detail}`);
}

const token = "agy-verify-" + crypto.randomBytes(4).toString("hex");
const common = ["--output-format", "stream-json", "--verbose", "--max-turns", "4", ...(MODEL ? ["--model", MODEL] : [])];
say(`\n── tools（调一次模型，让它用 Bash 写读一个文件）`);
if (steps.version.pass) {
  const prompt = `Use the Bash tool to run exactly this command: printf %s ${token} > probe.txt && cat probe.txt\nThen reply with only the command's output, nothing else.`;
  const r = await run(["-p", prompt, "--allowedTools", "Bash", ...common]);
  const evs = events(r.out), res = evs.find((e) => e.type === "result");
  const usedBash = evs.some((e) => e.type === "assistant" && (e.message?.content || []).some((c) => c.type === "tool_use" && c.name === "Bash"));
  const toolOut = evs.some((e) => e.type === "user" && JSON.stringify(e.message?.content || "").includes(token));
  const file = (() => { try { return fs.readFileSync(path.join(work, "probe.txt"), "utf8"); } catch { return ""; } })();
  const why = !res ? "没有 result 事件" : res.is_error ? "result 报错：" + String(res.result || res.subtype).slice(0, 300)
    : !usedBash ? "没有调用 Bash 工具" : !toolOut ? "工具结果里没有标记串" : file !== token ? "probe.txt 内容不对" : !String(res.result || "").includes(token) ? "最后的回复里没有标记串" : "";
  steps.tools = { pass: !why, ms: r.ms, ...(why ? { detail: why + (r.err ? "\n" + tail(r.err) : "") } : {}) };
  say(why ? `✗ ${steps.tools.detail}` : `✓ Bash 工具、文件读写、流式输出都正常（${(r.ms / 1000).toFixed(1)} 秒）`);
} else steps.tools = { pass: false, detail: "version 没过，跳过" };

// ── 3. 结果 ──────────────────────────────────────────────────
const pass = steps.version.pass && steps.tools.pass;
const result = { v: 1, version: VER, sha512: sha, at: new Date().toISOString(), device, app: info.app, devkit: info.devkit, model: MODEL || "", steps, pass };
fs.mkdirSync(OUTDIR, { recursive: true });
const outFile = path.join(OUTDIR, `agy-verify-${VER}.json`);
fs.writeFileSync(outFile, JSON.stringify(result, null, 1) + "\n");
say(`\n${pass ? "✓ 通过" : "✗ 没通过"}：${outFile}`);
if (pass) {
  // 并进本机真机验证记录：网关与 Java 自动更新直接读它（不下载、不验签）
  try {
    let d = { v: 1, updated: "", versions: {}, bad: {} };
    try { const old = JSON.parse(fs.readFileSync(VERIFIED_CACHE, "utf8")); if (old && typeof old.versions === "object") d = old; } catch {}
    d.bad ||= {};
    const rec = { at: result.at.slice(0, 10), device: [device.maker, device.model].filter(Boolean).join(" "), android: device.android, sdk: device.sdk,
      targetSdk: device.targetSdk, app: result.app, devkit: result.devkit, sha512: result.sha512 };
    const list = (d.versions[VER] || []).filter((x) => !(x.device === rec.device && x.android === rec.android && x.targetSdk === rec.targetSdk));
    if (list.some((x) => x.sha512 !== rec.sha512)) say(`  注意：${VER} 的 sha512 和本地记录里已有的不一致，没并进去，先查清楚`);
    else {
      d.versions[VER] = [...list, rec];
      d.v = 1; d.updated = new Date().toISOString();
      fs.mkdirSync(path.dirname(VERIFIED_CACHE), { recursive: true });
      fs.writeFileSync(VERIFIED_CACHE, JSON.stringify(d, null, 1) + "\n");
      say(`  已记进本机验证记录 ${VERIFIED_CACHE}`);
    }
  } catch (e) { say(`  本机验证记录没写上：${e.message}`); }
}
if (KEEP) say(`临时目录留着：${tmpBase}`);
process.exitCode = pass ? 0 : 1;
