// 终端 writeAgySettings 封口（E06，第二轮）：termNew 开终端即封 + bin/agy 每次调用都封。
// T1-T4 走真实 POST /api/term/new；测试环境的假 PREFIX 里没有 python3，
// pty helper 由本文件自备：从 terminal.mjs 的 PY_PTY 提取同一份协议代码，
// 写成可执行脚本经 AGAPP_PTYHOST 交给 ptyCommand()（只影响本文件进程内的环境变量）。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG, HERE, PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeTerminal, TERMS } from "../gw/terminal.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import { writeAgySettings, agySettingsPath } from "../gw/agy.mjs";
import { _setSealed } from "../gw/edition.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}
const base = await serve(routeTerminal);

// ── pty helper（只给本文件）：terminal.mjs 自带的 python3 pty 版协议 ──
const SHIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agycodroid-term-seal-pty-"));
const termSrc = fs.readFileSync(path.join(HERE, "gw", "terminal.mjs"), "utf8");
const pyMatch = /const PY_PTY = `([\s\S]*?)`;/ .exec(termSrc);
assert.ok(pyMatch, "terminal.mjs 里找不到 PY_PTY，pty shim 建不出来");
const shim = path.join(SHIM_DIR, "ptyhost");
fs.writeFileSync(shim, "#!/usr/bin/python3\n" + pyMatch[1], { mode: 0o755 });
const prevPtyhost = process.env.AGAPP_PTYHOST;
process.env.AGAPP_PTYHOST = shim;
after(() => {
  if (prevPtyhost === undefined) delete process.env.AGAPP_PTYHOST;
  else process.env.AGAPP_PTYHOST = prevPtyhost;
  fs.rmSync(SHIM_DIR, { recursive: true, force: true });
});

async function openTerm(body = {}) {
  const r = await fetch(base + "/api/term/new", { method: "POST", body: JSON.stringify(body) });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.ok(j.term && j.term.id, JSON.stringify(j));
  return j.term.id;
}
async function closeTerm(id) {
  try { await fetch(base + `/api/term/${id}/kill`, { method: "POST", body: "{}" }); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const t = TERMS.get(id);
    if (!t || !t.alive) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("终端 " + id + " 关不掉");
}

const AGY_FILE = agySettingsPath();
const MARKER = path.join(CFG.home, ".agyapp-safe-mode");
const SET_KEYS = ["permissionMode", "agentMode", "model", "allowedTools", "disallowedTools", "addDirs"];
const snapSettings = () => Object.fromEntries(SET_KEYS.map((k) => [k, SETTINGS[k]]));
const restoreSettings = (s) => Object.assign(SETTINGS, s);

test("T1 开终端即封口：settings.json 按界面设置重写，用户未知键保留", async () => {
  const had = fs.existsSync(AGY_FILE);
  const before = had ? fs.readFileSync(AGY_FILE, "utf8") : null;
  const prev = snapSettings();
  fs.mkdirSync(path.dirname(AGY_FILE), { recursive: true });
  fs.writeFileSync(AGY_FILE, JSON.stringify({ userKey: 1, toolPermission: "strict", model: "old-model" }, null, 2));
  Object.assign(SETTINGS, { permissionMode: "always-proceed", agentMode: "auto", model: "x-model", allowedTools: ["Bash"], disallowedTools: [], addDirs: ["/tmp/x"] });
  let id = null;
  try {
    id = await openTerm();
    const agy = JSON.parse(fs.readFileSync(AGY_FILE, "utf8"));
    assert.equal(agy.toolPermission, "always-proceed");
    assert.equal(agy.agentMode, "auto");
    assert.equal(agy.model, "x-model");
    assert.equal(agy.modelProvider, "", "默认生效接口是 google，modelProvider 写空串");
    assert.deepEqual(agy.permissions.allow, ["Bash", "write_file(/tmp/x)"]);
    assert.equal(agy.userKey, 1, "用户自己写的未知键要留着");
    const term = TERMS.get(id);
    assert.ok(term && !term.buf.includes("写 agy 设置失败"), "封口成功时首屏不应有失败提示");
  } finally {
    if (id) await closeTerm(id);
    restoreSettings(prev);
    if (had) fs.writeFileSync(AGY_FILE, before); else fs.rmSync(AGY_FILE, { force: true });
  }
});

test("T2 封口写失败也不阻塞开终端，首屏说一声", async () => {
  const had = fs.existsSync(AGY_FILE);
  const before = had ? fs.readFileSync(AGY_FILE, "utf8") : null;
  // settings.json 换成目录：读失败当空对象，rename 换上文件时失败。
  // （root 下 chmod 也拦不住写，用目录才拦得住；和 writeAgySettings 同款失败路径）
  if (had) fs.rmSync(AGY_FILE, { force: true });
  fs.mkdirSync(AGY_FILE, { recursive: true });
  let id = null;
  try {
    id = await openTerm();
    const term = TERMS.get(id);
    assert.ok(term && term.buf.includes("写 agy 设置失败"), "首屏要有失败提示，实际首屏：" + JSON.stringify(term && term.buf));
    assert.ok(fs.statSync(AGY_FILE).isDirectory(), "失败时别把用户的东西写坏");
  } finally {
    if (id) await closeTerm(id);
    fs.rmSync(AGY_FILE, { recursive: true, force: true });
    if (had) fs.writeFileSync(AGY_FILE, before);
  }
});

test("T3 开发版（sealed()==false）不封口，settings.json 原样不动", async () => {
  const orig = JSON.stringify({ userKey: 2, toolPermission: "always-proceed" }, null, 2);
  const had = fs.existsSync(AGY_FILE);
  const before = had ? fs.readFileSync(AGY_FILE, "utf8") : null;
  fs.mkdirSync(path.dirname(AGY_FILE), { recursive: true });
  fs.writeFileSync(AGY_FILE, orig);
  _setSealed(false);
  let id = null;
  try {
    id = await openTerm();
    assert.equal(fs.readFileSync(AGY_FILE, "utf8"), orig);
    const term = TERMS.get(id);
    assert.ok(term && !term.buf.includes("写 agy 设置失败"), "开发版不写，自然也不应有失败提示");
  } finally {
    if (id) await closeTerm(id);
    _setSealed(true);
    if (had) fs.writeFileSync(AGY_FILE, before); else fs.rmSync(AGY_FILE, { force: true });
  }
});

test("T4 安全模式配方与网关一致：request-review + 空权限 + 不写 model", async () => {
  const had = fs.existsSync(AGY_FILE);
  const before = had ? fs.readFileSync(AGY_FILE, "utf8") : null;
  const prev = snapSettings();
  Object.assign(SETTINGS, { permissionMode: "always-proceed", agentMode: "auto", model: "x-model", allowedTools: ["Bash"], disallowedTools: [], addDirs: [] });
  fs.mkdirSync(path.dirname(AGY_FILE), { recursive: true });
  fs.writeFileSync(AGY_FILE, JSON.stringify({ userKey: 3 }, null, 2));
  fs.writeFileSync(MARKER, String(Date.now()));
  let id = null;
  try {
    id = await openTerm();
    const agy = JSON.parse(fs.readFileSync(AGY_FILE, "utf8"));
    assert.equal(agy.toolPermission, "request-review");
    assert.equal(agy.agentMode, "");
    assert.deepEqual(agy.permissions, { allow: [], ask: [], deny: [] });
    assert.equal("model" in agy, false);
    assert.equal(agy.userKey, 3, "安全模式也只盖管理键");
  } finally {
    if (id) await closeTerm(id);
    fs.rmSync(MARKER, { force: true });
    restoreSettings(prev);
    if (had) fs.writeFileSync(AGY_FILE, before); else fs.rmSync(AGY_FILE, { force: true });
  }
});

test("T5 两层写出同一份文件：writeAgySettings 与 agy-seal.mjs deepEqual（防漂移）", async (t) => {
  const sealScript = path.join(HERE, "..", "android", "assets", "bin", "agy-seal.mjs");
  assert.ok(fs.existsSync(sealScript), "agy-seal.mjs 不在");
  const settingsFile = PATHS.settings;
  const providersFile = path.join(CFG.home, "agyapp-providers.json");
  const prev = snapSettings();
  const hadSettings = fs.existsSync(settingsFile);
  const settingsBefore = hadSettings ? fs.readFileSync(settingsFile, "utf8") : null;
  const hadProviders = fs.existsSync(providersFile);
  const providersBefore = hadProviders ? fs.readFileSync(providersFile, "utf8") : null;
  const hadAgy = fs.existsSync(AGY_FILE);
  const agyBefore = hadAgy ? fs.readFileSync(AGY_FILE, "utf8") : null;
  const hadMarker = fs.existsSync(MARKER);
  const markerBefore = hadMarker ? fs.readFileSync(MARKER, "utf8") : null;

  const runSeal = () => new Promise((resolve, reject) => {
    execFile(process.execPath, [sealScript], { env: { ...process.env, HOME: CFG.home, AGAPP_HOME: CFG.home }, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error("agy-seal.mjs 退出异常：" + err.message + " stderr=" + stderr));
      assert.equal(stdout, "", "成功时要静默，stdout=" + JSON.stringify(stdout));
      assert.equal(stderr, "", "成功时 stderr 也要静默，stderr=" + JSON.stringify(stderr));
      resolve();
    });
  });
  const seed = { userKey: 9, toolPermission: "strict", extra: { a: 1 } };
  const compare = async (label, { providerArg, diskSettings, diskProviders, safe }) => {
    fs.writeFileSync(settingsFile, JSON.stringify(diskSettings, null, 2));
    if (diskProviders === null) fs.rmSync(providersFile, { force: true });
    else fs.writeFileSync(providersFile, JSON.stringify(diskProviders, null, 2));
    if (safe) fs.writeFileSync(MARKER, "1"); else fs.rmSync(MARKER, { force: true });
    // writeAgySettings 读内存里的 SETTINGS，脚本读盘上的文件：两边喂同一份输入
    Object.assign(SETTINGS, {
      permissionMode: diskSettings.permissionMode ?? "request-review",
      agentMode: diskSettings.agentMode ?? "",
      model: diskSettings.model ?? null,
      allowedTools: diskSettings.allowedTools ?? null,
      disallowedTools: diskSettings.disallowedTools ?? null,
      addDirs: diskSettings.addDirs ?? [],
    });
    fs.mkdirSync(path.dirname(AGY_FILE), { recursive: true });
    fs.writeFileSync(AGY_FILE, JSON.stringify(seed, null, 2));
    assert.equal(writeAgySettings(providerArg, { safe: !!safe }), true, label + "：网关侧写失败");
    const fromGw = JSON.parse(fs.readFileSync(AGY_FILE, "utf8"));
    fs.writeFileSync(AGY_FILE, JSON.stringify(seed, null, 2));
    await runSeal();
    const fromSeal = JSON.parse(fs.readFileSync(AGY_FILE, "utf8"));
    assert.deepEqual(fromSeal, fromGw, label + "：两层输出不一致");
  };
  try {
    const base = { permissionMode: "always-proceed", agentMode: "auto", model: "x-model", allowedTools: ["Bash"], disallowedTools: ["Bash(rm -rf *)"], addDirs: ["/tmp/x"] };
    await compare("google 非 safe", { providerArg: undefined, diskSettings: { ...base }, diskProviders: { active: "google", providers: {} }, safe: false });
    await compare("gemini", { providerArg: { id: "gemini" }, diskSettings: { ...base, provider: "gemini" }, diskProviders: { active: "gemini", providers: {} }, safe: false });
    await compare("safe 模式", { providerArg: undefined, diskSettings: { ...base }, diskProviders: { active: "google", providers: {} }, safe: true });
    // 读坏的输入文件：两边都要当空输入、按默认值写（解析失败不抛错、不拦 agy）
    fs.writeFileSync(settingsFile, "{oops");
    fs.writeFileSync(providersFile, "nope");
    fs.rmSync(MARKER, { force: true });
    Object.assign(SETTINGS, { permissionMode: "request-review", agentMode: "", model: null, allowedTools: null, disallowedTools: null, addDirs: [] });
    fs.writeFileSync(AGY_FILE, JSON.stringify(seed, null, 2));
    assert.equal(writeAgySettings(undefined, {}), true, "读坏输入时网关侧写失败");
    const fromGw = JSON.parse(fs.readFileSync(AGY_FILE, "utf8"));
    fs.writeFileSync(AGY_FILE, JSON.stringify(seed, null, 2));
    await runSeal();
    assert.deepEqual(JSON.parse(fs.readFileSync(AGY_FILE, "utf8")), fromGw, "读坏输入时两层输出不一致");
  } finally {
    restoreSettings(prev);
    fs.rmSync(MARKER, { force: true });
    if (hadMarker) fs.writeFileSync(MARKER, markerBefore);
    if (hadSettings) fs.writeFileSync(settingsFile, settingsBefore); else fs.rmSync(settingsFile, { force: true });
    if (hadProviders) fs.writeFileSync(providersFile, providersBefore); else fs.rmSync(providersFile, { force: true });
    if (hadAgy) fs.writeFileSync(AGY_FILE, agyBefore); else fs.rmSync(AGY_FILE, { force: true });
  }
});

test("T6 bin/agy 包装实跑：每次调用都封口，node 缺失时照常 exec", async (t) => {
  const root = path.join(HERE, "..");
  const wrapper = fs.readFileSync(path.join(root, "android", "assets", "bin", "agy"), "utf8");
  assert.match(wrapper, /agy-seal\.mjs/, "包装没有调封口脚本");
  assert.match(wrapper, /AGAPP_BIN/, "SEAL_DIR 没有优先用 AGAPP_BIN");
  assert.doesNotMatch(wrapper, /eval/, "包装不许 eval 拼 argv");
  assert.equal((wrapper.match(/exit 2/g) || []).length, 1, "封口分支不许新增 exit 2（只有没装 agy 的那一处）");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agycodroid-term-seal-t6-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(root, "android", "assets", "bin", "agy"), path.join(binDir, "agy"));
  fs.copyFileSync(path.join(root, "android", "assets", "bin", "agy-seal.mjs"), path.join(binDir, "agy-seal.mjs"));
  const fakeAgyDir = path.join(tmp, ".local", "share", "agycodroid", "agy", "current");
  fs.mkdirSync(fakeAgyDir, { recursive: true });
  fs.writeFileSync(path.join(fakeAgyDir, "agy"), "#!/bin/sh\necho \"FAKE-AGY:$*\"\n", { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, "agyapp-settings.json"), JSON.stringify({ permissionMode: "always-proceed", agentMode: "auto", model: "m1", allowedTools: ["Bash"] }, null, 2));
  const run = (env) => new Promise((resolve, reject) => {
    execFile("/bin/sh", [path.join(binDir, "agy"), "--version"], { env, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error("bin/agy 退出异常：" + err.message + " stdout=" + stdout + " stderr=" + stderr));
      resolve({ stdout, stderr });
    });
  });
  const withNode = path.join(tmp, "with-node");
  fs.mkdirSync(withNode, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(withNode, "node"));
  fs.symlinkSync("/usr/bin/dirname", path.join(withNode, "dirname"));
  // 有 node：封口写盘 + 假 agy 被 exec 到
  const r1 = await run({ HOME: tmp, AGAPP_BIN: binDir, PREFIX: "", PATH: withNode + ":/usr/bin:/bin" });
  assert.match(r1.stdout, /FAKE-AGY:--version/);
  assert.equal(r1.stderr, "", "封口成功时包装不应有多余输出，stderr=" + JSON.stringify(r1.stderr));
  const sealed1 = JSON.parse(fs.readFileSync(path.join(tmp, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
  assert.equal(sealed1.toolPermission, "always-proceed");
  assert.equal(sealed1.agentMode, "auto");
  assert.equal(sealed1.model, "m1");
  // 没 node：封口跳过，假 agy 照常跑（fail-open）
  fs.rmSync(path.join(tmp, ".gemini"), { recursive: true, force: true });
  const noNode = path.join(tmp, "no-node");
  fs.mkdirSync(noNode, { recursive: true });
  fs.symlinkSync("/usr/bin/dirname", path.join(noNode, "dirname"));
  const r2 = await run({ HOME: tmp, AGAPP_BIN: binDir, PREFIX: "", PATH: noNode });
  assert.match(r2.stdout, /FAKE-AGY:--version/);
  assert.equal(fs.existsSync(path.join(tmp, ".gemini", "antigravity-cli", "settings.json")), false, "没 node 时不应写出 settings（也没拦住 exec）");
});
